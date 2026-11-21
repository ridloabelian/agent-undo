import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentUndoEngine,
  McpFirewallRouter,
  McpStdioServer,
  PolicyEngine,
  UndoDatabase,
  UpstreamStdioMcpClient,
  createBuiltinAdapters,
  createInspectorApp,
  parsePolicy,
} from '../src/index.js';

describe('MCP Proxy (Stdio & HTTP Modes)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proxies a real child stdio MCP server with allow, grace-undo, wait-execution, and deny', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-undo-mcp-'));
    tempDirs.push(dir);

    const upstreamLogFile = path.join(dir, 'upstream-calls.log');
    const upstreamScript = path.join(dir, 'mock-mcp-server.mjs');

    fs.writeFileSync(
      upstreamScript,
      `
import fs from 'node:fs';
import readline from 'node:readline';

const logFile = ${JSON.stringify(upstreamLogFile)};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const req = JSON.parse(trimmed);
  if (req.method === 'notifications/initialized') return;

  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-upstream', version: '1.0.0' },
      },
    }) + '\\n');
    return;
  }

  if (req.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          {
            name: 'crm.get_contact',
            description: 'Read CRM contact',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          },
          {
            name: 'crm.update_contact',
            description: 'Mutate CRM contact',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } } },
          },
          {
            name: 'crm.drop_database',
            description: 'Dangerous operation',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    }) + '\\n');
    return;
  }

  if (req.method === 'tools/call') {
    const { name, arguments: args } = req.params;
    fs.appendFileSync(logFile, JSON.stringify({ name, args }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { ok: true, tool: name, args },
    }) + '\\n');
  }
});
`,
      'utf8',
    );

    const db = new UndoDatabase(path.join(dir, 'mcp.db'));
    const policy = new PolicyEngine(
      parsePolicy(`
version: "0.1"
defaultDecision: grace_window
defaultGraceSeconds: 0.1
rules:
  - id: allow-read
    match:
      tool: "*.get_*"
    decision: allow
    readOnly: true
  - id: deny-drop
    match:
      tool: "crm.drop_database"
    decision: deny
`),
    );

    const engine = new AgentUndoEngine({ db, policy, schedulerPollMs: 30 });
    const upstream = new UpstreamStdioMcpClient('node', [upstreamScript]);
    const router = new McpFirewallRouter({
      engine,
      upstream,
      graceResponseMode: 'receipt',
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const stdioServer = new McpStdioServer({ router, input, output });
    stdioServer.start();

    const responses: Array<{ id: number; result?: unknown; error?: unknown }> =
      [];
    let buffer = '';
    output.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          responses.push(
            JSON.parse(line) as { id: number; result?: unknown; error?: unknown },
          );
        }
      }
    });

    const sendRpc = async (
      id: number | null,
      method: string,
      params?: Record<string, unknown>,
    ) => {
      const payload =
        id === null
          ? { jsonrpc: '2.0', method, params }
          : { jsonrpc: '2.0', id, method, params };
      input.write(`${JSON.stringify(payload)}\n`);
      if (id === null) return null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const found = responses.find((r) => r.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`Timed out waiting for MCP response id=${id}`);
    };

    try {
      const initRes = await sendRpc(1, 'initialize', {
        protocolVersion: '2024-11-05',
      });
      expect(
        (initRes?.result as { serverInfo: { name: string } }).serverInfo.name,
      ).toBe('agent-undo');

      await sendRpc(null, 'notifications/initialized', {});

      const listRes = await sendRpc(2, 'tools/list', {});
      const toolNames = (
        listRes?.result as { tools: Array<{ name: string }> }
      ).tools.map((t) => t.name);
      expect(toolNames).toContain('crm.get_contact');
      expect(toolNames).toContain('crm.update_contact');
      expect(toolNames).toContain('agent_undo_undo');
      expect(toolNames).toContain('agent_undo_status');

      // 1) Read-only pass-through executes upstream immediately
      const getRes = await sendRpc(3, 'tools/call', {
        name: 'crm.get_contact',
        arguments: { id: 'c_1' },
      });
      const getText = (
        getRes?.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(JSON.parse(getText).status).toBe('executed');

      // 2) Denied tool never reaches upstream
      const denyRes = await sendRpc(4, 'tools/call', {
        name: 'crm.drop_database',
        arguments: {},
      });
      expect((denyRes?.result as { isError: boolean }).isError).toBe(true);

      // 3) Grace-window call stages and gets canceled by agent_undo_undo
      const stageRes = await sendRpc(5, 'tools/call', {
        name: 'crm.update_contact',
        arguments: { id: 'c_1', note: 'Should be canceled' },
      });
      const stagedPayload = JSON.parse(
        (stageRes?.result as { content: Array<{ text: string }> }).content[0]!
          .text,
      ) as { actionId: string; status: string };
      expect(stagedPayload.status).toBe('grace_pending');

      const undoRes = await sendRpc(6, 'tools/call', {
        name: 'agent_undo_undo',
        arguments: { actionId: stagedPayload.actionId },
      });
      const undoPayload = JSON.parse(
        (undoRes?.result as { content: Array<{ text: string }> }).content[0]!
          .text,
      ) as { status: string };
      expect(undoPayload.status).toBe('undone');

      // Wait longer than graceSeconds to prove canceled call never fires upstream
      await new Promise((r) => setTimeout(r, 180));
      const logLines = fs
        .readFileSync(upstreamLogFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { name: string });
      expect(logLines.map((l) => l.name)).toEqual(['crm.get_contact']);

      // 4) `wait` mode waits for grace expiry and executes upstream
      const waitRouter = new McpFirewallRouter({
        engine,
        upstream,
        graceResponseMode: 'wait',
      });
      const waitRes = await waitRouter.handleMessage({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'crm.update_contact',
          arguments: { id: 'c_2', note: 'Committed after grace' },
        },
      });
      const waitPayload = JSON.parse(
        (waitRes?.result as { content: Array<{ text: string }> }).content[0]!
          .text,
      ) as { status: string };
      expect(waitPayload.status).toBe('executed');

      const finalLogs = fs
        .readFileSync(upstreamLogFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { name: string });
      expect(finalLogs.map((l) => l.name)).toEqual([
        'crm.get_contact',
        'crm.update_contact',
      ]);
    } finally {
      stdioServer.stop();
      engine.stop();
      await upstream.close();
      db.close();
    }
  });

  it('serves JSON-RPC over HTTP /mcp with per-session budget isolation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-undo-http-mcp-'));
    tempDirs.push(dir);

    const db = new UndoDatabase(path.join(dir, 'http-mcp.db'));
    const policy = new PolicyEngine(
      parsePolicy(`
version: "0.1"
defaultDecision: grace_window
defaultGraceSeconds: 30
budgets:
  session:
    maxSpendUsd: 30
  daily:
    maxSpendUsd: 50
rules:
  - id: charge
    match:
      tool: "stripe.create_charge"
    decision: grace_window
    spendExtractor:
      arg: amountCents
      scale: 0.01
`),
    );

    const { tools, sandboxDir } = createBuiltinAdapters(
      db,
      path.join(dir, 'sandbox'),
    );
    const engine = new AgentUndoEngine({
      db,
      policy,
      autoStartScheduler: false,
    });
    engine.registerTools(tools);
    const app = createInspectorApp({ engine, sandboxDir });

    try {
      // Session A stages $25
      const resA = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'session-a',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'stripe.create_charge',
            arguments: {
              customerId: 'cus_a',
              amountCents: 2500,
              description: 'A',
            },
          },
        }),
      });
      expect(resA.status).toBe(200);
      const bodyA = (await resA.json()) as {
        result: { content: Array<{ text: string }>; isError: boolean };
      };
      expect(bodyA.result.isError).toBe(false);
      expect(JSON.parse(bodyA.result.content[0]!.text).status).toBe(
        'grace_pending',
      );

      // Session B stages $25 (allowed under separate session cap, total daily $50)
      const resB = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'session-b',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'stripe.create_charge',
            arguments: {
              customerId: 'cus_b',
              amountCents: 2500,
              description: 'B',
            },
          },
        }),
      });
      const bodyB = (await resB.json()) as {
        result: { isError: boolean };
      };
      expect(bodyB.result.isError).toBe(false);

      // Session C trying $10 hits daily $50 cap
      const resC = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'session-c',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'stripe.create_charge',
            arguments: {
              customerId: 'cus_c',
              amountCents: 1000,
              description: 'C',
            },
          },
        }),
      });
      const bodyC = (await resC.json()) as {
        result: { content: Array<{ text: string }>; isError: boolean };
      };
      expect(bodyC.result.isError).toBe(true);
      expect(JSON.parse(bodyC.result.content[0]!.text).denyCode).toBe(
        'DAILY_SPEND_CAP_EXCEEDED',
      );
    } finally {
      engine.stop();
      db.close();
    }
  });
});

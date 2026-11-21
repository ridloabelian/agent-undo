import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import {
  createBuiltinAdapters,
  seedDemoState,
} from '../adapters/index.js';
import { AgentUndoEngine } from '../core/firewall.js';
import { McpFirewallRouter } from '../mcp/router.js';
import { McpStdioServer, UpstreamStdioMcpClient } from '../mcp/stdio.js';
import { PolicyEngine } from '../policy/engine.js';
import {
  DEFAULT_POLICY_CONFIG,
  loadPolicyFromFile,
} from '../policy/schema.js';
import { createInspectorApp } from '../server/app.js';
import { UndoDatabase } from '../storage/database.js';

const VERSION = '0.1.0';

function printHelp(): void {
  console.log(`agent-undo v${VERSION} — Transactional firewall & undo layer for AI agents

Usage:
  agent-undo <command> [options]

Commands:
  start                    Start the local Web Inspector UI, REST API, HTTP MCP endpoint, and grace scheduler
  queue                    Show staged grace-window and approval-pending actions
  undo <action-id>         Soft-cancel a pending action or run compensating rollback on an executed action
  approve <action-id>      Approve and immediately execute a pending_approval action
  audit                    Inspect and verify the immutable SHA-256 audit log
  mcp [-- <cmd> <args>]    Run as an MCP stdio proxy server (wrapping an optional upstream MCP stdio server)

Options:
  --port <number>          Inspector HTTP port (default: 4310)
  --host <address>         Inspector bind host (default: 127.0.0.1)
  --db <path>              SQLite database path (default: .agent-undo/state.db)
  --sandbox <dir>          Sandbox directory for filesystem adapter (default: .agent-undo/sandbox)
  --policy <path>          Policy YAML/JSON file (default: ./policy.yaml if present)
  --session <id>           Session ID filter for queue/status (default: default)
  --limit <number>         Max rows to display (default: 50)
  --actor <name>           Actor name recorded in audit log (default: cli)
  --server-url <url>       Forward undo/approve to a running agent-undo HTTP server
  --grace-mode <mode>      MCP grace response mode: receipt | wait (default: receipt)
  --all                    Include historical actions in queue output
  --verify                 Verify SHA-256 audit chain integrity
  --no-seed                Skip seeding demo mock data on start
  --json                   Emit machine-readable JSON output
  -h, --help               Show this help text
  -v, --version            Show version
`);
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  passthrough: string[];
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const ddIdx = argv.indexOf('--');
  const mainArgs = ddIdx === -1 ? argv : argv.slice(0, ddIdx);
  const passthrough = ddIdx === -1 ? [] : argv.slice(ddIdx + 1);

  const flags: Record<string, string | boolean> = {};
  const tokens: string[] = [];

  for (let i = 0; i < mainArgs.length; i += 1) {
    const arg = mainArgs[i]!;
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg === '-v' || arg === '--version') {
      flags.version = true;
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const booleanFlags = new Set([
          'all',
          'verify',
          'json',
          'no-seed',
          'help',
          'version',
        ]);
        if (booleanFlags.has(key)) {
          flags[key] = true;
        } else {
          const next = mainArgs[i + 1];
          if (next !== undefined && !next.startsWith('--')) {
            flags[key] = next;
            i += 1;
          } else {
            flags[key] = true;
          }
        }
      }
    } else {
      tokens.push(arg);
    }
  }

  const [command = 'help', ...positionals] = tokens;
  return { command, positionals, flags, passthrough };
}

function resolvePolicyConfig(flagValue: string | boolean | undefined) {
  if (typeof flagValue === 'string') {
    return loadPolicyFromFile(flagValue);
  }
  const defaultPath = path.resolve('policy.yaml');
  if (fs.existsSync(defaultPath)) {
    return loadPolicyFromFile(defaultPath);
  }
  return DEFAULT_POLICY_CONFIG;
}

function openEngine(options: {
  dbPath: string;
  sandboxDir: string;
  policyFlag: string | boolean | undefined;
  autoStartScheduler: boolean;
}) {
  const db = new UndoDatabase(options.dbPath);
  const policy = new PolicyEngine(resolvePolicyConfig(options.policyFlag));
  const { tools, sandboxDir } = createBuiltinAdapters(db, options.sandboxDir);
  const engine = new AgentUndoEngine({
    db,
    policy,
    autoStartScheduler: options.autoStartScheduler,
  });
  engine.registerTools(tools);
  return { db, policy, engine, sandboxDir };
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);

  if (parsed.flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (parsed.flags.help || parsed.command === 'help') {
    printHelp();
    return 0;
  }

  const dbPath =
    typeof parsed.flags.db === 'string'
      ? parsed.flags.db
      : '.agent-undo/state.db';
  const sandboxDir =
    typeof parsed.flags.sandbox === 'string'
      ? parsed.flags.sandbox
      : '.agent-undo/sandbox';
  const asJson = Boolean(parsed.flags.json);
  const actor =
    typeof parsed.flags.actor === 'string' ? parsed.flags.actor : 'cli';

  switch (parsed.command) {
    case 'start': {
      const port = Number(parsed.flags.port ?? 4310);
      const host =
        typeof parsed.flags.host === 'string'
          ? parsed.flags.host
          : '127.0.0.1';
      const { db, engine, sandboxDir: resolvedSandbox } = openEngine({
        dbPath,
        sandboxDir,
        policyFlag: parsed.flags.policy,
        autoStartScheduler: true,
      });

      if (!parsed.flags['no-seed']) {
        seedDemoState(db, resolvedSandbox);
      }

      const mcpRouter = new McpFirewallRouter({ engine });
      const app = createInspectorApp({
        engine,
        sandboxDir: resolvedSandbox,
        mcpRouter,
      });

      const server = serve({
        fetch: app.fetch,
        port,
        hostname: host,
      });

      console.log(`agent-undo v${VERSION} running:`);
      console.log(`  Web Inspector & API : http://${host}:${port}`);
      console.log(`  MCP HTTP Endpoint   : http://${host}:${port}/mcp`);
      console.log(`  SQLite Database     : ${path.resolve(dbPath)}`);
      console.log(`  Sandbox Directory   : ${resolvedSandbox}`);

      await new Promise<void>((resolve) => {
        const shutdown = () => {
          engine.stop();
          server.close(() => {
            db.close();
            resolve();
          });
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });
      return 0;
    }

    case 'queue': {
      const { db, policy } = openEngine({
        dbPath,
        sandboxDir,
        policyFlag: parsed.flags.policy,
        autoStartScheduler: false,
      });
      try {
        const limit = Number(parsed.flags.limit ?? 50);
        const sessionId =
          typeof parsed.flags.session === 'string'
            ? parsed.flags.session
            : 'default';
        const actions = db.listActions({
          status: parsed.flags.all
            ? undefined
            : ['grace_pending', 'pending_approval', 'approved'],
          limit,
        });
        const budget = db.getBudgetMeter(sessionId, policy.getBudgetLimits());

        if (asJson) {
          console.log(JSON.stringify({ actions, budget }, null, 2));
          return 0;
        }

        console.log(
          `Session "${budget.sessionId}" Spend: $${budget.sessionSpendUsd.toFixed(2)} / ${budget.sessionMaxSpendUsd !== null ? `$${budget.sessionMaxSpendUsd.toFixed(2)}` : 'unlimited'} | Mutations: ${budget.sessionMutations} / ${budget.sessionMaxMutations ?? 'unlimited'}`,
        );
        if (actions.length === 0) {
          console.log('Queue is empty.');
          return 0;
        }
        for (const action of actions) {
          const remaining =
            action.status === 'grace_pending' && action.executeAtMs !== null
              ? ` (${Math.max(0, (action.executeAtMs - Date.now()) / 1000).toFixed(1)}s remaining)`
              : '';
          console.log(
            `- ${action.id}  [${action.status}]${remaining}  ${action.toolName}  $${action.spendUsd.toFixed(2)}  ${action.diffSummary}`,
          );
        }
        return 0;
      } finally {
        db.close();
      }
    }

    case 'undo': {
      const actionId = parsed.positionals[0];
      if (!actionId) {
        console.error('Usage: agent-undo undo <action-id>');
        return 1;
      }

      if (typeof parsed.flags['server-url'] === 'string') {
        const res = await fetch(
          `${parsed.flags['server-url'].replace(/\/$/, '')}/api/actions/${encodeURIComponent(actionId)}/undo`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actor }),
          },
        );
        const data = await res.json();
        if (asJson) {
          console.log(JSON.stringify(data, null, 2));
        } else if (!res.ok) {
          console.error(`Undo failed: ${(data as { error?: string }).error}`);
        } else {
          console.log(
            `Undid ${actionId} (${(data as { mode: string }).mode})`,
          );
        }
        return res.ok ? 0 : 1;
      }

      const { db, engine } = openEngine({
        dbPath,
        sandboxDir,
        policyFlag: parsed.flags.policy,
        autoStartScheduler: false,
      });
      try {
        const result = await engine.undo(actionId, actor);
        if (asJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `Undid ${result.action.id} (${result.action.toolName}) via ${result.mode} -> status=${result.action.status}`,
          );
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Undo failed: ${message}`);
        return 1;
      } finally {
        db.close();
      }
    }

    case 'approve': {
      const actionId = parsed.positionals[0];
      if (!actionId) {
        console.error('Usage: agent-undo approve <action-id>');
        return 1;
      }

      if (typeof parsed.flags['server-url'] === 'string') {
        const res = await fetch(
          `${parsed.flags['server-url'].replace(/\/$/, '')}/api/actions/${encodeURIComponent(actionId)}/approve`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actor }),
          },
        );
        const data = await res.json();
        if (asJson) {
          console.log(JSON.stringify(data, null, 2));
        } else if (!res.ok) {
          console.error(
            `Approve failed: ${(data as { error?: string }).error}`,
          );
        } else {
          console.log(`Approved and executed ${actionId}`);
        }
        return res.ok ? 0 : 1;
      }

      const { db, engine } = openEngine({
        dbPath,
        sandboxDir,
        policyFlag: parsed.flags.policy,
        autoStartScheduler: false,
      });
      try {
        const action = await engine.approve(actionId, actor);
        if (asJson) {
          console.log(JSON.stringify({ action }, null, 2));
        } else {
          console.log(
            `Approved ${action.id} (${action.toolName}) -> status=${action.status}`,
          );
        }
        return action.status === 'executed' ? 0 : 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Approve failed: ${message}`);
        return 1;
      } finally {
        db.close();
      }
    }

    case 'audit': {
      const db = new UndoDatabase(dbPath);
      try {
        const limit = Number(parsed.flags.limit ?? 50);
        const entries = db.listAuditLogs(limit);
        const verification = db.verifyAuditChain();

        if (asJson) {
          console.log(JSON.stringify({ entries, verification }, null, 2));
          return verification.valid ? 0 : 1;
        }

        if (parsed.flags.verify || !verification.valid) {
          console.log(
            verification.valid
              ? `Audit chain OK (${verification.totalEntries} verified entries)`
              : `Audit chain INVALID at seq ${verification.brokenAtSeq}: ${verification.reason}`,
          );
        }

        if (entries.length === 0) {
          console.log('No audit entries recorded.');
        } else {
          for (const entry of entries) {
            console.log(
              `#${entry.seq}  ${entry.timestamp}  [${entry.eventType}]  actor=${entry.actor}  ${entry.summary}  (${entry.entryHash.slice(0, 12)})`,
            );
          }
        }
        return verification.valid ? 0 : 1;
      } finally {
        db.close();
      }
    }

    case 'mcp': {
      const { db, engine, sandboxDir: resolvedSandbox } = openEngine({
        dbPath,
        sandboxDir,
        policyFlag: parsed.flags.policy,
        autoStartScheduler: true,
      });

      if (!parsed.flags['no-seed']) {
        seedDemoState(db, resolvedSandbox);
      }

      let upstream: UpstreamStdioMcpClient | undefined;
      if (parsed.passthrough.length > 0) {
        const [cmd, ...cmdArgs] = parsed.passthrough;
        upstream = new UpstreamStdioMcpClient(cmd!, cmdArgs);
      }

      const graceMode =
        parsed.flags['grace-mode'] === 'wait' ? 'wait' : 'receipt';
      const router = new McpFirewallRouter({
        engine,
        upstream,
        graceResponseMode: graceMode,
      });
      const stdioServer = new McpStdioServer({ router });
      stdioServer.start();
      console.error(
        `agent-undo MCP stdio proxy listening (grace-mode=${graceMode})`,
      );

      await new Promise<void>((resolve) => {
        const shutdown = async () => {
          stdioServer.stop();
          engine.stop();
          await upstream?.close();
          db.close();
          resolve();
        };
        process.once('SIGINT', () => void shutdown());
        process.once('SIGTERM', () => void shutdown());
        process.stdin.once('end', () => void shutdown());
      });
      return 0;
    }

    default:
      console.error(`Unknown command: "${parsed.command}"\n`);
      printHelp();
      return 1;
  }
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (isDirectEntry) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  JsonRpcResponse,
  McpFirewallRouter,
  McpToolInfo,
  UpstreamMcpClient,
} from './router.js';

export interface McpStdioServerOptions {
  router: McpFirewallRouter;
  input?: Readable;
  output?: Writable;
  sessionId?: string;
}

/**
 * Line-delimited JSON-RPC 2.0 MCP server over stdio streams.
 */
export class McpStdioServer {
  private readonly router: McpFirewallRouter;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly sessionId: string;
  private rl: readline.Interface | null = null;

  constructor(options: McpStdioServerOptions) {
    this.router = options.router;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.sessionId = options.sessionId ?? 'mcp-stdio';
  }

  start(): void {
    if (this.rl) return;
    this.rl = readline.createInterface({
      input: this.input,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      void this.processLine(trimmed);
    });
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private async processLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const err: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON.' },
      };
      this.output.write(`${JSON.stringify(err)}\n`);
      return;
    }

    const response = await this.router.handleMessage(parsed, {
      sessionId: this.sessionId,
      agentId: 'mcp-stdio-client',
    });
    if (response !== null) {
      this.output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

/**
 * Spawns and communicates with an upstream stdio MCP server process.
 */
export class UpstreamStdioMcpClient implements UpstreamMcpClient {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly rl: readline.Interface;
  private nextId = 1;
  private initialized = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
    }
  >();

  constructor(command: string, args: string[] = [], env?: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: env ?? process.env,
    });

    this.rl = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as {
          id?: number;
          result?: unknown;
          error?: { message?: string; code?: number };
        };
        if (typeof msg.id === 'number') {
          const waiter = this.pending.get(msg.id);
          if (waiter) {
            this.pending.delete(msg.id);
            if (msg.error) {
              waiter.reject(
                new Error(msg.error.message ?? 'Upstream MCP error'),
              );
            } else {
              waiter.resolve(msg.result);
            }
          }
        }
      } catch {
        // Ignore malformed upstream lines
      }
    });

    this.child.on('exit', (code) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(
          new Error(`Upstream MCP process exited with code ${code ?? 'null'}`),
        );
      }
      this.pending.clear();
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-undo-proxy', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
    );
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.ensureInitialized();
    const res = (await this.request('tools/list', {})) as {
      tools?: McpToolInfo[];
    };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return await this.request('tools/call', {
      name,
      arguments: args,
    });
  }

  async close(): Promise<void> {
    this.rl.close();
    if (!this.child.killed) {
      this.child.kill('SIGTERM');
    }
  }
}

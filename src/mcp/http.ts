import type { Context } from 'hono';
import type {
  McpFirewallRouter,
  McpToolInfo,
  UpstreamMcpClient,
} from './router.js';

/**
 * Upstream MCP client speaking JSON-RPC 2.0 over HTTP POST.
 */
export class UpstreamHttpMcpClient implements UpstreamMcpClient {
  private readonly endpointUrl: string;
  private nextId = 1;
  private initialized = false;

  constructor(endpointUrl: string) {
    this.endpointUrl = endpointUrl;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-undo-http-proxy', version: '0.1.0' },
    });
    this.initialized = true;
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.endpointUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }),
    });

    if (!res.ok) {
      throw new Error(
        `Upstream HTTP MCP responded with status ${res.status}`,
      );
    }

    const payload = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (payload.error) {
      throw new Error(payload.error.message ?? 'Upstream HTTP MCP error');
    }
    return payload.result;
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.ensureInitialized();
    const res = (await this.rpc('tools/list', {})) as {
      tools?: McpToolInfo[];
    };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    return await this.rpc('tools/call', {
      name,
      arguments: args,
    });
  }
}

/**
 * Handles an incoming HTTP MCP JSON-RPC POST request inside Hono.
 */
export async function handleMcpHttpRequest(
  c: Context,
  router: McpFirewallRouter,
): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON body.' },
      },
      400,
    );
  }

  const sessionId =
    c.req.header('mcp-session-id') ??
    c.req.header('x-session-id') ??
    'mcp-http';

  const response = await router.handleMessage(body, {
    sessionId,
    agentId: 'mcp-http-client',
  });

  if (response === null) {
    return c.body(null, 202);
  }

  return c.json(response, 200);
}

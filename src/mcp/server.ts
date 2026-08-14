// A5 · the MCP server transport — a minimal Streamable-HTTP JSON-RPC handler on
// the existing Bun.serve gateway (POST /mcp). The official SDK's server
// transport targets Node's `http` while the gateway is Bun.serve Web-Fetch, so
// the spec sanctions a hand-rolled handler that is WIRE-COMPATIBLE with the SDK
// client (`StreamableHTTPClientTransport`):
//
//   • POST  — a single JSON-RPC message (or batch); requests get an
//             `application/json` JSON-RPC response, notifications get 202.
//   • GET    — 405 (no server-initiated SSE stream; the client treats 405 as
//             "no stream" and proceeds).
//   • DELETE — 204 (stateless: nothing to tear down).
//
// Stateless: no Mcp-Session-Id is issued, so the client operates without one.
// Auth is the org Ed25519 capability token, enforced by the gateway BEFORE this
// handler runs (a missing/invalid token never reaches here — it gets a 401).

import { sanitizeDbError } from "../host/postgres/sanitize";
import { isGrantEnforcing } from "../gateway/capability-token";
import { checkScopeGrant, MCP_TOOLS, type McpToolContext } from "./tools";

const PROTOCOL_FALLBACK = "2025-06-18";

// M-9b · maximum messages in one JSON-RPC batch (DoS ceiling).
const MAX_BATCH_SIZE = 50;

export interface McpServeDeps extends McpToolContext {
  version: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function result(id: JsonRpcMessage["id"], value: unknown): object {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function rpcError(id: JsonRpcMessage["id"], code: number, message: string): object {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Dispatch one JSON-RPC message. Returns the response object, or null for a
 *  notification (no response). */
async function dispatch(msg: JsonRpcMessage, deps: McpServeDeps): Promise<object | null> {
  const { method, id } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const params = (msg.params ?? {}) as { protocolVersion?: string };
      // Echo the client's requested protocol version so its support check passes.
      const protocolVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_FALLBACK;
      return result(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hx-fortress", version: deps.version },
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: unknown };
      const tool = MCP_TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
      // A5 · H-4 · a read grant (when present) must commit to exactly this call's
      // scope; under FORTRESS_GRANT_ENFORCE a call with no grant is denied.
      const gate = checkScopeGrant(params.arguments ?? {}, deps.grant, isGrantEnforcing());
      if (gate) return result(id, gate);
      try {
        const out = await tool.handle(params.arguments ?? {}, {
          db: deps.db,
          store: deps.store,
          embedder: deps.embedder ?? null,
          grant: deps.grant,
        });
        return result(id, out);
      } catch (e) {
        // Tool execution faults surface as an isError tool result (not a
        // protocol error) so the agent can read the reason and adapt. The detail
        // crosses to the agent, so redact any DSN a DB error might have echoed.
        const message = sanitizeDbError(e);
        return result(id, {
          content: [{ type: "text", text: JSON.stringify({ error: "tool_failed", detail: message }) }],
          isError: true,
        });
      }
    }
    default:
      // Unknown notifications (e.g. notifications/initialized, .../cancelled) are
      // acked with no body; unknown requests get a JSON-RPC method-not-found.
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${String(method)}`);
  }
}

/** Handle one /mcp HTTP request. The caller has already verified the capability
 *  token (401 otherwise). */
export async function handleMcpRequest(req: Request, deps: McpServeDeps): Promise<Response> {
  if (req.method === "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });
  }
  if (req.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 200);
  }

  const batch = Array.isArray(body);
  // M-9b · bound a JSON-RPC batch so a single request can't fan out unboundedly.
  if (batch && (body as unknown[]).length > MAX_BATCH_SIZE) {
    return jsonResponse(rpcError(null, -32600, "batch too large"), 200);
  }
  const messages = (batch ? body : [body]) as JsonRpcMessage[];
  const responses: object[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const res = await dispatch(m, deps);
    if (res) responses.push(res);
  }

  // Only notifications/responses in the POST → 202 ack (no JSON-RPC body).
  if (responses.length === 0) return new Response(null, { status: 202 });

  return jsonResponse(batch ? responses : responses[0]);
}

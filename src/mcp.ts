import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { BridgeState } from "./types";

interface StartMcpServerOptions {
  host: string;
  port: number;
  state: BridgeState;
  proxySecret: string | null;
  onSendDiscordMessage: (content: string, meta?: { channelId?: string; bridgeRequestId?: string; }) => Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

const TOOL_NAME = "sendDiscordMessage";
const TOOL_DESCRIPTION = "Send a message into a Discord channel.";
const MAX_BODY_BYTES = 128_000;
const EDGE_SECRET_HEADER = "x-poke-edge-secret";
const CORS_HEADERS = "Content-Type, Mcp-Session-Id, X-Poke-Edge-Secret";

function writeJson(res: ServerResponse, statusCode: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": CORS_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...headers
  });
  res.end(JSON.stringify(value));
}

function writeError(res: ServerResponse, id: string | number | null, code: number, message: string, headers: Record<string, string> = {}): void {
  writeJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } }, headers);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function getMessageEndpoint(host: string, port: number, sessionId: string): string {
  return `http://${host}:${port}/messages/?session_id=${sessionId}`;
}

function splitDiscordContent(content: string): string[] {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 2000) {
    const breakPoint = remaining.lastIndexOf("\n", 2000);
    const splitAt = breakPoint > 0 ? breakPoint : 2000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  if (remaining.length) chunks.push(remaining);
  return chunks;
}

async function handleToolCall(args: Record<string, unknown>, onSendDiscordMessage: StartMcpServerOptions["onSendDiscordMessage"]): Promise<unknown> {
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) {
    throw new Error("content is required");
  }

  const channelId = typeof args.channelId === "string" && args.channelId.trim().length ? args.channelId.trim() : undefined;
  const bridgeRequestId = typeof args.bridgeRequestId === "string" && args.bridgeRequestId.trim().length ? args.bridgeRequestId.trim() : undefined;
  const chunks = splitDiscordContent(content);

  for (const chunk of chunks) {
    await onSendDiscordMessage(chunk, { channelId, bridgeRequestId });
  }

  return {
    sent: true,
    chunks: chunks.length
  };
}

async function handleRequest(request: JsonRpcRequest, options: StartMcpServerOptions): Promise<JsonRpcResponse> {
  if (request.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32600, message: "Must use JSON-RPC 2.0" } };
  }

  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "poke-discord-bridge",
          version: "0.0.0"
        }
      }
    };
  }

  if (request.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        tools: [
          {
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                content: {
                  type: "string",
                  description: "The Discord message to send."
                },
                channelId: {
                  type: "string",
                  description: "Optional Discord channel id to send to."
                },
                bridgeRequestId: {
                  type: "string",
                  description: "Optional bridge request id if the channel id is not provided."
                }
              },
              required: ["content"]
            }
          }
        ]
      }
    };
  }

  if (request.method === "tools/call") {
    const name = typeof request.params?.name === "string" ? request.params.name : "";
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

    if (name !== TOOL_NAME) {
      return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }

    try {
      const result = await handleToolCall(args, options.onSendDiscordMessage);
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false
        }
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: true, message: error instanceof Error ? error.message : String(error) }) }],
          isError: true
        }
      };
    }
  }

  if (request.method === "notifications/initialized") {
    return { jsonrpc: "2.0", id: request.id ?? null, result: null };
  }

  return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: `Unknown method: ${request.method}` } };
}

function readHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function isAuthorized(req: IncomingMessage, secret: string | null): boolean {
  if (!secret) return true;
  return readHeaderValue(req.headers[EDGE_SECRET_HEADER]) === secret;
}

function writeUnauthorized(res: ServerResponse): void {
  writeJson(res, 401, { error: true, message: "Missing edge secret." });
}

export async function startMcpServer(options: StartMcpServerOptions): Promise<{ server: Server; port: number; }> {
  let listeningPort = options.port;
  const origin = `http://${options.host}:${options.port}`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": CORS_HEADERS,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      });
      res.end();
      return;
    }

    if (req.method === "GET" && path === "/health") {
      writeJson(res, 200, {
        ok: true,
        linked: options.state.ownerUserId != null,
        dmChannelId: options.state.dmChannelId
      });
      return;
    }

    if (!isAuthorized(req, options.proxySecret)) {
      writeUnauthorized(res);
      return;
    }

    if (req.method === "GET" && (path === "/mcp" || path === "/sse")) {
      const sessionId = randomUUID();
      const endpoint = getMessageEndpoint(options.host, listeningPort, sessionId);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Mcp-Session-Id": sessionId
      });

      res.write(`event: endpoint\n`);
      res.write(`data: ${JSON.stringify({ uri: endpoint })}\n\n`);
      req.on("close", () => res.end());
      return;
    }

    if (req.method === "POST" && (path === "/messages" || path === "/mcp")) {
      let body = "";

      try {
        body = await readBody(req);
      } catch (error) {
        writeError(res, null, error instanceof Error && error.message === "Payload too large" ? -32000 : -32700, error instanceof Error ? error.message : String(error));
        return;
      }

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch {
        writeError(res, null, -32700, "Invalid JSON");
        return;
      }

      const response = await handleRequest(request, options);
      writeJson(res, 200, response, url.searchParams.get("session_id") ? { "Mcp-Session-Id": url.searchParams.get("session_id") ?? "" } : {});
      return;
    }

    writeJson(res, 404, { error: true, message: "Not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  const port = address != null && typeof address === "object" ? address.port : options.port;
  listeningPort = port;
  return { server, port };
}

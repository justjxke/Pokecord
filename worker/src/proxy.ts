export interface WorkerEnv {
  POKE_BACKEND_ORIGIN?: string;
  POKE_EDGE_SECRET?: string;
}

const EDGE_SECRET_HEADER = "x-poke-edge-secret";
const CORS_HEADERS = "Content-Type, Mcp-Session-Id, X-Poke-Edge-Secret";
const ENDPOINT_PATH = "/messages/";

function plainResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": CORS_HEADERS,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    }
  });
}

function buildBackendUrl(requestUrl: URL, backendOrigin: string): URL {
  const url = new URL(backendOrigin);
  url.pathname = requestUrl.pathname;
  url.search = requestUrl.search;
  return url;
}

function buildMessageEndpoint(publicUrl: URL, sessionId: string): string {
  const endpoint = new URL(publicUrl.origin);
  endpoint.pathname = ENDPOINT_PATH;
  endpoint.search = `?session_id=${sessionId}`;
  return endpoint.toString();
}

function buildEndpointResponse(publicUrl: URL): Response {
  const sessionId = crypto.randomUUID();
  return new Response(`event: endpoint\ndata: ${JSON.stringify({ uri: buildMessageEndpoint(publicUrl, sessionId) })}\n\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Mcp-Session-Id": sessionId
    }
  });
}

function addSecret(headers: Headers, secret: string | undefined): void {
  const trimmed = secret?.trim();
  if (trimmed) headers.set(EDGE_SECRET_HEADER, trimmed);
}

async function proxyRequest(request: Request, env: WorkerEnv, fetchImpl: typeof fetch): Promise<Response> {
  const backendOrigin = env.POKE_BACKEND_ORIGIN?.trim();
  if (!backendOrigin) {
    return plainResponse("Missing POKE_BACKEND_ORIGIN.", 500);
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(request.url);
  } catch {
    return plainResponse("Invalid request URL.", 500);
  }

  const backendUrl = buildBackendUrl(publicUrl, backendOrigin);
  const headers = new Headers(request.headers);
  addSecret(headers, env.POKE_EDGE_SECRET);

  if (request.method === "GET" && (publicUrl.pathname === "/mcp" || publicUrl.pathname === "/sse")) {
    return buildEndpointResponse(publicUrl);
  }

  if (request.method === "POST" && (publicUrl.pathname === "/mcp" || publicUrl.pathname === "/messages")) {
    const body = await request.text();
    return fetchImpl(backendUrl.toString(), {
      method: request.method,
      headers,
      body
    });
  }

  if (publicUrl.pathname === "/health" || publicUrl.pathname === "/messages") {
    return fetchImpl(backendUrl.toString(), { method: request.method, headers });
  }

  return plainResponse("Not found.", 404);
}

export { proxyRequest };

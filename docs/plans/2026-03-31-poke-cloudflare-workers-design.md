# Poke Cloudflare Workers Deployment Design

Date: 2026-03-31

## Summary

Move the public MCP entrypoint for Poke onto Cloudflare Workers while keeping the existing Node backend on the Mac. The Worker becomes the internet-facing `/mcp` endpoint that Poke can reach, and it forwards requests to the current local bridge over a tunneled backend URL. This preserves the current Discord bot behavior, state handling, and Poke API relay logic without rewriting the whole app for the Workers runtime.

## Goals

- Expose a public Cloudflare Workers MCP endpoint for Poke.
- Keep the existing Discord bot and relay behavior intact.
- Keep the Mac backend as the source of truth for state and outbound Discord/Poke work.
- Minimize changes to the current Node codebase.
- Keep setup understandable and testable.

## Non-Goals

- No full Discord bot rewrite for Workers.
- No migration of the Discord gateway connection into Workers.
- No attempt to make Workers directly talk to Discord's gateway.
- No redesign of the bridge's user-facing Discord behavior.

## Recommended Architecture

### Components

1. **Cloudflare Worker**
   - Public entrypoint for Poke.
   - Exposes `https://<worker>/mcp`.
   - Proxies MCP requests to the backend bridge over HTTPS.
   - Handles only lightweight request forwarding and response streaming.

2. **Mac backend bridge**
   - Existing Node daemon.
   - Keeps the Discord bot connection alive.
   - Keeps local state and Poke API relay logic.
   - Exposes a private or tunneled backend endpoint for the Worker to call.

3. **Cloudflare Tunnel or equivalent backend reachability**
   - Makes the Mac backend reachable from the Worker without opening the Mac directly to the internet.
   - Can be a named tunnel or a stable public origin endpoint protected by a secret.

## Why this approach

This is the smallest architecture that satisfies the requirement to have a real Workers deployment without breaking the current Discord side. Workers are a good public edge layer, but they cannot host the Discord gateway client that the current bridge depends on. A thin Worker proxy keeps the public MCP URL on Cloudflare while leaving the hard stateful work in Node.

## Request Flow

1. Poke calls `https://<worker>/mcp`.
2. The Worker forwards the request to the backend bridge.
3. The backend bridge handles MCP session state and tool calls.
4. Discord messages still flow through the existing bot logic on the Mac.
5. Replies continue to be sent back through the same Node relay path.

## Endpoint Shape

- Public URL: `https://<worker-subdomain>.workers.dev/mcp`
- Backend URL: a tunneled or otherwise reachable HTTPS endpoint on the Mac side
- Internal transport: keep the backend's current MCP semantics unless they need small adjustments for Worker proxying

## Error Handling

- **Backend unavailable**: Worker returns a clear upstream error.
- **MCP handshake failure**: Worker passes through the backend's failure as-is when possible.
- **Timeouts**: prefer fast failure over hanging requests.
- **Bad session state**: backend remains responsible for session bookkeeping.

## Security

- Keep the Discord bot token and Poke API key on the backend, not in Workers.
- Use a secret or authenticated origin path between the Worker and backend.
- Do not expose the Mac backend directly without protection.
- Keep the public Worker endpoint minimal and stateless.

## Testing

- Worker routes `/mcp` to the backend.
- Backend still starts and links Discord as before.
- Poke can reach the public Worker URL.
- End-to-end tool calls still reach Discord through the backend.
- Backend failure surfaces cleanly at the edge.

## Open Questions

- Should the backend be exposed through a named tunnel or a protected public origin?
- Should the Worker proxy raw MCP requests or adapt the protocol slightly if needed?
- Should `/health` also be surfaced publicly or kept backend-only?

## Recommendation

Use a thin Cloudflare Worker as the public MCP edge and keep the current Node bridge as the backend. This gives a real Workers deployment for Poke without forcing a risky rewrite of the Discord integration.

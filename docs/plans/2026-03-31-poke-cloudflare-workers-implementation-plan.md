# Poke Cloudflare Workers Deployment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Put the public MCP endpoint on Cloudflare Workers while keeping the current Discord bot and relay logic running in the existing Node backend on the Mac.

**Architecture:** The Node app stays responsible for Discord, state, and Poke relay behavior. A new Cloudflare Worker becomes the public `/mcp` edge and forwards MCP traffic to the backend over a protected HTTPS origin. The Worker stays thin and stateless so the only real behavioral change is where Poke connects from.

**Tech Stack:** TypeScript, Node, Cloudflare Workers runtime, `wrangler`, existing `node:test`-style tests, current `discord.js` bridge code.

---

### Task 1: Split the MCP server into a backend that can be proxied safely.

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Modify: `README.md`
- Test: `test/mcp.test.ts`

**Step 1: Write the failing tests**

Add tests that prove the backend MCP layer can:
- reject requests without the shared edge secret when proxy auth is enabled,
- accept requests with the shared secret,
- still answer `/health` locally,
- keep the current tool behavior unchanged.

Keep the tests focused on HTTP behavior and JSON-RPC results rather than the Discord bot.

**Step 2: Run the tests to make sure they fail**

Run: `pnpm test`

Expected: fail because the auth-protected proxy path does not exist yet.

**Step 3: Write the minimal implementation**

Implement the smallest safe backend changes:
- add a shared secret header or token for Worker-to-backend requests,
- keep local development working without the secret when the proxy feature is disabled,
- preserve the current `/mcp`, `/sse`, `/messages`, and `/health` behavior,
- avoid changing the Discord relay logic.

Keep the backend API boring and explicit so the Worker can forward requests without special cases.

**Step 4: Run the tests to verify they pass**

Run: `pnpm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/mcp.ts src/index.ts src/config.ts src/types.ts test/mcp.test.ts README.md
git commit -m "feat: protect poke bridge backend for workers"
```

---

### Task 2: Add a Cloudflare Worker that proxies the public MCP endpoint.

**Files:**
- Create: `worker/wrangler.toml`
- Create: `worker/src/index.ts`
- Create: `worker/src/proxy.ts`
- Create: `worker/test/proxy.test.ts`
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`

**Step 1: Write the failing tests**

Add tests that prove the Worker can:
- accept `GET /mcp` and forward it to the backend,
- accept `POST /mcp` and stream or relay the backend response back to the caller,
- reject or return a clear error when the backend origin is missing,
- preserve the `/mcp` path and request headers that MCP needs.

Mock the backend fetch so the tests stay fast and deterministic.

**Step 2: Run the tests to make sure they fail**

Run: `pnpm --dir worker test`

Expected: fail because the Worker project does not exist yet.

**Step 3: Write the minimal implementation**

Implement a thin Worker entrypoint that:
- reads the backend origin and shared secret from env vars,
- forwards only the public MCP requests needed by Poke,
- copies through status, body, and MCP headers that the backend returns,
- keeps everything else simple and stateless.

Do not add framework code or extra routing beyond what the bridge needs.

**Step 4: Run the tests to verify they pass**

Run: `pnpm --dir worker test`

Expected: PASS.

**Step 5: Commit**

```bash
git add worker
git commit -m "feat: add cloudflare worker mcp proxy"
```

---

### Task 3: Wire local development and deployment docs around the new split.

**Files:**
- Modify: `README.md`
- Modify: `launchd/com.equicord.poke-discord-bridge.plist.example`
- Create: `docs/cloudflare-workers.md`
- Create: `.env.example`

**Step 1: Write the failing docs check or verification step**

There may not be a formal docs test, so use a build and smoke-check step instead:

Run: `pnpm test && pnpm typecheck`

Expected: PASS after the code changes from the earlier tasks are in place.

**Step 2: Write the minimal documentation updates**

Document:
- which env vars the Worker needs,
- which env vars the Node backend needs,
- how the Worker reaches the backend,
- how to run local development without Workers,
- how to deploy the Worker and point Poke at the public `/mcp` URL.

Keep the setup steps short and practical.

**Step 3: Update the launchd example if needed**

If local startup needs a new env var for the proxy secret or backend mode, add it to the LaunchAgent example so the Mac backend still starts cleanly.

**Step 4: Run the verification commands again**

Run:
- `pnpm test`
- `pnpm typecheck`

Expected: PASS.

**Step 5: Commit**

```bash
git add README.md launchd/com.equicord.poke-discord-bridge.plist.example docs/cloudflare-workers.md .env.example
git commit -m "docs: add cloudflare workers deployment guide"
```

---

### Task 4: Do a full end-to-end smoke check of the Worker-to-backend path.

**Files:**
- Modify only if smoke testing finds a bug

**Step 1: Start the Mac backend locally**

Run: `pnpm start`

Expected: backend starts, Discord connects, and the local MCP server is reachable.

**Step 2: Start the Worker in preview mode**

Run: `pnpm --dir worker dev`

Expected: the Worker serves `/mcp` and forwards requests to the backend origin configured in the environment.

**Step 3: Verify the public flow**

Check that:
- Poke can reach the Worker URL,
- the Worker forwards MCP requests to the backend,
- the backend still relays Discord messages,
- no Discord behavior changed.

**Step 4: Fix any rough edges**

Trim any extra code or awkward branching that was only needed for the smoke test.

**Step 5: Commit the last fixes**

```bash
git add -A
git commit -m "chore: polish poke cloudflare deployment"
```

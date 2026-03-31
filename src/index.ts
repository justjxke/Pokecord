import { spawn, type ChildProcess } from "node:child_process";

import { loadConfig } from "./config";
import { startDiscordBot, sendDiscordMessage } from "./discordBot";
import { startMcpServer } from "./mcp";
import { loadState, saveState, type BridgeState } from "./state";
import type { DiscordReplyTarget, DiscordRelayRequest } from "./types";
import { sendToPoke } from "./pokeClient";

const PENDING_TARGET_TTL_MS = 30 * 60 * 1000;
const PENDING_TARGET_CLEANUP_MS = 5 * 60 * 1000;

const log = (message: string) => {
  process.stdout.write(`[poke-discord-bridge] ${message}\n`);
};

async function startTunnel(port: number, enabled: boolean): Promise<ChildProcess | null> {
  if (!enabled) return null;

  const child = spawn("npx", ["poke@latest", "tunnel", `http://127.0.0.1:${port}/mcp`, "-n", "Poke Discord Bridge", "--recipe"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", chunk => log(String(chunk).trim()));
  child.stderr.on("data", chunk => log(String(chunk).trim()));
  child.on("exit", code => log(`Tunnel exited with code ${code ?? 0}.`));

  return child;
}

function rememberPendingTarget(targets: Map<string, DiscordReplyTarget>, request: DiscordRelayRequest): void {
  targets.set(request.bridgeRequestId, request.replyTarget);
}

function cleanupPendingTargets(targets: Map<string, DiscordReplyTarget>): void {
  const cutoff = Date.now() - PENDING_TARGET_TTL_MS;
  for (const [bridgeRequestId, target] of targets) {
    if (target.createdAt < cutoff) targets.delete(bridgeRequestId);
  }
}

function resolveReplyTarget(targets: Map<string, DiscordReplyTarget>, meta?: { channelId?: string; bridgeRequestId?: string; }, fallbackChannelId?: string | null): string {
  if (meta?.channelId) return meta.channelId;
  if (meta?.bridgeRequestId) {
    const target = targets.get(meta.bridgeRequestId);
    if (target) return target.channelId;
  }
  if (targets.size === 1) {
    const onlyTarget = targets.values().next().value;
    if (onlyTarget) return onlyTarget.channelId;
  }
  if (fallbackChannelId) return fallbackChannelId;
  throw new Error("Discord reply target not found.");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const state = await loadState(config.statePath);
  const pendingTargets = new Map<string, DiscordReplyTarget>();
  let discordClient: Awaited<ReturnType<typeof startDiscordBot>> | null = null;
  let tunnelProcess: ChildProcess | null = null;

  let saveQueue = Promise.resolve();
  const persistState = async (next: BridgeState) => {
    saveQueue = saveQueue.then(() => saveState(next, config.statePath));
    await saveQueue;
  };

  log("Cloudflare Worker mode is required for Poke to call back into Discord.");

  const mcp = await startMcpServer({
    host: config.mcpHost,
    port: config.mcpPort,
    state,
    proxySecret: config.edgeSecret,
    onSendDiscordMessage: async (content, meta) => {
      if (discordClient == null) throw new Error("Discord client is not ready.");
      const channelId = resolveReplyTarget(pendingTargets, meta, state.dmChannelId);
      await sendDiscordMessage(discordClient, channelId, content);
    }
  });

  log(`MCP server listening on http://${config.mcpHost}:${mcp.port}`);
  tunnelProcess = await startTunnel(mcp.port, config.autoTunnel && config.edgeSecret == null);

  discordClient = await startDiscordBot(config, state, async next => persistState(next), async request => {
    rememberPendingTarget(pendingTargets, request);
    try {
      return await sendToPoke(config, request);
    } catch (error) {
      pendingTargets.delete(request.bridgeRequestId);
      throw error;
    }
  });
  log(`Discord connected as ${discordClient.user?.tag ?? "unknown"}`);

  const cleanupInterval = setInterval(() => cleanupPendingTargets(pendingTargets), PENDING_TARGET_CLEANUP_MS);

  const shutdown = async () => {
    log("Shutting down...");
    clearInterval(cleanupInterval);
    tunnelProcess?.kill();
    await persistState(state);
    await discordClient?.destroy();
    await new Promise<void>(resolve => mcp.server.close(() => resolve()));
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch(error => {
  log(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

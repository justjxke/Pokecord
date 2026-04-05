import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createConnection } from "node:net";

import { getTenantPokeSecret } from "./bridgePolicy";
import { loadConfig } from "./config";
import { buildLavalinkConfig } from "./launchConfig";
import { startMcpServer } from "./mcp";
import { sendToPoke } from "./pokeClient";
import { createRuntimeStore } from "./runtimeStore";
import { loadState } from "./state";
import type { DiscordRelayRequest, DiscordSentMessageRecord } from "./types";
import { spawnWorker, type WorkerClient } from "./workerClient";

const LAVALINK_PORT = 2334;
const LAVALINK_HOST = "127.0.0.1";
const JAVA_DIR = "/data/jre";
const JAVA_BIN = `${JAVA_DIR}/bin/java`;
const LAVALINK_JAR = "/data/Lavalink.jar";
const LAVALINK_CONFIG = "/data/application.yml";
const JAVA_DOWNLOAD_URL = "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse";
const LAVALINK_DOWNLOAD_URL = "https://github.com/lavalink-devs/Lavalink/releases/latest/download/Lavalink.jar";
const RUNTIME_CONTEXT_TTL_MS = 30 * 60 * 1000;
const RUNTIME_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const log = (message: string) => {
  process.stdout.write(`[poke-discord-bridge:launcher] ${message}\n`);
};

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function exists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK)
    .then(() => true)
    .catch(() => false);
}

async function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: env ?? process.env
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}`));
    });
  });
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "PokeDiscord"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function ensureLavalinkConfig(desired: string): Promise<void> {
  if (await exists(LAVALINK_CONFIG)) {
    const current = await readFile(LAVALINK_CONFIG, "utf8");
    if (current === desired) {
      return;
    }
  }

  log("Writing Lavalink config...");
  await writeFile(LAVALINK_CONFIG, desired);
}

async function ensureJava(): Promise<void> {
  if (await exists(JAVA_BIN)) return;

  log("Downloading portable Java runtime...");
  await mkdir(JAVA_DIR, { recursive: true });
  await download(JAVA_DOWNLOAD_URL, "/tmp/temurin17.tar.gz");
  await run("tar", ["-xzf", "/tmp/temurin17.tar.gz", "-C", JAVA_DIR, "--strip-components=1"]);
}

async function ensureLavalinkJar(): Promise<void> {
  if (await exists(LAVALINK_JAR)) return;

  log("Downloading Lavalink jar...");
  await download(LAVALINK_DOWNLOAD_URL, LAVALINK_JAR);
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host, port });

      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };

      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1000, () => finish(false));
    });

    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function resolveRequestContext(
  store: ReturnType<typeof createRuntimeStore>,
  bridgeRequestId: string
): DiscordRelayRequest {
  const request = store.getRequest(bridgeRequestId);
  if (!request) {
    throw new Error("Discord request context not found.");
  }

  return request;
}

function resolveReplyChannelId(
  store: ReturnType<typeof createRuntimeStore>,
  meta?: { channelId?: string; bridgeRequestId?: string; }
): string {
  if (meta?.channelId) {
    return meta.channelId;
  }

  if (meta?.bridgeRequestId) {
    return resolveRequestContext(store, meta.bridgeRequestId).replyTarget.channelId;
  }

  throw new Error("Discord reply target not found.");
}

function resolveSentMessageTarget(
  store: ReturnType<typeof createRuntimeStore>,
  meta?: { channelId?: string; bridgeRequestId?: string; messageId?: string; }
): { channelId: string; messageId: string; } {
  if (meta?.channelId && meta?.messageId) {
    return {
      channelId: meta.channelId,
      messageId: meta.messageId
    };
  }

  if (meta?.bridgeRequestId) {
    const record = store.getSentMessages(meta.bridgeRequestId);
    if (!record) {
      throw new Error("Discord message target not found.");
    }

    if (meta.messageId) {
      return {
        channelId: record.channelId,
        messageId: meta.messageId
      };
    }

    if (record.messageIds.length !== 1) {
      throw new Error("Multiple Discord messages were sent for that request; provide messageId.");
    }

    return {
      channelId: record.channelId,
      messageId: record.messageIds[0] as string
    };
  }

  throw new Error("Discord message target not found.");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runtimeStore = createRuntimeStore(config.runtimeDbPath);
  const lavalinkPassword = process.env.POKE_LAVALINK_PASSWORD ?? process.env.LAVALINK_SERVER_PASSWORD;
  if (!lavalinkPassword) {
    throw new Error("Missing POKE_LAVALINK_PASSWORD.");
  }

  let worker: WorkerClient | null = null;
  let lavalinkReady = false;
  let shuttingDown = false;

  const loadHealthStatus = async () => {
    const state = await loadState(config.statePath, config.stateSecret);
    const installationCount = Object.keys(state.guildInstallations).length;
    const linkedUsers = Object.values(state.users).filter(user => user.encryptedPokeApiKey != null).length;
    return {
      ok: true,
      mode: state.mode,
      ownerLinked: state.owner.encryptedPokeApiKey != null,
      linkedUsers,
      installedGuilds: installationCount,
      linkedTenants: (state.owner.encryptedPokeApiKey ? 1 : 0) + linkedUsers + installationCount,
      workerReady: worker?.ready ?? false,
      workerDiscordTag: worker?.discordTag ?? null,
      lavalinkReady
    };
  };

  const mcp = await startMcpServer({
    host: config.mcpHost,
    port: config.mcpPort,
    getHealthStatus: loadHealthStatus,
    onSendDiscordMessage: async (content, meta) => {
      const currentWorker = worker;
      if (!currentWorker) throw new Error("Discord worker is not ready.");
      const channelId = resolveReplyChannelId(runtimeStore, meta);
      const messageIds = await currentWorker.request("sendDiscordMessage", {
        channelId,
        content,
        replyToMessageId: meta?.replyToMessageId,
        attachments: meta?.attachments,
        embeds: meta?.embeds
      });
      if (meta?.bridgeRequestId) {
        runtimeStore.saveSentMessages(meta.bridgeRequestId, channelId, messageIds);
      }
      return messageIds;
    },
    onEditDiscordMessage: async meta => {
      const currentWorker = worker;
      if (!currentWorker) throw new Error("Discord worker is not ready.");
      const target = resolveSentMessageTarget(runtimeStore, meta);
      await currentWorker.request("editDiscordMessage", {
        channelId: target.channelId,
        messageId: target.messageId,
        content: meta.content,
        embeds: meta.embeds
      });
    },
    onDeleteDiscordMessage: async meta => {
      const currentWorker = worker;
      if (!currentWorker) throw new Error("Discord worker is not ready.");
      const target = resolveSentMessageTarget(runtimeStore, meta);
      await currentWorker.request("deleteDiscordMessage", target);
    },
    onReactDiscordMessage: async meta => {
      const currentWorker = worker;
      if (!currentWorker) throw new Error("Discord worker is not ready.");
      const channelId = resolveReplyChannelId(runtimeStore, meta);
      if (!meta.messageId) throw new Error("Discord message id is required.");
      await currentWorker.request("reactDiscordMessage", {
        channelId,
        messageId: meta.messageId,
        emoji: meta.emoji
      });
    },
    onGetChannelHistory: async meta => {
      const currentWorker = worker;
      if (!currentWorker) throw new Error("Discord worker is not ready.");
      return currentWorker.request("getChannelHistory", meta);
    },
    onQueueVoiceTrack: async meta => {
      const currentWorker = worker;
      if (!currentWorker) throw new Error("Discord worker is not ready.");
      const request = resolveRequestContext(runtimeStore, meta.bridgeRequestId);
      if (request.mode !== "guild" || request.tenant.kind !== "guild") {
        throw new Error("Voice playback is only available in guilds.");
      }

      return currentWorker.request("queueVoiceTrack", {
        bridgeRequestId: meta.bridgeRequestId,
        guildId: request.tenant.id,
        requesterId: request.discordUserId,
        requesterUsername: request.voiceContext?.requester.username ?? request.discordUserId,
        requesterDisplayName: request.voiceContext?.requester.displayName ?? request.discordUserId,
        requesterVoiceChannelId: request.voiceContext?.requester.voiceChannel.id ?? "",
        requesterVoiceChannelName: request.voiceContext?.requester.voiceChannel.name ?? null,
        textChannelId: request.replyTarget.channelId,
        url: meta.url,
        artist: meta.artist,
        query: meta.query,
        position: meta.position
      });
    },
    onControlVoicePlayback: async meta => {
      const currentWorker = worker;
      if (!currentWorker) throw new Error("Discord worker is not ready.");
      const request = resolveRequestContext(runtimeStore, meta.bridgeRequestId);
      if (request.mode !== "guild" || request.tenant.kind !== "guild") {
        throw new Error("Voice playback is only available in guilds.");
      }

      return currentWorker.request("controlVoicePlayback", {
        bridgeRequestId: meta.bridgeRequestId,
        guildId: request.tenant.id,
        requesterId: request.discordUserId,
        requesterUsername: request.voiceContext?.requester.username ?? request.discordUserId,
        requesterDisplayName: request.voiceContext?.requester.displayName ?? request.discordUserId,
        requesterVoiceChannelId: request.voiceContext?.requester.voiceChannel.id ?? null,
        requesterVoiceChannelName: request.voiceContext?.requester.voiceChannel.name ?? null,
        textChannelId: request.replyTarget.channelId,
        action: meta.action,
        index: meta.index
      });
    }
  });

  log(`MCP server listening on http://${config.mcpHost}:${mcp.port}`);

  const cleanupInterval = setInterval(() => {
    runtimeStore.cleanupExpired(Date.now(), RUNTIME_CONTEXT_TTL_MS);
  }, RUNTIME_CLEANUP_INTERVAL_MS);

  log("Bootstrapping Lavalink...");
  await ensureLavalinkConfig(buildLavalinkConfig(lavalinkPassword, {
    youtubePoToken: config.youtubePoToken,
    youtubeVisitorData: config.youtubeVisitorData,
    youtubeOauthRefreshToken: config.youtubeOauthRefreshToken,
    youtubeOauthSkipInitialization: config.youtubeOauthSkipInitialization
  }));
  if (!config.youtubeOauthRefreshToken && !(config.youtubePoToken && config.youtubeVisitorData)) {
    log("YouTube playback is running without OAuth or poToken. Login-gated videos may resolve in search and then fail at playback.");
  }
  await ensureJava();
  await ensureLavalinkJar();

  const lavalinkEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SERVER_PORT: String(LAVALINK_PORT),
    LAVALINK_SERVER_PASSWORD: lavalinkPassword
  };

  log(`Starting Lavalink on ${LAVALINK_HOST}:${LAVALINK_PORT}...`);
  const lavalink = spawn(JAVA_BIN, [
    "-jar",
    LAVALINK_JAR,
    `--server.port=${LAVALINK_PORT}`,
    "--server.address=0.0.0.0",
    `--lavalink.server.password=${lavalinkPassword}`
  ], {
    stdio: "inherit",
    env: lavalinkEnv
  });

  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanupInterval);
    worker?.kill("SIGTERM");
    lavalink.kill("SIGTERM");
    runtimeStore.close();
    await new Promise<void>(resolve => mcp.server.close(() => resolve()));
    process.exit(code);
  };

  lavalink.once("exit", (code, signal) => {
    lavalinkReady = false;
    if (!shuttingDown) {
      log(`Lavalink exited (${code ?? `signal ${signal ?? "unknown"}`}).`);
      void shutdown(code ?? 1);
      return;
    }

    log(`Lavalink exited (${code ?? `signal ${signal ?? "unknown"}`}).`);
  });

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  process.on("uncaughtExceptionMonitor", error => {
    log(`uncaughtExceptionMonitor: ${normalizeError(error).stack ?? normalizeError(error).message}`);
  });
  process.on("unhandledRejection", error => {
    log(`unhandledRejection: ${normalizeError(error).stack ?? normalizeError(error).message}`);
  });

  await waitForTcpPort(LAVALINK_HOST, LAVALINK_PORT, 120_000);
  lavalinkReady = true;
  log("Lavalink is ready, starting worker...");

  let workerRestartDelayMs = 1000;
  const handleRelayRequest = async (request: DiscordRelayRequest) => {
    runtimeStore.saveRequest(request, RUNTIME_CONTEXT_TTL_MS);
    const state = await loadState(config.statePath, config.stateSecret);
    const pokeApiKey = getTenantPokeSecret(state, request.tenant, config.stateSecret);
    if (!pokeApiKey) {
      throw new Error(`No Poke API key linked for ${request.tenant.kind}.`);
    }

    return sendToPoke(config, pokeApiKey, request);
  };

  while (!shuttingDown) {
    log("Starting Discord worker...");
    worker = spawnWorker(handleRelayRequest);
    const [workerExitCode, workerExitSignal] = await worker.waitForExit();
    if (shuttingDown) {
      return;
    }

    log(`Discord worker exited (${workerExitCode ?? `signal ${workerExitSignal ?? "unknown"}`}). Restarting in ${workerRestartDelayMs}ms...`);
    await new Promise(resolve => setTimeout(resolve, workerRestartDelayMs));
    workerRestartDelayMs = Math.min(workerRestartDelayMs * 2, 30_000);
  }
}

void main().catch(error => {
  console.error(`[poke-discord-bridge:launcher] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});

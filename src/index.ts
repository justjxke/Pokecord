import { loadConfig } from "./config";
import { getDiscordChannelHistory, startDiscordBot, startTypingIndicator, sendDiscordMessage, sendDiscordReaction, editDiscordMessage, deleteDiscordMessage } from "./discordBot";
import { getTenantPokeSecret } from "./bridgePolicy";
import { startMcpServer } from "./mcp";
import { loadState, saveState, type BridgeState } from "./state";
import type { DiscordReplyTarget, DiscordRelayRequest, DiscordSentMessageRecord } from "./types";
import type { VoiceManager } from "./voice";
import { sendToPoke } from "./pokeClient";
import type { Client } from "discord.js";

const PENDING_TARGET_TTL_MS = 30 * 60 * 1000;
const PENDING_TARGET_CLEANUP_MS = 5 * 60 * 1000;
const HOST_URL_HINT_KEYS = [
  "PUBLIC_URL",
  "APP_URL",
  "APP_BASE_URL",
  "SERVICE_URL",
  "WEB_URL",
  "EXTERNAL_URL",
  "PUBLIC_HOSTNAME",
  "HOSTNAME"
] as const;

const log = (message: string) => {
  process.stdout.write(`[poke-discord-bridge] ${message}\n`);
};

function logHostUrlHints(): void {
  const hints = HOST_URL_HINT_KEYS
    .map(key => [key, process.env[key]] as const)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `${key}=${value?.trim()}`);

  if (hints.length > 0) {
    log(`Host URL hints: ${hints.join(", ")}`);
  } else {
    log("Host URL hints: none");
  }
}

function rememberPendingTarget(targets: Map<string, DiscordReplyTarget>, request: DiscordRelayRequest): void {
  targets.set(request.bridgeRequestId, request.replyTarget);
}

function rememberPendingRequest(targets: Map<string, DiscordRelayRequest>, request: DiscordRelayRequest): void {
  targets.set(request.bridgeRequestId, request);
}

function cleanupPendingTargets(targets: Map<string, DiscordReplyTarget>): void {
  const cutoff = Date.now() - PENDING_TARGET_TTL_MS;
  for (const [bridgeRequestId, target] of targets) {
    if (target.createdAt < cutoff) targets.delete(bridgeRequestId);
  }
}

function cleanupPendingRequests(targets: Map<string, DiscordRelayRequest>): void {
  const cutoff = Date.now() - PENDING_TARGET_TTL_MS;
  for (const [bridgeRequestId, request] of targets) {
    if (request.replyTarget.createdAt < cutoff) targets.delete(bridgeRequestId);
  }
}

function resolvePendingRequest(targets: Map<string, DiscordRelayRequest>, bridgeRequestId: string): DiscordRelayRequest {
  const request = targets.get(bridgeRequestId);
  if (!request) {
    throw new Error("Discord request context not found.");
  }
  return request;
}

function rememberSentMessages(targets: Map<string, DiscordSentMessageRecord>, bridgeRequestId: string | undefined, channelId: string, messageIds: string[]): void {
  if (!bridgeRequestId || !messageIds.length) return;

  const existing = targets.get(bridgeRequestId);
  if (existing) {
    existing.channelId = channelId;
    existing.messageIds.push(...messageIds);
    existing.updatedAt = Date.now();
    return;
  }

  targets.set(bridgeRequestId, {
    channelId,
    messageIds: [...messageIds],
    updatedAt: Date.now()
  });
}

function cleanupSentMessages(targets: Map<string, DiscordSentMessageRecord>): void {
  const cutoff = Date.now() - PENDING_TARGET_TTL_MS;
  for (const [bridgeRequestId, record] of targets) {
    if (record.updatedAt < cutoff) targets.delete(bridgeRequestId);
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

function resolveSentMessageTarget(targets: Map<string, DiscordSentMessageRecord>, meta?: { channelId?: string; bridgeRequestId?: string; messageId?: string; }, fallbackChannelId?: string | null): { channelId: string; messageId: string; } {
  if (meta?.messageId && meta?.channelId) return { channelId: meta.channelId, messageId: meta.messageId };
  if (meta?.bridgeRequestId) {
    const record = targets.get(meta.bridgeRequestId);
    if (record) {
      const messageId = meta.messageId ?? (record.messageIds.length === 1 ? record.messageIds[0] : null);
      if (messageId) return { channelId: record.channelId, messageId };
      throw new Error("Multiple Discord messages were sent for that request; provide messageId.");
    }
  }
  if (meta?.messageId && fallbackChannelId) return { channelId: fallbackChannelId, messageId: meta.messageId };
  if (targets.size === 1) {
    const onlyTarget = targets.values().next().value;
    if (onlyTarget) {
      const messageId = meta?.messageId ?? (onlyTarget.messageIds.length === 1 ? onlyTarget.messageIds[0] : null);
      if (messageId) return { channelId: onlyTarget.channelId, messageId };
    }
  }
  throw new Error("Discord message target not found.");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const state = await loadState(config.statePath, config.stateSecret);
  const pendingTargets = new Map<string, DiscordReplyTarget>();
  const pendingRequests = new Map<string, DiscordRelayRequest>();
  const sentMessages = new Map<string, DiscordSentMessageRecord>();
  let discordClient: Client | null = null;
  let voiceManager: VoiceManager | null = null;

  let saveQueue = Promise.resolve();
  const persistState = async (next: BridgeState) => {
    saveQueue = saveQueue.then(() => saveState(next, config.statePath));
    await saveQueue;
  };

  log(`Starting in ${config.bridgeMode} mode.`);

  const mcp = await startMcpServer({
    host: config.mcpHost,
    port: config.mcpPort,
    state,
    onSendDiscordMessage: async (content, meta) => {
      if (discordClient == null) throw new Error("Discord client is not ready.");
      const channelId = resolveReplyTarget(pendingTargets, meta);
      const messageIds = await sendDiscordMessage(discordClient, channelId, content, {
        replyToMessageId: meta?.replyToMessageId,
        attachments: meta?.attachments,
        embeds: meta?.embeds
      });
      rememberSentMessages(sentMessages, meta?.bridgeRequestId, channelId, messageIds);
      return messageIds;
    },
    onEditDiscordMessage: async meta => {
      if (discordClient == null) throw new Error("Discord client is not ready.");
      const { channelId, messageId } = resolveSentMessageTarget(sentMessages, meta);
      await editDiscordMessage(discordClient, channelId, messageId, meta.content, meta.embeds);
    },
    onDeleteDiscordMessage: async meta => {
      if (discordClient == null) throw new Error("Discord client is not ready.");
      const { channelId, messageId } = resolveSentMessageTarget(sentMessages, meta);
      await deleteDiscordMessage(discordClient, channelId, messageId);
    },
    onReactDiscordMessage: async meta => {
      if (discordClient == null) throw new Error("Discord client is not ready.");
      const channelId = resolveReplyTarget(pendingTargets, meta);
      if (!meta.messageId) throw new Error("Discord message id is required.");
      await sendDiscordReaction(discordClient, channelId, meta.messageId, meta.emoji);
    },
    onGetChannelHistory: async meta => {
      if (discordClient == null) throw new Error("Discord client is not ready.");
      return getDiscordChannelHistory(discordClient, meta.channelId, meta.limit);
    },
    onQueueVoiceTrack: async meta => {
      if (discordClient == null) throw new Error("Discord client is not ready.");
      if (voiceManager == null) throw new Error("Voice manager is not ready.");
      const request = resolvePendingRequest(pendingRequests, meta.bridgeRequestId);
      if (request.mode !== "guild" || request.tenant.kind !== "guild") {
        throw new Error("Voice playback is only available in guilds.");
      }
      const voiceContext = voiceManager.describeVoiceContext(request.tenant.id, {
        userId: request.discordUserId,
        username: request.voiceContext?.requester.username ?? request.discordUserId,
        displayName: request.voiceContext?.requester.displayName ?? request.discordUserId
      });
      if (!voiceContext?.requester.voiceChannel.id) {
        throw new Error("Join a voice channel first.");
      }

      return voiceManager.queueVoiceTrack({
        bridgeRequestId: meta.bridgeRequestId,
        guildId: request.tenant.id,
        requesterId: request.discordUserId,
        requesterUsername: voiceContext.requester.username,
        requesterDisplayName: voiceContext.requester.displayName,
        requesterVoiceChannelId: voiceContext.requester.voiceChannel.id,
        requesterVoiceChannelName: voiceContext.requester.voiceChannel.name,
        textChannelId: request.replyTarget.channelId,
        url: meta.url,
        position: meta.position
      });
    },
    onControlVoicePlayback: async meta => {
      if (discordClient == null) throw new Error("Discord client is not ready.");
      if (voiceManager == null) throw new Error("Voice manager is not ready.");
      const request = resolvePendingRequest(pendingRequests, meta.bridgeRequestId);
      if (request.mode !== "guild" || request.tenant.kind !== "guild") {
        throw new Error("Voice playback is only available in guilds.");
      }

      const voiceContext = voiceManager.describeVoiceContext(request.tenant.id, {
        userId: request.discordUserId,
        username: request.voiceContext?.requester.username ?? request.discordUserId,
        displayName: request.voiceContext?.requester.displayName ?? request.discordUserId
      });

      return voiceManager.controlVoicePlayback({
        bridgeRequestId: meta.bridgeRequestId,
        guildId: request.tenant.id,
        requesterId: request.discordUserId,
        requesterUsername: voiceContext?.requester.username ?? request.discordUserId,
        requesterDisplayName: voiceContext?.requester.displayName ?? request.discordUserId,
        requesterVoiceChannelId: voiceContext?.requester.voiceChannel.id ?? null,
        requesterVoiceChannelName: voiceContext?.requester.voiceChannel.name ?? null,
        textChannelId: request.replyTarget.channelId,
        action: meta.action,
        ...(meta.index == null ? {} : { index: meta.index })
      });
    }
  });

  log(`MCP server listening on http://${config.mcpHost}:${mcp.port}`);
  log(`Bridge mode: ${config.bridgeMode}`);
  logHostUrlHints();

  const runtime = await startDiscordBot(config, state, async next => persistState(next), async request => {
    rememberPendingTarget(pendingTargets, request);
    rememberPendingRequest(pendingRequests, request);
    const pokeApiKey = getTenantPokeSecret(state, request.tenant, config.stateSecret);
    if (!pokeApiKey) {
      pendingTargets.delete(request.bridgeRequestId);
      pendingRequests.delete(request.bridgeRequestId);
      throw new Error(`No Poke API key linked for ${request.tenant.kind}.`);
    }

    let stopTyping: (() => Promise<void>) | null = null;
    try {
      stopTyping = await startTypingIndicator(discordClient!, request.replyTarget.channelId);
    } catch {
      stopTyping = null;
    }

    try {
      return await sendToPoke(config, pokeApiKey, request);
    } catch (error) {
      pendingTargets.delete(request.bridgeRequestId);
      pendingRequests.delete(request.bridgeRequestId);
      throw error;
    } finally {
      await stopTyping?.();
    }
  });
  discordClient = runtime.client;
  voiceManager = runtime.voiceManager;
  log(`Discord connected as ${discordClient.user?.tag ?? "unknown"}`);

  const cleanupInterval = setInterval(() => {
    cleanupPendingTargets(pendingTargets);
    cleanupPendingRequests(pendingRequests);
    cleanupSentMessages(sentMessages);
  }, PENDING_TARGET_CLEANUP_MS);

  const shutdown = async () => {
    log("Shutting down...");
    clearInterval(cleanupInterval);
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

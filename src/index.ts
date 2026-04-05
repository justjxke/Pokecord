import { randomUUID } from "node:crypto";

import type { Client } from "discord.js";

import {
  deleteDiscordMessage,
  editDiscordMessage,
  getDiscordChannelHistory,
  sendDiscordMessage,
  sendDiscordReaction,
  startDiscordBot,
  startTypingIndicator
} from "./discordBot";
import { loadConfig } from "./config";
import { loadState, saveState, type BridgeState } from "./state";
import type { DiscordRelayRequest } from "./types";
import type { VoiceManager } from "./voice";
import {
  createWorkerMessageParser,
  encodeWorkerMessage,
  type WorkerCommandName,
  type WorkerRequestMessage,
  type WorkerResponsePayloadMap
} from "./workerProtocol";

const log = (message: string) => {
  process.stderr.write(`[poke-discord-bridge:worker] ${message}\n`);
};

type PendingSupervisorRequest = {
  method: WorkerCommandName;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const state = await loadState(config.statePath, config.stateSecret);
  let discordClient: Client | null = null;
  let voiceManager: VoiceManager | null = null;

  const pendingRequests = new Map<string, PendingSupervisorRequest>();
  const send = (message: unknown) => {
    process.stdout.write(encodeWorkerMessage(message as never));
  };

  let saveQueue = Promise.resolve();
  const persistState = async (next: BridgeState) => {
    saveQueue = saveQueue.then(() => saveState(next, config.statePath));
    await saveQueue;
  };

  const sendRequestToSupervisor = <T extends WorkerCommandName>(
    method: T,
    payload: T extends "relayRequest" ? { request: DiscordRelayRequest; } : never
  ): Promise<WorkerResponsePayloadMap[T]> => {
    const id = randomUUID();
    send({
      kind: "request",
      id,
      method,
      payload
    });

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, {
        method,
        resolve: value => resolve(value as WorkerResponsePayloadMap[T]),
        reject
      });
    });
  };

  const respond = <T extends WorkerCommandName>(
    request: WorkerRequestMessage<T>,
    payload: WorkerResponsePayloadMap[T] | null
  ) => {
    send({
      kind: "response",
      id: request.id,
      ok: true,
      method: request.method,
      payload: payload ?? undefined
    });
  };

  const respondError = <T extends WorkerCommandName>(request: WorkerRequestMessage<T>, error: unknown) => {
    send({
      kind: "response",
      id: request.id,
      ok: false,
      method: request.method,
      error: normalizeError(error).message
    });
  };

  const handleSupervisorRequest = async (request: WorkerRequestMessage) => {
    if (discordClient == null) {
      respondError(request, new Error("Discord client is not ready."));
      return;
    }

    try {
      switch (request.method) {
        case "sendDiscordMessage": {
          const payload = (request as WorkerRequestMessage<"sendDiscordMessage">).payload;
          respond(request, await sendDiscordMessage(discordClient, payload.channelId, payload.content, {
            replyToMessageId: payload.replyToMessageId,
            attachments: payload.attachments,
            embeds: payload.embeds
          }));
          return;
        }
        case "editDiscordMessage": {
          const payload = (request as WorkerRequestMessage<"editDiscordMessage">).payload;
          await editDiscordMessage(discordClient, payload.channelId, payload.messageId, payload.content, payload.embeds);
          respond(request, null);
          return;
        }
        case "deleteDiscordMessage": {
          const payload = (request as WorkerRequestMessage<"deleteDiscordMessage">).payload;
          await deleteDiscordMessage(discordClient, payload.channelId, payload.messageId);
          respond(request, null);
          return;
        }
        case "reactDiscordMessage": {
          const payload = (request as WorkerRequestMessage<"reactDiscordMessage">).payload;
          await sendDiscordReaction(discordClient, payload.channelId, payload.messageId, payload.emoji);
          respond(request, null);
          return;
        }
        case "getChannelHistory": {
          const payload = (request as WorkerRequestMessage<"getChannelHistory">).payload;
          respond(request, await getDiscordChannelHistory(discordClient, payload.channelId, payload.limit));
          return;
        }
        case "queueVoiceTrack": {
          const payload = (request as WorkerRequestMessage<"queueVoiceTrack">).payload;
          if (voiceManager == null) throw new Error("Voice manager is not ready.");
          respond(request, await voiceManager.queueVoiceTrack(payload));
          return;
        }
        case "controlVoicePlayback": {
          const payload = (request as WorkerRequestMessage<"controlVoicePlayback">).payload;
          if (voiceManager == null) throw new Error("Voice manager is not ready.");
          respond(request, await voiceManager.controlVoicePlayback(payload));
          return;
        }
        default:
          respondError(request, new Error(`Unsupported supervisor request: ${request.method}`));
      }
    } catch (error) {
      respondError(request, error);
    }
  };

  const parser = createWorkerMessageParser(message => {
    if (message.kind === "request") {
      void handleSupervisorRequest(message);
      return;
    }

    if (message.kind === "event") {
      return;
    }

    const pending = pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    pendingRequests.delete(message.id);
    if (!message.ok) {
      pending.reject(new Error(message.error ?? `${message.method} failed.`));
      return;
    }

    pending.resolve(message.payload);
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => parser(chunk.toString()));

  const runtime = await startDiscordBot(config, state, async next => persistState(next), async request => {
    let stopTyping: (() => Promise<void>) | null = null;
    try {
      stopTyping = await startTypingIndicator(discordClient!, request.replyTarget.channelId);
    } catch {
      stopTyping = null;
    }

    try {
      return await sendRequestToSupervisor("relayRequest", { request });
    } finally {
      await stopTyping?.();
    }
  });

  discordClient = runtime.client;
  voiceManager = runtime.voiceManager;
  send({
    kind: "event",
    event: "ready",
    payload: {
      discordTag: discordClient.user?.tag ?? null
    }
  });
  log(`Discord connected as ${discordClient.user?.tag ?? "unknown"}`);

  const shutdown = async () => {
    log("Shutting down worker...");
    await persistState(state);
    await discordClient?.destroy();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch(error => {
  log(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

import type { DiscordRelayRequest, PokeSendResult } from "./types";
import {
  createWorkerMessageParser,
  encodeWorkerMessage,
  type WorkerCommandName,
  type WorkerRequestPayloadMap,
  type WorkerResponsePayloadMap,
  type WorkerMessage,
  type WorkerRequestMessage,
  type WorkerResponseMessage
} from "./workerProtocol";

type PendingRequest = {
  method: WorkerCommandName;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export interface WorkerClient {
  readonly ready: boolean;
  readonly discordTag: string | null;
  request<T extends WorkerCommandName>(method: T, payload: WorkerRequestPayloadMap[T]): Promise<WorkerResponsePayloadMap[T]>;
  waitForExit(): Promise<[number | null, NodeJS.Signals | null]>;
  kill(signal?: NodeJS.Signals): void;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function spawnWorker(
  onRelayRequest: (request: DiscordRelayRequest) => Promise<PokeSendResult>
): WorkerClient {
  const child = spawn("bun", ["run", "src/index.ts"], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  const pending = new Map<string, PendingRequest>();
  let ready = false;
  let discordTag: string | null = null;

  const send = (message: WorkerMessage) => {
    child.stdin.write(encodeWorkerMessage(message));
  };

  const rejectAllPending = (reason: string) => {
    const error = new Error(reason);
    for (const [id, request] of pending) {
      pending.delete(id);
      request.reject(error);
    }
  };

  const respond = <T extends WorkerCommandName>(
    request: WorkerRequestMessage<T>,
    response: WorkerResponseMessage<T>
  ) => {
    send(response);
  };

  const handleWorkerRequest = async (message: WorkerRequestMessage) => {
    if (message.method !== "relayRequest") {
      respond(message, {
        kind: "response",
        id: message.id,
        ok: false,
        method: message.method,
        error: `Unsupported worker request: ${message.method}`
      });
      return;
    }

    try {
      const result = await onRelayRequest((message as WorkerRequestMessage<"relayRequest">).payload.request);
      respond(message, {
        kind: "response",
        id: message.id,
        ok: true,
        method: message.method,
        payload: result
      });
    } catch (error) {
      respond(message, {
        kind: "response",
        id: message.id,
        ok: false,
        method: message.method,
        error: normalizeError(error).message
      });
    }
  };

  const parser = createWorkerMessageParser(message => {
    if (message.kind === "event") {
      if (message.event === "ready") {
        ready = true;
        discordTag = message.payload?.discordTag ?? null;
        process.stdout.write(`[poke-discord-bridge:launcher] Discord worker ready${discordTag ? ` as ${discordTag}` : ""}\n`);
      }
      return;
    }

    if (message.kind === "request") {
      void handleWorkerRequest(message);
      return;
    }

    const request = pending.get(message.id);
    if (!request) {
      return;
    }

    pending.delete(message.id);
    if (!message.ok) {
      request.reject(new Error(message.error ?? `${message.method} failed.`));
      return;
    }

    request.resolve(message.payload);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => parser(chunk));

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    process.stderr.write(chunk);
  });

  child.once("exit", (code, signal) => {
    ready = false;
    rejectAllPending(`Discord worker exited (${code ?? `signal ${signal ?? "unknown"}`}).`);
  });

  return {
    get ready() {
      return ready;
    },

    get discordTag() {
      return discordTag;
    },

    request(method, payload) {
      if (!ready) {
      return Promise.reject(new Error("Discord worker is not ready."));
      }

      const id = randomUUID();
      send({
        kind: "request",
        id,
        method,
        payload
      });

      return new Promise((resolve, reject) => {
        pending.set(id, {
          method,
          resolve: value => resolve(value as WorkerResponsePayloadMap[typeof method]),
          reject
        });
      });
    },

    waitForExit() {
      return once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    },

    kill(signal = "SIGTERM") {
      child.kill(signal);
    }
  };
}

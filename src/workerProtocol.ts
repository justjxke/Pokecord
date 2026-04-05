import type {
  DiscordChannelHistoryMessage,
  DiscordOutboundAttachment,
  DiscordOutboundEmbed,
  DiscordRelayRequest,
  PokeSendResult
} from "./types";
import type { ControlVoicePlaybackInput, QueueVoiceTrackInput, VoiceOperationResult } from "./voice";

export type WorkerCommandName =
  | "sendDiscordMessage"
  | "editDiscordMessage"
  | "deleteDiscordMessage"
  | "reactDiscordMessage"
  | "getChannelHistory"
  | "queueVoiceTrack"
  | "controlVoicePlayback"
  | "relayRequest";

export interface WorkerRequestPayloadMap {
  sendDiscordMessage: {
    channelId: string;
    content: string;
    replyToMessageId?: string;
    attachments?: DiscordOutboundAttachment[];
    embeds?: DiscordOutboundEmbed[];
  };
  editDiscordMessage: {
    channelId: string;
    messageId: string;
    content?: string;
    embeds?: DiscordOutboundEmbed[];
  };
  deleteDiscordMessage: {
    channelId: string;
    messageId: string;
  };
  reactDiscordMessage: {
    channelId: string;
    messageId: string;
    emoji: string;
  };
  getChannelHistory: {
    channelId: string;
    limit: number;
  };
  queueVoiceTrack: QueueVoiceTrackInput;
  controlVoicePlayback: ControlVoicePlaybackInput;
  relayRequest: {
    request: DiscordRelayRequest;
  };
}

export interface WorkerResponsePayloadMap {
  sendDiscordMessage: string[];
  editDiscordMessage: null;
  deleteDiscordMessage: null;
  reactDiscordMessage: null;
  getChannelHistory: DiscordChannelHistoryMessage[];
  queueVoiceTrack: VoiceOperationResult;
  controlVoicePlayback: VoiceOperationResult;
  relayRequest: PokeSendResult;
}

export type WorkerRequestMessage<T extends WorkerCommandName = WorkerCommandName> = {
  kind: "request";
  id: string;
  method: T;
  payload: WorkerRequestPayloadMap[T];
};

export type WorkerResponseMessage<T extends WorkerCommandName = WorkerCommandName> = {
  kind: "response";
  id: string;
  ok: boolean;
  method: T;
  payload?: WorkerResponsePayloadMap[T];
  error?: string;
};

export type WorkerEventMessage = {
  kind: "event";
  event: "ready";
  payload?: {
    discordTag: string | null;
  };
};

export type WorkerMessage = WorkerRequestMessage | WorkerResponseMessage | WorkerEventMessage;

export function encodeWorkerMessage(message: WorkerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function createWorkerMessageParser(onMessage: (message: WorkerMessage) => void): (chunk: string) => void {
  let buffer = "";

  return chunk => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      onMessage(JSON.parse(line) as WorkerMessage);
    }
  };
}

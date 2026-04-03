import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { BridgeState, DiscordChannelHistoryMessage, DiscordOutboundAttachment, DiscordOutboundEmbed } from "./types";
import type { VoiceOperationResult } from "./voice";

type VoiceControlAction = "join" | "pause" | "resume" | "skip" | "stop" | "leave" | "current" | "queue" | "remove" | "clear";
type QueueVoiceTrackRequest = { bridgeRequestId: string; url: string; position: "front" | "back"; };
type ControlVoicePlaybackRequest = { bridgeRequestId: string; action: VoiceControlAction; index?: number; };

interface StartMcpServerOptions {
  host: string;
  port: number;
  state: BridgeState;
  onSendDiscordMessage: (content: string, meta?: { channelId?: string; bridgeRequestId?: string; replyToMessageId?: string; attachments?: DiscordOutboundAttachment[]; embeds?: DiscordOutboundEmbed[]; }) => Promise<string[]>;
  onEditDiscordMessage: (meta: { content?: string; embeds?: DiscordOutboundEmbed[]; channelId?: string; bridgeRequestId?: string; messageId?: string; }) => Promise<void>;
  onDeleteDiscordMessage: (meta: { channelId?: string; bridgeRequestId?: string; messageId?: string; }) => Promise<void>;
  onReactDiscordMessage: (meta: { emoji: string; channelId?: string; bridgeRequestId?: string; messageId?: string; }) => Promise<void>;
  onGetChannelHistory: (meta: { channelId: string; limit: number; }) => Promise<DiscordChannelHistoryMessage[]>;
  onQueueVoiceTrack: (meta: QueueVoiceTrackRequest) => Promise<VoiceOperationResult>;
  onControlVoicePlayback: (meta: ControlVoicePlaybackRequest) => Promise<VoiceOperationResult>;
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

const SEND_TOOL_NAME = "sendDiscordMessage";
const SEND_TOOL_DESCRIPTION = "Send a message into a Discord channel or reply to a message.";
const REPLY_TOOL_NAME = "replyToDiscordMessage";
const REPLY_TOOL_DESCRIPTION = "Reply to a specific Discord message.";
const EDIT_TOOL_NAME = "editDiscordMessage";
const EDIT_TOOL_DESCRIPTION = "Edit a specific Discord message the bridge already sent.";
const DELETE_TOOL_NAME = "deleteDiscordMessage";
const DELETE_TOOL_DESCRIPTION = "Delete a specific Discord message the bridge already sent.";
const REACT_TOOL_NAME = "reactToDiscordMessage";
const REACT_TOOL_DESCRIPTION = "Add an emoji reaction to a Discord message.";
const HISTORY_TOOL_NAME = "getChannelHistory";
const HISTORY_TOOL_DESCRIPTION = "Get recent messages from a Discord channel.";
const QUEUE_VOICE_TOOL_NAME = "queueVoiceTrack";
const QUEUE_VOICE_TOOL_DESCRIPTION = "Join the requester's voice channel if needed and queue a YouTube track for playback.";
const CONTROL_VOICE_TOOL_NAME = "controlVoicePlayback";
const CONTROL_VOICE_TOOL_DESCRIPTION = "Control the current guild voice session.";
const MAX_BODY_BYTES = 128_000;
const CORS_HEADERS = "Content-Type, Mcp-Session-Id";

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

function getMessageEndpoint(publicOrigin: string, mountPrefix: string, sessionId: string): string {
  const prefix = mountPrefix.replace(/\/+$/, "");
  return `${publicOrigin}${prefix}/messages/?session_id=${sessionId}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length ? value.trim() : undefined;
}

function readLimit(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return parsed;
}

function matchesRoute(path: string, route: string): boolean {
  const normalizedPath = path.replace(/\/+$/, "");
  const normalizedRoute = route.replace(/\/+$/, "");
  return normalizedPath === normalizedRoute || normalizedPath.endsWith(normalizedRoute);
}

function resolveMountedPrefix(path: string, route: string): string | null {
  const normalizedPath = path.replace(/\/+$/, "");
  const normalizedRoute = route.replace(/\/+$/, "");
  if (normalizedPath === normalizedRoute) {
    return "";
  }
  if (normalizedPath.endsWith(normalizedRoute)) {
    const prefix = normalizedPath.slice(0, -normalizedRoute.length).replace(/\/+$/, "");
    return prefix;
  }
  return null;
}

function isMountedRoot(path: string): boolean {
  const normalizedPath = path.replace(/\/+$/, "");
  return normalizedPath.length > 1 && normalizedPath.split("/").filter(Boolean).length === 1;
}

function parseAttachments(value: unknown): DiscordOutboundAttachment[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;

  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`attachments[${index}] must be an object`);
    const url = readString(item.url);
    if (!url) throw new Error(`attachments[${index}].url is required`);
    const name = readString(item.name);
    const contentType = typeof item.contentType === "string" && item.contentType.trim().length ? item.contentType.trim() : undefined;
    return { url, ...(name ? { name } : {}), ...(contentType ? { contentType } : {}) };
  });
}

function parseEmbeds(value: unknown): DiscordOutboundEmbed[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;

  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`embeds[${index}] must be an object`);
    const fields = Array.isArray(item.fields)
      ? item.fields.map((field, fieldIndex) => {
          if (!isRecord(field)) throw new Error(`embeds[${index}].fields[${fieldIndex}] must be an object`);
          const name = readString(field.name);
          const value = readString(field.value);
          if (!name) throw new Error(`embeds[${index}].fields[${fieldIndex}].name is required`);
          if (!value) throw new Error(`embeds[${index}].fields[${fieldIndex}].value is required`);
          return { name, value, inline: typeof field.inline === "boolean" ? field.inline : undefined };
        })
      : undefined;

    return {
      title: readString(item.title),
      description: readString(item.description),
      url: readString(item.url),
      color: typeof item.color === "number" ? item.color : undefined,
      timestamp: readString(item.timestamp),
      footer: isRecord(item.footer)
        ? {
            text: readString(item.footer.text) ?? (() => { throw new Error(`embeds[${index}].footer.text is required`); })(),
            iconUrl: readString(item.footer.iconUrl)
          }
        : undefined,
      author: isRecord(item.author)
        ? {
            name: readString(item.author.name) ?? (() => { throw new Error(`embeds[${index}].author.name is required`); })(),
            url: readString(item.author.url),
            iconUrl: readString(item.author.iconUrl)
          }
        : undefined,
      thumbnailUrl: readString(item.thumbnailUrl),
      imageUrl: readString(item.imageUrl),
      fields
    };
  });
}

async function handleSendToolCall(args: Record<string, unknown>, onSendDiscordMessage: StartMcpServerOptions["onSendDiscordMessage"]): Promise<unknown> {
  const content = typeof args.content === "string" ? args.content.trim() : "";
  const attachments = parseAttachments(args.attachments);
  const embeds = parseEmbeds(args.embeds);
  if (!content && !attachments && !embeds) {
    throw new Error("content, attachments, or embeds is required");
  }

  const channelId = readString(args.channelId);
  const bridgeRequestId = readString(args.bridgeRequestId);
  const replyToMessageId = readString(args.replyToMessageId);
  const chunks = content ? splitDiscordContent(content) : [""];
  const messageIds: string[] = [];

  for (const [index, chunk] of chunks.entries()) {
    const sentMessageIds = await onSendDiscordMessage(chunk, {
      channelId,
      bridgeRequestId,
      replyToMessageId,
      attachments: index === 0 ? attachments : undefined,
      embeds: index === 0 ? embeds : undefined
    });
    messageIds.push(...sentMessageIds);
  }

  return {
    sent: true,
    chunks: chunks.length,
    messageIds
  };
}

async function handleReplyToolCall(args: Record<string, unknown>, onSendDiscordMessage: StartMcpServerOptions["onSendDiscordMessage"]): Promise<unknown> {
  const content = typeof args.content === "string" ? args.content.trim() : "";
  const attachments = parseAttachments(args.attachments);
  const embeds = parseEmbeds(args.embeds);
  if (!content && !attachments && !embeds) {
    throw new Error("content, attachments, or embeds is required");
  }

  const messageId = readString(args.messageId);
  if (!messageId) {
    throw new Error("messageId is required");
  }

  const channelId = readString(args.channelId);
  const bridgeRequestId = readString(args.bridgeRequestId);
  const chunks = content ? splitDiscordContent(content) : [""];
  const messageIds: string[] = [];

  for (const [index, chunk] of chunks.entries()) {
    const sentMessageIds = await onSendDiscordMessage(chunk, {
      channelId,
      bridgeRequestId,
      replyToMessageId: messageId,
      attachments: index === 0 ? attachments : undefined,
      embeds: index === 0 ? embeds : undefined
    });
    messageIds.push(...sentMessageIds);
  }

  return {
    sent: true,
    chunks: chunks.length,
    repliedToMessageId: messageId,
    messageIds
  };
}

async function handleEditToolCall(args: Record<string, unknown>, onEditDiscordMessage: StartMcpServerOptions["onEditDiscordMessage"]): Promise<unknown> {
  const rawContent = typeof args.content === "string" ? args.content : undefined;
  const content = rawContent !== undefined ? rawContent.trim() : undefined;
  const embeds = parseEmbeds(args.embeds);
  if (rawContent === undefined && !embeds) {
    throw new Error("content or embeds is required");
  }
  if (content && content.length > 2000) {
    throw new Error("content exceeds Discord's 2000 character limit");
  }

  const messageId = readString(args.messageId);
  if (!messageId) {
    throw new Error("messageId is required");
  }

  const channelId = readString(args.channelId);
  const bridgeRequestId = readString(args.bridgeRequestId);
  await onEditDiscordMessage({ content, embeds, channelId, bridgeRequestId, messageId });

  return {
    edited: true,
    messageId
  };
}

async function handleDeleteToolCall(args: Record<string, unknown>, onDeleteDiscordMessage: StartMcpServerOptions["onDeleteDiscordMessage"]): Promise<unknown> {
  const messageId = typeof args.messageId === "string" && args.messageId.trim().length ? args.messageId.trim() : undefined;
  if (!messageId) {
    throw new Error("messageId is required");
  }

  const channelId = typeof args.channelId === "string" && args.channelId.trim().length ? args.channelId.trim() : undefined;
  const bridgeRequestId = typeof args.bridgeRequestId === "string" && args.bridgeRequestId.trim().length ? args.bridgeRequestId.trim() : undefined;
  await onDeleteDiscordMessage({ channelId, bridgeRequestId, messageId });

  return {
    deleted: true,
    messageId
  };
}

async function handleReactToolCall(args: Record<string, unknown>, onReactDiscordMessage: StartMcpServerOptions["onReactDiscordMessage"]): Promise<unknown> {
  const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";
  if (!emoji) {
    throw new Error("emoji is required");
  }

  const messageId = typeof args.messageId === "string" && args.messageId.trim().length ? args.messageId.trim() : undefined;
  if (!messageId) {
    throw new Error("messageId is required");
  }

  const channelId = typeof args.channelId === "string" && args.channelId.trim().length ? args.channelId.trim() : undefined;
  const bridgeRequestId = typeof args.bridgeRequestId === "string" && args.bridgeRequestId.trim().length ? args.bridgeRequestId.trim() : undefined;
  await onReactDiscordMessage({ emoji, channelId, bridgeRequestId, messageId });

  return {
    reacted: true,
    emoji,
    messageId
  };
}

async function handleGetChannelHistoryToolCall(args: Record<string, unknown>, onGetChannelHistory: StartMcpServerOptions["onGetChannelHistory"]): Promise<unknown> {
  const channelId = readString(args.channelId);
  if (!channelId) {
    throw new Error("channelId is required");
  }

  const limit = readLimit(args.limit, 50);
  const result = await onGetChannelHistory({ channelId, limit });
  return {
    channelId,
    limit,
    messages: result
  };
}

function readVoiceAction(value: unknown): VoiceControlAction {
  if (typeof value !== "string" || !value.trim().length) {
    throw new Error("action is required");
  }

  const action = value.trim();
  const allowed: VoiceControlAction[] = ["join", "pause", "resume", "skip", "stop", "leave", "current", "queue", "remove", "clear"];
  if (!allowed.includes(action as VoiceControlAction)) {
    throw new Error(`Unknown action: ${action}`);
  }

  return action as VoiceControlAction;
}

async function handleQueueVoiceTrackToolCall(args: Record<string, unknown>, onQueueVoiceTrack: StartMcpServerOptions["onQueueVoiceTrack"]): Promise<unknown> {
  const bridgeRequestId = readString(args.bridgeRequestId);
  if (!bridgeRequestId) {
    throw new Error("bridgeRequestId is required");
  }

  const url = readString(args.url);
  if (!url) {
    throw new Error("url is required");
  }

  const position = args.position === "front" ? "front" : "back";
  const result = await onQueueVoiceTrack({ bridgeRequestId, url, position });
  return result;
}

async function handleControlVoicePlaybackToolCall(args: Record<string, unknown>, onControlVoicePlayback: StartMcpServerOptions["onControlVoicePlayback"]): Promise<unknown> {
  const bridgeRequestId = readString(args.bridgeRequestId);
  if (!bridgeRequestId) {
    throw new Error("bridgeRequestId is required");
  }

  const action = readVoiceAction(args.action);
  const index = args.index == null ? undefined : Number(args.index);
  const result = await onControlVoicePlayback({ bridgeRequestId, action, ...(index == null || Number.isNaN(index) ? {} : { index }) });
  return result;
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
            name: SEND_TOOL_NAME,
            description: SEND_TOOL_DESCRIPTION,
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
                },
                replyToMessageId: {
                  type: "string",
                  description: "Optional Discord message id to reply to."
                },
                attachments: {
                  type: "array",
                  description: "Optional file attachments to upload with the message.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string", description: "Optional filename." },
                      url: { type: "string", description: "Public URL to fetch." },
                      contentType: { type: "string", description: "Optional content type hint." }
                    },
                    required: ["url"]
                  }
                },
                embeds: {
                  type: "array",
                  description: "Optional Discord embeds to include.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      title: { type: "string" },
                      description: { type: "string" },
                      url: { type: "string" },
                      color: { type: "number" },
                      timestamp: { type: "string" },
                      footer: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          text: { type: "string" },
                          iconUrl: { type: "string" }
                        },
                        required: ["text"]
                      },
                      author: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          name: { type: "string" },
                          url: { type: "string" },
                          iconUrl: { type: "string" }
                        },
                        required: ["name"]
                      },
                      thumbnailUrl: { type: "string" },
                      imageUrl: { type: "string" },
                      fields: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            name: { type: "string" },
                            value: { type: "string" },
                            inline: { type: "boolean" }
                          },
                          required: ["name", "value"]
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          {
            name: REPLY_TOOL_NAME,
            description: REPLY_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                content: {
                  type: "string",
                  description: "The Discord reply content."
                },
                channelId: {
                  type: "string",
                  description: "Optional Discord channel id to send to."
                },
                bridgeRequestId: {
                  type: "string",
                  description: "Optional bridge request id if the channel id is not provided."
                },
                messageId: {
                  type: "string",
                  description: "Discord message id to reply to."
                },
                attachments: {
                  type: "array",
                  description: "Optional file attachments to upload with the reply.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string" },
                      url: { type: "string" },
                      contentType: { type: "string" }
                    },
                    required: ["url"]
                  }
                },
                embeds: {
                  type: "array",
                  description: "Optional Discord embeds to include in the reply.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      title: { type: "string" },
                      description: { type: "string" },
                      url: { type: "string" },
                      color: { type: "number" },
                      timestamp: { type: "string" },
                      footer: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          text: { type: "string" },
                          iconUrl: { type: "string" }
                        },
                        required: ["text"]
                      },
                      author: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          name: { type: "string" },
                          url: { type: "string" },
                          iconUrl: { type: "string" }
                        },
                        required: ["name"]
                      },
                      thumbnailUrl: { type: "string" },
                      imageUrl: { type: "string" },
                      fields: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            name: { type: "string" },
                            value: { type: "string" },
                            inline: { type: "boolean" }
                          },
                          required: ["name", "value"]
                        }
                      }
                    }
                  }
                }
              },
              required: ["messageId"]
            }
          },
          {
            name: EDIT_TOOL_NAME,
            description: EDIT_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                content: {
                  type: "string",
                  description: "The new Discord message content."
                },
                channelId: {
                  type: "string",
                  description: "Optional Discord channel id to send to."
                },
                bridgeRequestId: {
                  type: "string",
                  description: "Optional bridge request id if the channel id is not provided."
                },
                messageId: {
                  type: "string",
                  description: "Discord message id to edit."
                },
                embeds: {
                  type: "array",
                  description: "Optional embeds to replace on the message.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      title: { type: "string" },
                      description: { type: "string" },
                      url: { type: "string" },
                      color: { type: "number" },
                      timestamp: { type: "string" },
                      footer: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          text: { type: "string" },
                          iconUrl: { type: "string" }
                        },
                        required: ["text"]
                      },
                      author: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          name: { type: "string" },
                          url: { type: "string" },
                          iconUrl: { type: "string" }
                        },
                        required: ["name"]
                      },
                      thumbnailUrl: { type: "string" },
                      imageUrl: { type: "string" },
                      fields: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            name: { type: "string" },
                            value: { type: "string" },
                            inline: { type: "boolean" }
                          },
                          required: ["name", "value"]
                        }
                      }
                    }
                  }
                }
              },
              required: ["messageId"]
            }
          },
          {
            name: DELETE_TOOL_NAME,
            description: DELETE_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                channelId: {
                  type: "string",
                  description: "Optional Discord channel id to send to."
                },
                bridgeRequestId: {
                  type: "string",
                  description: "Optional bridge request id if the channel id is not provided."
                },
                messageId: {
                  type: "string",
                  description: "Discord message id to delete."
                }
              },
              required: ["messageId"]
            }
          },
          {
            name: REACT_TOOL_NAME,
            description: REACT_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                emoji: {
                  type: "string",
                  description: "Emoji reaction to add."
                },
                channelId: {
                  type: "string",
                  description: "Optional Discord channel id if the channel is not implied."
                },
                bridgeRequestId: {
                  type: "string",
                  description: "Optional bridge request id if the channel id is not provided."
                },
                messageId: {
                  type: "string",
                  description: "Discord message id to react to."
                }
              },
              required: ["emoji", "messageId"]
            }
          },
          {
            name: HISTORY_TOOL_NAME,
            description: HISTORY_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                channelId: {
                  type: "string",
                  description: "Discord channel id to read history from."
                },
                limit: {
                  type: "number",
                  description: "Number of recent messages to fetch.",
                  default: 50,
                  minimum: 1,
                  maximum: 100
                }
              },
              required: ["channelId"]
            }
          },
          {
            name: QUEUE_VOICE_TOOL_NAME,
            description: QUEUE_VOICE_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                bridgeRequestId: {
                  type: "string",
                  description: "Bridge request id for the current Discord turn."
                },
                url: {
                  type: "string",
                  description: "Concrete YouTube video URL to queue."
                },
                position: {
                  type: "string",
                  enum: ["back", "front"],
                  default: "back",
                  description: "Queue position for the track."
                }
              },
              required: ["bridgeRequestId", "url"]
            }
          },
          {
            name: CONTROL_VOICE_TOOL_NAME,
            description: CONTROL_VOICE_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                bridgeRequestId: {
                  type: "string",
                  description: "Bridge request id for the current Discord turn."
                },
                action: {
                  type: "string",
                  enum: ["join", "pause", "resume", "skip", "stop", "leave", "current", "queue", "remove", "clear"],
                  description: "Voice action to perform."
                },
                index: {
                  type: "number",
                  description: "1-based queue index to remove."
                }
              },
              required: ["bridgeRequestId", "action"]
            }
          }
        ]
      }
    };
  }

  if (request.method === "tools/call") {
    const name = typeof request.params?.name === "string" ? request.params.name : "";
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

    if (name !== SEND_TOOL_NAME && name !== REPLY_TOOL_NAME && name !== EDIT_TOOL_NAME && name !== DELETE_TOOL_NAME && name !== REACT_TOOL_NAME && name !== HISTORY_TOOL_NAME && name !== QUEUE_VOICE_TOOL_NAME && name !== CONTROL_VOICE_TOOL_NAME) {
      return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }

    try {
      const result = name === SEND_TOOL_NAME
        ? await handleSendToolCall(args, options.onSendDiscordMessage)
        : name === REPLY_TOOL_NAME
          ? await handleReplyToolCall(args, options.onSendDiscordMessage)
          : name === EDIT_TOOL_NAME
            ? await handleEditToolCall(args, options.onEditDiscordMessage)
            : name === DELETE_TOOL_NAME
              ? await handleDeleteToolCall(args, options.onDeleteDiscordMessage)
              : name === REACT_TOOL_NAME
                ? await handleReactToolCall(args, options.onReactDiscordMessage)
                : name === HISTORY_TOOL_NAME
                  ? await handleGetChannelHistoryToolCall(args, options.onGetChannelHistory)
                  : name === QUEUE_VOICE_TOOL_NAME
                    ? await handleQueueVoiceTrackToolCall(args, options.onQueueVoiceTrack)
                    : await handleControlVoicePlaybackToolCall(args, options.onControlVoicePlayback);
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

export async function startMcpServer(options: StartMcpServerOptions): Promise<{ server: Server; port: number; }> {
  let listeningPort = options.port;
  const origin = `http://${options.host}:${options.port}`;
  const server = createServer(async (req, res) => {
    const forwardedProto = readHeaderValue(req.headers["x-forwarded-proto"]);
    const hostHeader = readHeaderValue(req.headers.host) || `${options.host}:${options.port}`;
    const requestOrigin = `${forwardedProto || "http"}://${hostHeader}`;
    const url = new URL(req.url ?? "/", requestOrigin);
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

    if (req.method === "GET" && matchesRoute(path, "/health")) {
      const installationCount = Object.keys(options.state.guildInstallations).length;
      const linkedUsers = Object.values(options.state.users).filter(user => user.encryptedPokeApiKey != null).length;
      writeJson(res, 200, {
        ok: true,
        mode: options.state.mode,
        ownerLinked: options.state.owner.encryptedPokeApiKey != null,
        linkedUsers,
        installedGuilds: installationCount,
        linkedTenants: (options.state.owner.encryptedPokeApiKey ? 1 : 0) + linkedUsers + installationCount
      });
      return;
    }

    const mountedPrefix =
      resolveMountedPrefix(path, "/mcp")
      ?? resolveMountedPrefix(path, "/sse")
      ?? (isMountedRoot(path) ? path.replace(/\/+$/, "") : null);

    if (req.method === "GET" && (matchesRoute(path, "/mcp") || matchesRoute(path, "/sse") || isMountedRoot(path))) {
      const sessionId = randomUUID();
      const endpoint = getMessageEndpoint(url.origin, mountedPrefix ?? "", sessionId);

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

    if (req.method === "POST" && (matchesRoute(path, "/messages") || matchesRoute(path, "/mcp"))) {
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

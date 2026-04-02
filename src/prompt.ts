import { buildPromptGuardrails } from "./bridgePolicy";
import type { DiscordRelayRequest } from "./types";

const MAX_CONTEXT_LINES = 40;

function formatAttachments(prefix: string, attachments: DiscordRelayRequest["attachments"]): string[] {
  if (!attachments.length) return [];

  return [prefix, ...attachments.map((attachment, index) => {
    const parts = [
      `${index + 1}. ${attachment.name}`,
      attachment.contentType ? `type: ${attachment.contentType}` : null,
      `size: ${attachment.size} bytes`,
      attachment.url
    ].filter((part): part is string => part != null);

    return parts.join(" | ");
  })];
}

function formatContextLine(index: number, entry: DiscordRelayRequest["contextMessages"][number]): string {
  const content = entry.content.trim() || "[no text]";
  const attachmentSuffix = entry.attachments.length
    ? ` [attachments: ${entry.attachments.map(attachment => attachment.name).join(", ")}]`
    : "";
  return `${index + 1}. ${entry.authorName}: ${content}${attachmentSuffix}`;
}

export function buildDiscordRelayPrompt(request: DiscordRelayRequest): string {
  const lines = [
    "You are responding to a Discord bridge request.",
    ...buildPromptGuardrails(),
    `Bridge request id: ${request.bridgeRequestId}`,
    `Tenant kind: ${request.tenant.kind}`,
    `Tenant id: ${request.tenant.id}`,
    `Mode: ${request.mode}`,
    `Reply target channel id: ${request.replyTarget.channelId}`,
    request.replyTarget.label ? `Reply target label: ${request.replyTarget.label}` : null,
    `Discord user id: ${request.discordUserId}`,
    `Discord channel id: ${request.discordChannelId}`,
    `Message id: ${request.discordMessageId}`,
    request.mode === "guild" ? "Treat guild conversations as server-scoped and follow the server's configured channels." : null,
    "",
    "User message:",
    request.prompt.trim(),
    ...formatAttachments("Attachments:", request.attachments),
    ...(request.contextMessages.length ? ["", "Recent channel context:", ...request.contextMessages.slice(-MAX_CONTEXT_LINES).map((entry, index) => formatContextLine(index, entry))] : []),
    "",
    "When you want to send a plain Discord message, call sendDiscordMessage with the same bridge request id and the reply target channel id from above. You may include attachments and embeds.",
    "When you want to reply to a specific Discord message, call replyToDiscordMessage with the message id you want to reply to. You may include attachments and embeds.",
    "When you want to edit a message the bridge already sent, call editDiscordMessage with the message id and new content or embeds.",
    "When you want to delete a message the bridge already sent, call deleteDiscordMessage with the message id.",
    "When you want to add a reaction to a specific Discord message, call reactToDiscordMessage with the emoji and message id."
  ];

  return lines.filter((line): line is string => line != null).join("\n");
}

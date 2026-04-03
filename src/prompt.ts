import { buildPromptGuardrails } from "./bridgePolicy";
import type { DiscordRelayRequest } from "./types";

const MAX_CONTEXT_LINES = 40;
const GUILD_PREFACE = [
  "You're chatting in a public server.",
  "Keep the tone natural and helpful, but avoid personal identity, account ownership, age, location, school, work, or private linkage details.",
  "If a request heads that way, steer back to something useful and general.",
  "If the user asks for music or voice playback, use the voice context, search for one concrete YouTube video URL yourself, and call the bridge voice tools instead of guessing."
].join(" ");

const DM_PREFACE = [
  "This is a direct message.",
  "Keep the same natural voice, and feel free to help with private setup and personal-use details while still avoiding revealing anything about other people."
].join(" ");

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

function formatVoiceContext(request: DiscordRelayRequest): string[] {
  if (!request.voiceContext) return [];

  const requester = request.voiceContext.requester;
  const bot = request.voiceContext.bot;

  return [
    "Voice context:",
    `Requester: ${requester.profileSummary} (user id: ${requester.userId})`,
    requester.voiceChannel.id
      ? `Requester voice channel: ${requester.voiceChannel.name ? `#${requester.voiceChannel.name}` : requester.voiceChannel.id}`
      : "Requester voice channel: none",
    bot
      ? `Bot voice channel: ${bot.voiceChannel.id ? (bot.voiceChannel.name ? `#${bot.voiceChannel.name}` : bot.voiceChannel.id) : "none"}`
      : "Bot voice channel: none",
    bot ? `Voice queue: ${bot.currentTrack ? `playing ${bot.currentTrack.title}` : "idle"}${bot.queue.length ? `, ${bot.queue.length} queued` : ""}` : "Voice queue: none"
  ];
}

function buildPromptWithPreface(preface: string, request?: DiscordRelayRequest): string {
  const lines: (string | null)[] = [preface, "You are responding to a Discord bridge request.", ...buildPromptGuardrails()];

  if (request) {
    lines.push(
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
      ...formatVoiceContext(request),
      ...formatAttachments("Attachments:", request.attachments)
    );

    if (request.contextMessages.length) {
      lines.push("", "Recent channel context:", ...request.contextMessages.slice(-MAX_CONTEXT_LINES).map((entry, index) => formatContextLine(index, entry)));
    }

    lines.push(
      "",
      "When you want to send a plain Discord message, call sendDiscordMessage with the same bridge request id and the reply target channel id from above. You may include attachments and embeds.",
      "When you want to reply to a specific Discord message, call replyToDiscordMessage with the message id you want to reply to. You may include attachments and embeds.",
      "When you want to edit a message the bridge already sent, call editDiscordMessage with the message id and new content or embeds.",
      "When you want to delete a message the bridge already sent, call deleteDiscordMessage with the message id.",
      "When you want to add a reaction to a specific Discord message, call reactToDiscordMessage with the emoji and message id.",
      "When you want to join or control voice playback, use queueVoiceTrack for a concrete YouTube video URL or controlVoicePlayback for join, pause, resume, skip, stop, leave, current, queue, remove, and clear."
    );
  } else {
    lines.push("", "Use the same direct style, but keep responses grounded and safe.");
  }

  return lines.filter((line): line is string => line != null).join("\n");
}

export function buildGuildPrompt(): string {
  return buildPromptWithPreface(GUILD_PREFACE);
}

export function buildDmPrompt(): string {
  return buildPromptWithPreface(DM_PREFACE);
}

export function buildDiscordRelayPrompt(request: DiscordRelayRequest): string {
  const preface = request.mode === "guild" ? GUILD_PREFACE : DM_PREFACE;
  return buildPromptWithPreface(preface, request);
}

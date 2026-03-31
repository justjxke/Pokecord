import { randomUUID } from "node:crypto";

import { ApplicationIntegrationType, Client, GatewayIntentBits, InteractionContextType, Partials, SlashCommandBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";

import { buildDiscordRelayPrompt } from "./prompt";
import { linkState, rememberMessageId, type BridgeState } from "./state";
import type { BridgeConfig, DiscordAttachmentContext, DiscordMessageContext, DiscordReplyTarget, DiscordRelayRequest, PokeSendResult } from "./types";

const SERVER_ATTACHMENT_OPTION_COUNT = 5;
const COMMAND_PREFIX = "!";

function isDmMessage(message: Message): boolean {
  return message.guildId == null;
}

function isSendableChannel(channel: unknown): channel is { send: (content: string) => Promise<unknown>; isTextBased: () => boolean; } {
  return typeof channel === "object" && channel != null && "send" in channel && typeof (channel as { send?: unknown }).send === "function";
}

function formatAttachment(attachment: { name: string; url: string; contentType?: string | null; size: number; }): DiscordAttachmentContext {
  return {
    name: attachment.name,
    url: attachment.url,
    contentType: attachment.contentType ?? null,
    size: attachment.size
  };
}

function getMessageAttachments(message: Message): DiscordAttachmentContext[] {
  return Array.from(message.attachments.values()).map(formatAttachment);
}

function getCommandAttachments(interaction: ChatInputCommandInteraction): DiscordAttachmentContext[] {
  const attachments: DiscordAttachmentContext[] = [];
  for (let index = 1; index <= SERVER_ATTACHMENT_OPTION_COUNT; index++) {
    const attachment = interaction.options.getAttachment(`attachment${index}`);
    if (attachment) attachments.push(formatAttachment(attachment));
  }
  return attachments;
}

function getChannelLabel(channel: Message["channel"] | ChatInputCommandInteraction["channel"]): string | null {
  if (!channel || !channel.isTextBased() || !("name" in channel) || typeof channel.name !== "string") return null;
  return `#${channel.name}`;
}

function buildReplyTarget(channelId: string, label: string | null, mode: DiscordReplyTarget["mode"]): DiscordReplyTarget {
  return {
    channelId,
    label,
    mode,
    createdAt: Date.now()
  };
}

async function sendChunks(channel: { send: (content: string) => Promise<unknown>; }, content: string): Promise<void> {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 2000) {
    const breakPoint = remaining.lastIndexOf("\n", 2000);
    const splitAt = breakPoint > 0 ? breakPoint : 2000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  if (remaining.length) chunks.push(remaining);

  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

function readCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;
  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? null;
}

async function collectChannelContext(channel: Message["channel"] | ChatInputCommandInteraction["channel"] | null | undefined, limit: number): Promise<DiscordMessageContext[]> {
  if (!channel || !channel.isTextBased() || !("messages" in channel)) return [];

  try {
    const fetched = await channel.messages.fetch({ limit });
    return Array.from(fetched.values())
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .map(message => ({
        authorId: message.author.id,
        authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        content: message.content,
        timestamp: new Date(message.createdTimestamp).toISOString(),
        attachments: Array.from(message.attachments.values()).map(formatAttachment)
      }));
  } catch {
    return [];
  }
}

async function buildDiscordRequestFromMessage(config: BridgeConfig, state: BridgeState, message: Message): Promise<DiscordRelayRequest> {
  const attachments = getMessageAttachments(message);
  const contextMessages = message.channelId === state.dmChannelId ? [] : await collectChannelContext(message.channel, config.contextMessageCount);
  const replyTarget = buildReplyTarget(message.channelId, isDmMessage(message) ? "Direct message" : getChannelLabel(message.channel), isDmMessage(message) ? "dm" : "guild");

  return {
    bridgeRequestId: randomUUID(),
    discordUserId: message.author.id,
    discordChannelId: message.channelId,
    discordMessageId: message.id,
    mode: isDmMessage(message) ? "dm" : "guild",
    prompt: message.content,
    replyTarget,
    attachments,
    contextMessages
  };
}

async function buildDiscordRequestFromInteraction(config: BridgeConfig, interaction: ChatInputCommandInteraction): Promise<DiscordRelayRequest> {
  const attachments = getCommandAttachments(interaction);
  const contextMessages = await collectChannelContext(interaction.channel, config.contextMessageCount);
  const replyTarget = buildReplyTarget(interaction.channelId, getChannelLabel(interaction.channel) ?? "Server channel", "guild");

  return {
    bridgeRequestId: randomUUID(),
    discordUserId: interaction.user.id,
    discordChannelId: interaction.channelId,
    discordMessageId: interaction.id,
    mode: "guild",
    prompt: interaction.options.getString("message", true),
    replyTarget,
    attachments,
    contextMessages
  };
}

function createSlashCommand() {
  const command = new SlashCommandBuilder()
    .setName("poke")
    .setDescription("Send a message to Poke.")
    .setContexts([InteractionContextType.Guild])
    .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
    .setDMPermission(false)
    .addStringOption(option => option
      .setName("message")
      .setDescription("The message to send to Poke.")
      .setRequired(true));

  for (let index = 1; index <= SERVER_ATTACHMENT_OPTION_COUNT; index++) {
    command.addAttachmentOption(option => option
      .setName(`attachment${index}`)
      .setDescription(index === 1 ? "Optional attachment." : `Optional attachment ${index}.`)
      .setRequired(false));
  }

  return command;
}

async function registerCommands(client: Client): Promise<void> {
  const application = await client.application?.fetch();
  if (!application) return;
  await application.commands.set([createSlashCommand()]);
}

export async function startDiscordBot(
  config: BridgeConfig,
  state: BridgeState,
  updateState: (next: BridgeState) => Promise<void>,
  onRelayRequest: (request: DiscordRelayRequest) => Promise<PokeSendResult>
): Promise<Client> {
  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
  });

  client.on("messageCreate", async message => {
    if (message.author.bot || !isDmMessage(message)) return;

    const command = readCommand(message.content);
    if (command === "status") {
      await message.channel.send(state.ownerUserId
        ? `Linked to <@${state.ownerUserId}>.`
        : "Not linked yet.");
      return;
    }

    if (command === "reset") {
      state.ownerUserId = null;
      state.dmChannelId = null;
      state.linkedAt = null;
      state.recentMessageIds = [];
      await updateState(state);
      await message.channel.send("Bridge reset.");
      return;
    }

    if (state.ownerUserId == null) {
      const linked = linkState(state, message.author.id, message.channel.id);
      Object.assign(state, linked);
      await updateState(state);
    }

    if (state.ownerUserId !== message.author.id) return;
    if (state.dmChannelId !== message.channel.id) {
      state.dmChannelId = message.channel.id;
      await updateState(state);
    }

    if (state.recentMessageIds.includes(message.id)) return;
    Object.assign(state, rememberMessageId(state, message.id));
    await updateState(state);

    try {
      const request = await buildDiscordRequestFromMessage(config, state, message);
      request.prompt = buildDiscordRelayPrompt(request);
      await onRelayRequest(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await message.channel.send(`Poke bridge failed: ${reason}`);
    }
  });

  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "poke") return;
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Use /poke in a server.", ephemeral: true });
      return;
    }
    if (state.ownerUserId == null) {
      await interaction.reply({ content: "DM me first so I know which account to use.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== state.ownerUserId) {
      await interaction.reply({ content: "This bridge is linked to another Discord account.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const request = await buildDiscordRequestFromInteraction(config, interaction);
      request.prompt = buildDiscordRelayPrompt(request);
      await onRelayRequest(request);
      await interaction.editReply("Sent to Poke.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`Poke bridge failed: ${reason}`);
    }
  });

  client.once("ready", async () => {
    try {
      await registerCommands(client);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stdout.write(`[poke-discord-bridge] Command registration failed: ${reason}\n`);
    }
  });

  await client.login(config.discordToken);
  return client;
}

export async function sendDiscordMessage(client: Client, channelId: string, content: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!isSendableChannel(channel) || !channel.isTextBased()) {
    throw new Error("Discord channel not found.");
  }

  await sendChunks(channel, content);
}

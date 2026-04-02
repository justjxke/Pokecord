import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  InteractionContextType,
  ModalBuilder,
  Partials,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction
} from "discord.js";

import {
  clearOwnerLink,
  clearUserLink,
  installGuildChannel,
  isGuildChannelAllowed,
  removeGuildInstallation,
  setGuildKey,
  setOwnerLink,
  setUserLink
} from "./bridgePolicy";
import { buildDiscordRelayPrompt } from "./prompt";
import { encryptTenantSecret } from "./tenantSecrets";
import { rememberMessageId, type BridgeState } from "./state";
import type {
  BridgeConfig,
  DiscordAttachmentContext,
  DiscordMessageContext,
  DiscordOutboundAttachment,
  DiscordOutboundEmbed,
  DiscordReplyTarget,
  DiscordRelayRequest,
  PokeSendResult,
  TenantReference
} from "./types";

const SERVER_ATTACHMENT_OPTION_COUNT = 5;
const COMMAND_NAME = "poke";
const COMMAND_PREFIX = "!";
const DM_KEY_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const DM_SETUP_MODAL_PREFIX = "poke-dm-setup";
const GUILD_SETUP_MODAL_PREFIX = "poke-guild-setup";

function isDmMessage(message: Message): boolean {
  return message.guildId == null;
}

function isSendableChannel(channel: unknown): channel is { send: (content: string | { content?: string; reply?: { messageReference: string; failIfNotExists: boolean; }; files?: AttachmentBuilder[]; embeds?: EmbedBuilder[]; }) => Promise<{ id: string }>; isTextBased: () => boolean; } {
  return typeof channel === "object" && channel != null && "send" in channel && typeof (channel as { send?: unknown }).send === "function";
}

function isTypingChannel(channel: unknown): channel is { isTextBased: () => boolean; sendTyping: () => Promise<unknown>; } {
  return typeof channel === "object" && channel != null && "sendTyping" in channel && typeof (channel as { sendTyping?: unknown }).sendTyping === "function";
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

function guessAttachmentName(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop();
    return name?.trim() || "attachment";
  } catch {
    return "attachment";
  }
}

async function buildAttachmentBuilders(attachments: DiscordOutboundAttachment[]): Promise<AttachmentBuilder[]> {
  const built = await Promise.all(attachments.map(async attachment => {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch attachment ${attachment.url}: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const name = attachment.name?.trim() || guessAttachmentName(attachment.url);
    return new AttachmentBuilder(buffer, { name });
  }));

  return built;
}

function buildEmbedBuilder(embed: DiscordOutboundEmbed): EmbedBuilder {
  const builder = new EmbedBuilder();

  if (embed.title) builder.setTitle(embed.title);
  if (embed.description) builder.setDescription(embed.description);
  if (embed.url) builder.setURL(embed.url);
  if (typeof embed.color === "number") builder.setColor(embed.color);
  if (embed.timestamp) builder.setTimestamp(new Date(embed.timestamp));
  if (embed.footer) builder.setFooter({ text: embed.footer.text, iconURL: embed.footer.iconUrl });
  if (embed.author) builder.setAuthor({ name: embed.author.name, url: embed.author.url, iconURL: embed.author.iconUrl });
  if (embed.thumbnailUrl) builder.setThumbnail(embed.thumbnailUrl);
  if (embed.imageUrl) builder.setImage(embed.imageUrl);
  if (embed.fields?.length) {
    builder.setFields(embed.fields.map(field => ({ name: field.name, value: field.value, inline: field.inline ?? false })));
  }

  return builder;
}

interface OutboundMessageOptions {
  replyToMessageId?: string;
  attachments?: DiscordOutboundAttachment[];
  embeds?: DiscordOutboundEmbed[];
}

async function sendChunks(channel: { send: (content: string | { content?: string; reply?: { messageReference: string; failIfNotExists: boolean; }; files?: AttachmentBuilder[]; embeds?: EmbedBuilder[]; }) => Promise<{ id: string }>; }, content: string, options: OutboundMessageOptions = {}): Promise<string[]> {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 2000) {
    const breakPoint = remaining.lastIndexOf("\n", 2000);
    const splitAt = breakPoint > 0 ? breakPoint : 2000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  if (remaining.length || !chunks.length) chunks.push(remaining);

  const builtAttachments = options.attachments?.length ? await buildAttachmentBuilders(options.attachments) : [];
  const builtEmbeds = options.embeds?.map(buildEmbedBuilder) ?? [];
  const messageIds: string[] = [];

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index] ?? "";
    const payload: { content?: string; reply?: { messageReference: string; failIfNotExists: boolean; }; files?: AttachmentBuilder[]; embeds?: EmbedBuilder[]; } = {};

    if (chunk.length) payload.content = chunk;
    if (index === 0 && options.replyToMessageId) {
      payload.reply = {
        messageReference: options.replyToMessageId,
        failIfNotExists: false
      };
    }
    if (index === 0 && builtAttachments.length) payload.files = builtAttachments;
    if (index === 0 && builtEmbeds.length) payload.embeds = builtEmbeds;

    const sent = await channel.send(payload);
    messageIds.push(sent.id);
  }

  return messageIds;
}

async function sendTextMessage(channel: Message["channel"] | ChatInputCommandInteraction["channel"], content: string): Promise<void> {
  if (!isSendableChannel(channel) || !channel.isTextBased()) {
    throw new Error("Discord channel not found.");
  }

  await channel.send(content);
}

function readCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;
  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? null;
}

function stripBotMentions(content: string, botUserId: string): string {
  const mentionPattern = new RegExp(`^<@!?${botUserId}>\\s*`, "g");
  return content.replace(mentionPattern, "").trim();
}

async function isReplyToBotMessage(message: Message, botUserId: string): Promise<boolean> {
  const referenceId = message.reference?.messageId;
  if (!referenceId || !message.channel || !message.channel.isTextBased() || !("messages" in message.channel)) return false;

  try {
    const referenced = await message.channel.messages.fetch(referenceId);
    return referenced.author.id === botUserId;
  } catch {
    return false;
  }
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

function isLikelyPokeApiKey(value: string): boolean {
  return DM_KEY_REGEX.test(value.trim());
}

function getTenantForDm(config: BridgeConfig, authorId: string): TenantReference {
  if (config.ownerDiscordUserId && config.ownerDiscordUserId === authorId) {
    return { kind: "owner", id: authorId };
  }

  return { kind: "user", id: authorId };
}

function getTenantForGuild(guildId: string): TenantReference {
  return { kind: "guild", id: guildId };
}

function buildSetupModal(customId: string, title: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  const apiKeyInput = new TextInputBuilder()
    .setCustomId("apiKey")
    .setLabel("Poke API key")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(8);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput));
  return modal;
}

export function buildGuildSetupModal(guildId: string, channelId: string, userId: string): ModalBuilder {
  return buildSetupModal(`${GUILD_SETUP_MODAL_PREFIX}:${guildId}:${channelId}:${userId}`, "Link Poke to this server");
}

export function buildDmSetupModal(userId: string): ModalBuilder {
  return buildSetupModal(`${DM_SETUP_MODAL_PREFIX}:${userId}`, "Link Poke to this account");
}

export function parseGuildSetupModal(customId: string): { guildId: string; channelId: string; userId: string; } | null {
  if (!customId.startsWith(`${GUILD_SETUP_MODAL_PREFIX}:`)) return null;
  const [, guildId, channelId, userId] = customId.split(":", 4);
  if (!guildId || !channelId || !userId) return null;
  return { guildId, channelId, userId };
}

export function parseDmSetupModal(customId: string): { userId: string; } | null {
  if (!customId.startsWith(`${DM_SETUP_MODAL_PREFIX}:`)) return null;
  const [, userId] = customId.split(":", 2);
  if (!userId) return null;
  return { userId };
}

function canManageGuildInstallation(interaction: ChatInputCommandInteraction | ModalSubmitInteraction): boolean {
  if (!interaction.inGuild()) return false;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  return interaction.memberPermissions?.has("Administrator") ?? false;
}

function formatOwnerStatus(state: BridgeState, config: BridgeConfig): string {
  const ownerLabel = config.ownerDiscordUserId ? `<@${config.ownerDiscordUserId}>` : "not configured";
  const linked = state.owner.encryptedPokeApiKey ? "linked" : "not linked";
  return `Owner namespace: ${ownerLabel} (${linked}).`;
}

function formatUserStatus(state: BridgeState): string {
  const count = Object.keys(state.users).length;
  return count ? `${count} linked user account${count === 1 ? "" : "s"}.` : "No linked user accounts yet.";
}

function formatGuildInstallationStatus(state: BridgeState, guildId: string): string {
  const installation = state.guildInstallations[guildId];
  if (!installation) return "This server is not set up yet.";
  if (!installation.allowedChannelIds.length) return "This server is installed, but no channels are enabled.";
  return `Enabled in ${installation.allowedChannelIds.map(channelId => `<#${channelId}>`).join(", ")}.`;
}

function formatTenantStatus(state: BridgeState, tenant: TenantReference, config: BridgeConfig): string {
  if (tenant.kind === "owner") return formatOwnerStatus(state, config);
  if (tenant.kind === "user") {
    const user = state.users[tenant.id];
    return user?.encryptedPokeApiKey ? `Linked to <@${tenant.id}>.` : `Not linked yet for <@${tenant.id}>.`;
  }

  const installation = state.guildInstallations[tenant.id];
  if (!installation) return "This server is not set up yet.";
  return formatGuildInstallationStatus(state, tenant.id);
}

function getTenantSecretState(state: BridgeState, tenant: TenantReference) {
  if (tenant.kind === "owner") return state.owner;
  if (tenant.kind === "user") return state.users[tenant.id] ?? null;
  return state.guildInstallations[tenant.id] ?? null;
}

export function buildSetupLinkedMessage(state: BridgeState, tenant: TenantReference, config: BridgeConfig): string {
  const status = formatTenantStatus(state, tenant, config);
  return `${status} Use /poke status if you want the full view, or /poke reset to relink.`;
}

function setTenantSecretState(state: BridgeState, tenant: TenantReference, encryptedPokeApiKey: ReturnType<typeof encryptTenantSecret>, discordUserId: string, dmChannelId: string): BridgeState {
  if (tenant.kind === "owner") {
    return setOwnerLink(state, discordUserId, dmChannelId, encryptedPokeApiKey);
  }

  if (tenant.kind === "user") {
    return setUserLink(state, discordUserId, dmChannelId, encryptedPokeApiKey);
  }

  const nextState = setGuildKey(state, tenant.id, discordUserId, encryptedPokeApiKey);
  return installGuildChannel(nextState, tenant.id, discordUserId, dmChannelId, encryptedPokeApiKey);
}

async function buildDiscordRequestFromMessage(config: BridgeConfig, state: BridgeState, message: Message, tenant: TenantReference, promptContent = message.content): Promise<DiscordRelayRequest> {
  const attachments = getMessageAttachments(message);
  const contextMessages = message.guildId == null ? [] : await collectChannelContext(message.channel, config.contextMessageCount);
  const replyTarget = buildReplyTarget(message.channelId, isDmMessage(message) ? "Direct message" : getChannelLabel(message.channel), isDmMessage(message) ? "dm" : "guild");

  return {
    bridgeRequestId: randomUUID(),
    tenant,
    discordUserId: message.author.id,
    discordChannelId: message.channelId,
    discordMessageId: message.id,
    mode: isDmMessage(message) ? "dm" : "guild",
    prompt: promptContent,
    replyTarget,
    attachments,
    contextMessages
  };
}

async function buildDiscordRequestFromInteraction(config: BridgeConfig, interaction: ChatInputCommandInteraction, tenant: TenantReference): Promise<DiscordRelayRequest> {
  const attachments = getCommandAttachments(interaction);
  const contextMessages = interaction.inGuild() ? await collectChannelContext(interaction.channel, config.contextMessageCount) : [];
  const replyTarget = buildReplyTarget(interaction.channelId, getChannelLabel(interaction.channel) ?? (interaction.inGuild() ? "Server channel" : "Direct message"), interaction.inGuild() ? "guild" : "dm");

  return {
    bridgeRequestId: randomUUID(),
    tenant,
    discordUserId: interaction.user.id,
    discordChannelId: interaction.channelId,
    discordMessageId: interaction.id,
    mode: interaction.inGuild() ? "guild" : "dm",
    prompt: interaction.options.getString("message", true),
    replyTarget,
    attachments,
    contextMessages
  };
}

async function respond(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, content: string): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply(content);
    return;
  }

  await interaction.reply({ content, ephemeral: interaction.inGuild() });
}

async function handleDmMessage(message: Message, config: BridgeConfig, state: BridgeState, updateState: (next: BridgeState) => Promise<void>, onRelayRequest: (request: DiscordRelayRequest) => Promise<PokeSendResult>): Promise<void> {
  const tenant = getTenantForDm(config, message.author.id);
  const command = readCommand(message.content);
  const tenantSecret = getTenantSecretState(state, tenant);

  if (command === "setup") {
    await sendTextMessage(message.channel, "Use /poke setup in this DM to open the link modal.");
    return;
  }

  if (command === "status") {
    await sendTextMessage(message.channel, formatTenantStatus(state, tenant, config));
    return;
  }

  if (command === "reset") {
    const nextState = tenant.kind === "owner" ? clearOwnerLink(state) : clearUserLink(state, message.author.id);
    Object.assign(state, nextState);
    await updateState(state);
    await sendTextMessage(message.channel, "Link cleared.");
    return;
  }

  if (!tenantSecret?.encryptedPokeApiKey) {
    await sendTextMessage(message.channel, "Use /poke setup in this DM to link this account.");
    return;
  }

  if (state.recentMessageIds.includes(message.id)) return;
  Object.assign(state, rememberMessageId(state, message.id));
  await updateState(state);

  const request = await buildDiscordRequestFromMessage(config, state, message, tenant, message.content);
  request.prompt = buildDiscordRelayPrompt(request);
  await onRelayRequest(request);
}

async function handleGuildMessage(message: Message, config: BridgeConfig, state: BridgeState, updateState: (next: BridgeState) => Promise<void>, onRelayRequest: (request: DiscordRelayRequest) => Promise<PokeSendResult>, botUserId: string): Promise<void> {
  if (!message.guildId) return;

  if (!isGuildChannelAllowed(state, message.guildId, message.channelId)) return;

  const tenant = getTenantForGuild(message.guildId);
  const tenantSecret = getTenantSecretState(state, tenant);
  const mentioned = message.mentions.users.has(botUserId);
  const repliedToBot = await isReplyToBotMessage(message, botUserId);
  if (!mentioned && !repliedToBot) return;

  if (!tenantSecret?.encryptedPokeApiKey) {
    await sendTextMessage(message.channel, "This server is not set up yet. An administrator should run /poke setup.");
    return;
  }

  if (state.recentMessageIds.includes(message.id)) return;
  Object.assign(state, rememberMessageId(state, message.id));
  await updateState(state);

  const promptContent = stripBotMentions(message.content, botUserId);
  const request = await buildDiscordRequestFromMessage(config, state, message, tenant, promptContent);
  request.prompt = buildDiscordRelayPrompt(request);
  await onRelayRequest(request);
}

async function registerCommands(client: Client): Promise<void> {
  const application = await client.application?.fetch();
  if (!application) return;
  await application.commands.set([createSlashCommand()]);
}

function createSlashCommand() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription("Send a message to Poke.");

  command
    .addSubcommand(subcommand => subcommand
      .setName("send")
      .setDescription("Send a message to Poke.")
      .addStringOption(option => option
        .setName("message")
        .setDescription("The message to send to Poke.")
        .setRequired(true))
      .addAttachmentOption(option => option.setName("attachment1").setDescription("Optional attachment.").setRequired(false))
      .addAttachmentOption(option => option.setName("attachment2").setDescription("Optional attachment 2.").setRequired(false))
      .addAttachmentOption(option => option.setName("attachment3").setDescription("Optional attachment 3.").setRequired(false))
      .addAttachmentOption(option => option.setName("attachment4").setDescription("Optional attachment 4.").setRequired(false))
      .addAttachmentOption(option => option.setName("attachment5").setDescription("Optional attachment 5.").setRequired(false)))
    .addSubcommand(subcommand => subcommand
      .setName("setup")
      .setDescription("Enable Poke in this server channel.")
      .addChannelOption(option => option
        .setName("channel")
        .setDescription("Channel to enable. Defaults to the current channel.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)))
    .addSubcommand(subcommand => subcommand
      .setName("status")
      .setDescription("Show the current bridge status."))
    .addSubcommand(subcommand => subcommand
      .setName("reset")
      .setDescription("Reset the current bridge link or server installation."));

  return command.setContexts([InteractionContextType.Guild, InteractionContextType.BotDM]).setIntegrationTypes([ApplicationIntegrationType.GuildInstall]).setDMPermission(true);
}

export async function startDiscordBot(
  config: BridgeConfig,
  state: BridgeState,
  updateState: (next: BridgeState) => Promise<void>,
  onRelayRequest: (request: DiscordRelayRequest) => Promise<PokeSendResult>
): Promise<Client> {
  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel]
  });

  client.on("messageCreate", async message => {
    if (message.author.bot) return;

    try {
      if (message.guildId == null) {
        await handleDmMessage(message, config, state, updateState, onRelayRequest);
        return;
      }

      const botUserId = client.user?.id;
      if (!botUserId) return;
      await handleGuildMessage(message, config, state, updateState, onRelayRequest, botUserId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await sendTextMessage(message.channel, `Poke bridge failed: ${reason}`);
    }
  });

  client.on("interactionCreate", async interaction => {
    try {
      if (interaction.isModalSubmit()) {
        const dmParsed = parseDmSetupModal(interaction.customId);
        if (dmParsed) {
          if (interaction.inGuild()) {
            await interaction.reply({ content: "Use /poke setup in a DM.", ephemeral: true });
            return;
          }
          if (interaction.user.id !== dmParsed.userId) {
            await interaction.reply({ content: "This setup session no longer matches.", ephemeral: true });
            return;
          }

          const apiKey = interaction.fields.getTextInputValue("apiKey").trim();
          if (!isLikelyPokeApiKey(apiKey)) {
            await interaction.reply({ content: "That does not look like a valid Poke API key.", ephemeral: true });
            return;
          }

          const encrypted = encryptTenantSecret(apiKey, config.stateSecret);
          const tenant = getTenantForDm(config, interaction.user.id);
          const dmChannelId = interaction.channelId ?? interaction.channel?.id ?? null;
          if (!dmChannelId) {
            await interaction.reply({ content: "Could not determine the DM channel for setup.", ephemeral: true });
            return;
          }

          const nextState = setTenantSecretState(state, tenant, encrypted, interaction.user.id, dmChannelId);
          Object.assign(state, nextState);
          await updateState(state);
          await interaction.reply({ content: `Linked ${tenant.kind === "owner" ? "owner" : "your account"} to Poke.`, ephemeral: false });
          return;
        }

        const parsed = parseGuildSetupModal(interaction.customId);
        if (!parsed) return;
        if (!interaction.inGuild()) {
          await interaction.reply({ content: "Use /poke setup in a server.", ephemeral: true });
          return;
        }
        if (!canManageGuildInstallation(interaction)) {
          await interaction.reply({ content: "Only the server owner or an administrator can set this up.", ephemeral: true });
          return;
        }
        if (interaction.guildId !== parsed.guildId || interaction.user.id !== parsed.userId) {
          await interaction.reply({ content: "This setup session no longer matches.", ephemeral: true });
          return;
        }

        const apiKey = interaction.fields.getTextInputValue("apiKey").trim();
        if (!isLikelyPokeApiKey(apiKey)) {
          await interaction.reply({ content: "That does not look like a valid Poke API key.", ephemeral: true });
          return;
        }

        const encrypted = encryptTenantSecret(apiKey, config.stateSecret);
        const nextState = installGuildChannel(state, parsed.guildId, interaction.user.id, parsed.channelId, encrypted);
        Object.assign(state, nextState);
        await updateState(state);
        await interaction.reply({ content: `Poke is now enabled in <#${parsed.channelId}>.`, ephemeral: true });
        return;
      }

      if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) return;

      const subcommand = interaction.options.getSubcommand();
      const tenant = interaction.inGuild() ? getTenantForGuild(interaction.guildId) : getTenantForDm(config, interaction.user.id);
      const tenantSecret = getTenantSecretState(state, tenant);

      if (subcommand === "setup") {
        if (tenantSecret?.encryptedPokeApiKey) {
          await respond(interaction, buildSetupLinkedMessage(state, tenant, config));
          return;
        }

        if (!interaction.inGuild()) {
          await interaction.showModal(buildDmSetupModal(interaction.user.id));
          return;
        }
        if (!canManageGuildInstallation(interaction)) {
          await interaction.reply({ content: "Only the server owner or an administrator can set this up.", ephemeral: true });
          return;
        }

        const channel = interaction.options.getChannel("channel");
        const targetChannelId = channel && typeof channel === "object" && "id" in channel ? channel.id : interaction.channelId;
        await interaction.showModal(buildGuildSetupModal(interaction.guildId, targetChannelId, interaction.user.id));
        return;
      }

      if (subcommand === "status") {
        await respond(interaction, formatTenantStatus(state, tenant, config));
        return;
      }

      if (subcommand === "reset") {
        if (tenant.kind === "owner") {
          Object.assign(state, clearOwnerLink(state));
          await updateState(state);
          await respond(interaction, "Owner link cleared.");
          return;
        }

        if (tenant.kind === "user") {
          Object.assign(state, clearUserLink(state, interaction.user.id));
          await updateState(state);
          await respond(interaction, "User link cleared.");
          return;
        }

        if (!interaction.inGuild()) {
          await respond(interaction, "Use /poke reset in a server.");
          return;
        }
        if (!canManageGuildInstallation(interaction)) {
          await respond(interaction, "Only the server owner or an administrator can reset the installation.");
          return;
        }

        Object.assign(state, removeGuildInstallation(state, interaction.guildId));
        await updateState(state);
        await respond(interaction, "Server installation removed.");
        return;
      }

      if (subcommand !== "send") return;

      if (interaction.inGuild() && !isGuildChannelAllowed(state, interaction.guildId, interaction.channelId)) {
        await respond(interaction, "This channel is not enabled for Poke yet.");
        return;
      }

      if (!tenantSecret?.encryptedPokeApiKey) {
        await respond(interaction, tenant.kind === "guild"
          ? "This server is not set up yet. An administrator should run /poke setup."
          : "Paste your Poke API key in this DM to link this account.");
        return;
      }

      await interaction.deferReply({ ephemeral: interaction.inGuild() });

      const request = await buildDiscordRequestFromInteraction(config, interaction as ChatInputCommandInteraction, tenant);
      request.prompt = buildDiscordRelayPrompt(request);
      await onRelayRequest(request);
      await interaction.editReply("Sent to Poke.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply(`Poke bridge failed: ${reason}`);
        } else {
          await interaction.reply({ content: `Poke bridge failed: ${reason}`, ephemeral: interaction.inGuild() });
        }
      }
    }
  });

  client.once("clientReady", async () => {
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

function isReactableMessage(message: unknown): message is { react: (emoji: string) => Promise<unknown>; } {
  return typeof message === "object" && message != null && "react" in message && typeof (message as { react?: unknown }).react === "function";
}

export async function sendDiscordMessage(client: Client, channelId: string, content: string, options: OutboundMessageOptions = {}): Promise<string[]> {
  const channel = await client.channels.fetch(channelId);
  if (!isSendableChannel(channel) || !channel.isTextBased()) {
    throw new Error("Discord channel not found.");
  }

  return sendChunks(channel, content, options);
}

export async function editDiscordMessage(client: Client, channelId: string, messageId: string, content?: string, embeds?: DiscordOutboundEmbed[]): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    throw new Error("Discord channel not found.");
  }

  const message = await channel.messages.fetch(messageId);
  await message.edit({ content, ...(embeds?.length ? { embeds: embeds.map(buildEmbedBuilder) } : {}) });
}

export async function deleteDiscordMessage(client: Client, channelId: string, messageId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    throw new Error("Discord channel not found.");
  }

  const message = await channel.messages.fetch(messageId);
  await message.delete();
}

export async function sendDiscordReaction(client: Client, channelId: string, messageId: string, emoji: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    throw new Error("Discord channel not found.");
  }

  const message = await channel.messages.fetch(messageId);
  if (!isReactableMessage(message)) {
    throw new Error("Discord message cannot be reacted to.");
  }

  await message.react(emoji);
}

export async function startTypingIndicator(client: Client, channelId: string): Promise<() => Promise<void>> {
  const channel = await client.channels.fetch(channelId);
  if (!isTypingChannel(channel)) {
    throw new Error("Discord channel not found.");
  }

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await channel.sendTyping();
    } catch {
      // Ignore typing failures; they are best-effort only.
    }
  };

  await tick();
  const interval = setInterval(() => void tick(), 8000);

  return async () => {
    stopped = true;
    clearInterval(interval);
  };
}

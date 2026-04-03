export type BridgeMode = "hybrid";
export type TenantKind = "owner" | "user" | "guild";

export interface EncryptedSecret {
  algorithm: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: number;
}

export interface OwnerBridgeState {
  discordUserId: string | null;
  dmChannelId: string | null;
  linkedAt: number | null;
  encryptedPokeApiKey: EncryptedSecret | null;
}

export interface UserBridgeState {
  dmChannelId: string | null;
  linkedAt: number;
  encryptedPokeApiKey: EncryptedSecret | null;
}

export interface GuildInstallationState {
  installedByUserId: string;
  installedAt: number;
  updatedAt: number;
  linkedAt: number | null;
  allowedChannelIds: string[];
  encryptedPokeApiKey: EncryptedSecret | null;
}

export interface BridgeConfig {
  discordToken: string;
  pokeApiBaseUrl: string;
  mcpHost: string;
  mcpPort: number;
  statePath: string;
  contextMessageCount: number;
  edgeSecret: string | null;
  stateSecret: string;
  ownerDiscordUserId: string | null;
  bridgeMode: BridgeMode;
}

export interface BridgeState {
  mode: BridgeMode;
  owner: OwnerBridgeState;
  users: Record<string, UserBridgeState>;
  guildInstallations: Record<string, GuildInstallationState>;
  recentMessageIds: string[];
}

export interface DiscordAttachmentContext {
  name: string;
  url: string;
  contentType: string | null;
  size: number;
}

export interface DiscordOutboundAttachment {
  name?: string;
  url: string;
  contentType?: string | null;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordOutboundEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; iconUrl?: string; };
  author?: { name: string; url?: string; iconUrl?: string; };
  thumbnailUrl?: string;
  imageUrl?: string;
  fields?: DiscordEmbedField[];
}

export interface DiscordMessageContext {
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  attachments: DiscordAttachmentContext[];
}

export interface DiscordReplyTarget {
  channelId: string;
  label: string | null;
  mode: "dm" | "guild";
  createdAt: number;
}

export interface TenantReference {
  kind: TenantKind;
  id: string;
}

export interface DiscordSentMessageRecord {
  channelId: string;
  messageIds: string[];
  updatedAt: number;
}

export interface DiscordRelayRequest {
  bridgeRequestId: string;
  tenant: TenantReference;
  discordUserId: string;
  discordChannelId: string;
  discordMessageId: string;
  mode: "dm" | "guild";
  prompt: string;
  replyTarget: DiscordReplyTarget;
  attachments: DiscordAttachmentContext[];
  contextMessages: DiscordMessageContext[];
}

export interface PokeSendResult {
  success: boolean;
  message?: string;
}

export interface BridgeConfig {
  discordToken: string;
  pokeApiKey: string;
  pokeApiBaseUrl: string;
  mcpHost: string;
  mcpPort: number;
  statePath: string;
  autoTunnel: boolean;
  contextMessageCount: number;
  edgeSecret: string | null;
}

export interface BridgeState {
  ownerUserId: string | null;
  dmChannelId: string | null;
  linkedAt: number | null;
  recentMessageIds: string[];
}

export interface DiscordAttachmentContext {
  name: string;
  url: string;
  contentType: string | null;
  size: number;
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

export interface DiscordRelayRequest {
  bridgeRequestId: string;
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

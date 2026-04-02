import { encryptTenantSecret, decryptTenantSecret } from "./tenantSecrets";
import type {
  BridgeMode,
  BridgeState,
  EncryptedSecret,
  GuildInstallationState,
  OwnerBridgeState,
  TenantReference,
  UserBridgeState
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map(entry => entry.trim());
}

function readEncryptedSecret(value: unknown): EncryptedSecret | null {
  if (!isRecord(value)) return null;
  if (value.algorithm !== "aes-256-gcm") return null;
  if (typeof value.salt !== "string" || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") {
    return null;
  }
  if (typeof value.createdAt !== "number") return null;

  return {
    algorithm: "aes-256-gcm",
    salt: value.salt,
    iv: value.iv,
    tag: value.tag,
    ciphertext: value.ciphertext,
    createdAt: value.createdAt
  };
}

function migrateLegacySecret(value: unknown, stateSecret: string, createdAt: number): EncryptedSecret | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return encryptTenantSecret(trimmed, stateSecret, createdAt);
}

function readOwnerDiscordUserId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function readDmChannelId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function normalizeOwnerState(value: unknown, fallback: OwnerBridgeState, stateSecret: string): OwnerBridgeState {
  if (!isRecord(value)) return fallback;
  const linkedAt = typeof value.linkedAt === "number" ? value.linkedAt : fallback.linkedAt;
  const encryptedPokeApiKey = readEncryptedSecret(value.encryptedPokeApiKey)
    ?? migrateLegacySecret(value.pokeApiKey, stateSecret, linkedAt ?? Date.now());

  return {
    discordUserId: readOwnerDiscordUserId(value.discordUserId ?? value.ownerUserId) ?? fallback.discordUserId,
    dmChannelId: readDmChannelId(value.dmChannelId) ?? fallback.dmChannelId,
    linkedAt,
    encryptedPokeApiKey
  };
}

function normalizeUserState(value: unknown, stateSecret: string): UserBridgeState | null {
  if (!isRecord(value)) return null;
  const dmChannelId = readDmChannelId(value.dmChannelId);
  const linkedAt = typeof value.linkedAt === "number" ? value.linkedAt : Date.now();
  const encryptedPokeApiKey = readEncryptedSecret(value.encryptedPokeApiKey)
    ?? migrateLegacySecret(value.pokeApiKey, stateSecret, linkedAt);

  if (!dmChannelId) return null;
  return {
    dmChannelId,
    linkedAt,
    encryptedPokeApiKey
  };
}

function normalizeGuildInstallation(value: unknown, stateSecret: string): GuildInstallationState | null {
  if (!isRecord(value)) return null;

  const installedByUserId = typeof value.installedByUserId === "string" ? value.installedByUserId : "";
  const installedAt = typeof value.installedAt === "number" ? value.installedAt : Date.now();
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : installedAt;
  const linkedAt = typeof value.linkedAt === "number" ? value.linkedAt : null;
  const allowedChannelIds = readStringArray(value.allowedChannelIds);
  const encryptedPokeApiKey = readEncryptedSecret(value.encryptedPokeApiKey)
    ?? migrateLegacySecret(value.pokeApiKey, stateSecret, linkedAt ?? installedAt);

  if (!installedByUserId) return null;

  return {
    installedByUserId,
    installedAt,
    updatedAt,
    linkedAt,
    allowedChannelIds,
    encryptedPokeApiKey
  };
}

function normalizeUsers(value: unknown, stateSecret: string): Record<string, UserBridgeState> {
  if (!isRecord(value)) return {};

  const users: Record<string, UserBridgeState> = {};
  for (const [userId, entry] of Object.entries(value)) {
    const normalized = normalizeUserState(entry, stateSecret);
    if (normalized) users[userId] = normalized;
  }

  return users;
}

function normalizeGuildInstallations(value: unknown, stateSecret: string): Record<string, GuildInstallationState> {
  if (!isRecord(value)) return {};

  const guildInstallations: Record<string, GuildInstallationState> = {};
  for (const [guildId, entry] of Object.entries(value)) {
    const normalized = normalizeGuildInstallation(entry, stateSecret);
    if (normalized) guildInstallations[guildId] = normalized;
  }

  return guildInstallations;
}

export function createDefaultState(_mode: BridgeMode = "hybrid"): BridgeState {
  return {
    mode: "hybrid",
    owner: {
      discordUserId: null,
      dmChannelId: null,
      linkedAt: null,
      encryptedPokeApiKey: null
    },
    users: {},
    guildInstallations: {},
    recentMessageIds: []
  };
}

export function normalizeState(raw: unknown, stateSecret: string, _fallbackMode: BridgeMode = "hybrid"): BridgeState {
  const fallback = createDefaultState();
  if (!isRecord(raw)) return fallback;

  const ownerSource = isRecord(raw.owner)
    ? raw.owner
    : isRecord(raw.private)
      ? raw.private
      : {
          ownerUserId: typeof raw.ownerUserId === "string" ? raw.ownerUserId : null,
          dmChannelId: typeof raw.dmChannelId === "string" ? raw.dmChannelId : null,
          linkedAt: typeof raw.linkedAt === "number" ? raw.linkedAt : null,
          pokeApiKey: typeof raw.pokeApiKey === "string" ? raw.pokeApiKey : null,
          encryptedPokeApiKey: isRecord(raw.encryptedPokeApiKey) ? raw.encryptedPokeApiKey : null
        };

  const owner = normalizeOwnerState(ownerSource, fallback.owner, stateSecret);

  return {
    mode: "hybrid",
    owner,
    users: normalizeUsers(raw.users, stateSecret),
    guildInstallations: normalizeGuildInstallations(raw.guildInstallations, stateSecret),
    recentMessageIds: readStringArray(raw.recentMessageIds)
  };
}

export function setOwnerLink(state: BridgeState, discordUserId: string, dmChannelId: string, encryptedPokeApiKey: EncryptedSecret): BridgeState {
  return {
    ...state,
    owner: {
      discordUserId,
      dmChannelId,
      linkedAt: Date.now(),
      encryptedPokeApiKey
    }
  };
}

export function clearOwnerLink(state: BridgeState): BridgeState {
  return {
    ...state,
    owner: {
      discordUserId: null,
      dmChannelId: null,
      linkedAt: null,
      encryptedPokeApiKey: null
    },
    recentMessageIds: []
  };
}

export function setUserLink(state: BridgeState, userId: string, dmChannelId: string, encryptedPokeApiKey: EncryptedSecret): BridgeState {
  return {
    ...state,
    users: {
      ...state.users,
      [userId]: {
        dmChannelId,
        linkedAt: Date.now(),
        encryptedPokeApiKey
      }
    }
  };
}

export function clearUserLink(state: BridgeState, userId: string): BridgeState {
  if (!state.users[userId]) return state;

  const users = { ...state.users };
  delete users[userId];
  return {
    ...state,
    users
  };
}

export function installGuildChannel(state: BridgeState, guildId: string, installedByUserId: string, channelId: string, encryptedPokeApiKey: EncryptedSecret): BridgeState {
  const existing = state.guildInstallations[guildId];
  const allowedChannelIds = existing?.allowedChannelIds ?? [];
  const nextAllowedChannelIds = Array.from(new Set([channelId, ...allowedChannelIds]));

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        installedByUserId,
        installedAt: existing?.installedAt ?? Date.now(),
        updatedAt: Date.now(),
        linkedAt: existing?.linkedAt ?? Date.now(),
        allowedChannelIds: nextAllowedChannelIds,
        encryptedPokeApiKey
      }
    }
  };
}

export function setGuildKey(state: BridgeState, guildId: string, installedByUserId: string, encryptedPokeApiKey: EncryptedSecret): BridgeState {
  const existing = state.guildInstallations[guildId];
  if (!existing) {
    return {
      ...state,
      guildInstallations: {
        ...state.guildInstallations,
        [guildId]: {
          installedByUserId,
          installedAt: Date.now(),
          updatedAt: Date.now(),
          linkedAt: Date.now(),
          allowedChannelIds: [],
          encryptedPokeApiKey
        }
      }
    };
  }

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        ...existing,
        installedByUserId,
        updatedAt: Date.now(),
        linkedAt: existing.linkedAt ?? Date.now(),
        encryptedPokeApiKey
      }
    }
  };
}

export function removeGuildInstallation(state: BridgeState, guildId: string): BridgeState {
  if (!state.guildInstallations[guildId]) return state;

  const nextGuildInstallations = { ...state.guildInstallations };
  delete nextGuildInstallations[guildId];

  return {
    ...state,
    guildInstallations: nextGuildInstallations
  };
}

export function isGuildChannelAllowed(state: BridgeState, guildId: string, channelId: string): boolean {
  const installation = state.guildInstallations[guildId];
  if (!installation) return false;
  if (!installation.allowedChannelIds.length) return false;
  return installation.allowedChannelIds.includes(channelId);
}

export function buildPromptGuardrails(): string[] {
  return [
    "do not reveal the operator's identity, private account details, or internal bridge state.",
    "only use information that appears in this request or the attached Discord context.",
    "treat tenant-specific data as scoped to the current Discord user or guild."
  ];
}

export function getTenantPokeSecret(state: BridgeState, tenant: TenantReference, stateSecret: string): string | null {
  if (tenant.kind === "owner") {
    return state.owner.encryptedPokeApiKey ? decryptTenantSecret(state.owner.encryptedPokeApiKey, stateSecret) : null;
  }

  if (tenant.kind === "user") {
    const user = state.users[tenant.id];
    return user?.encryptedPokeApiKey ? decryptTenantSecret(user.encryptedPokeApiKey, stateSecret) : null;
  }

  const guildInstallation = state.guildInstallations[tenant.id];
  return guildInstallation?.encryptedPokeApiKey ? decryptTenantSecret(guildInstallation.encryptedPokeApiKey, stateSecret) : null;
}

export function getTenantDisplayLabel(state: BridgeState, tenant: TenantReference): string {
  if (tenant.kind === "owner") return "owner";
  if (tenant.kind === "user") return `user ${tenant.id}`;
  return `guild ${tenant.id}`;
}


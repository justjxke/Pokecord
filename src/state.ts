import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BridgeState } from "./types";

export type { BridgeState } from "./types";

const DEFAULT_STATE: BridgeState = {
  ownerUserId: null,
  dmChannelId: null,
  linkedAt: null,
  recentMessageIds: []
};

export function getStatePath(): string {
  return process.env.POKE_DISCORD_BRIDGE_STATE_PATH
    ?? join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config"), "poke-discord-bridge", "state.json");
}

export function createDefaultState(): BridgeState {
  return {
    ownerUserId: DEFAULT_STATE.ownerUserId,
    dmChannelId: DEFAULT_STATE.dmChannelId,
    linkedAt: DEFAULT_STATE.linkedAt,
    recentMessageIds: [...DEFAULT_STATE.recentMessageIds]
  };
}

export async function loadState(path = getStatePath()): Promise<BridgeState> {
  try {
    await access(path);
  } catch {
    return createDefaultState();
  }

  const raw = await readFile(path, "utf8");

  let parsed: Partial<BridgeState>;
  try {
    parsed = JSON.parse(raw) as Partial<BridgeState>;
  } catch {
    return createDefaultState();
  }

  return {
    ownerUserId: typeof parsed.ownerUserId === "string" ? parsed.ownerUserId : null,
    dmChannelId: typeof parsed.dmChannelId === "string" ? parsed.dmChannelId : null,
    linkedAt: typeof parsed.linkedAt === "number" ? parsed.linkedAt : null,
    recentMessageIds: Array.isArray(parsed.recentMessageIds)
      ? parsed.recentMessageIds.filter((id): id is string => typeof id === "string")
      : []
  };
}

export async function saveState(state: BridgeState, path = getStatePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function rememberMessageId(state: BridgeState, messageId: string): BridgeState {
  const recentMessageIds = state.recentMessageIds.filter(id => id !== messageId);
  recentMessageIds.unshift(messageId);
  return {
    ...state,
    recentMessageIds: recentMessageIds.slice(0, 100)
  };
}

export function hasSeenMessageId(state: BridgeState, messageId: string): boolean {
  return state.recentMessageIds.includes(messageId);
}

export function linkState(state: BridgeState, userId: string, channelId: string): BridgeState {
  return {
    ...state,
    ownerUserId: userId,
    dmChannelId: channelId,
    linkedAt: Date.now()
  };
}

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createDefaultState, normalizeState } from "./bridgePolicy";
import type { BridgeState } from "./types";

export type { BridgeState } from "./types";

export function getStatePath(): string {
  return process.env.POKE_DISCORD_BRIDGE_STATE_PATH
    ?? join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config"), "poke-discord-bridge", "state.json");
}

export { createDefaultState };

export async function loadState(path = getStatePath(), stateSecret = ""): Promise<BridgeState> {
  try {
    await access(path);
  } catch {
    return createDefaultState();
  }

  const raw = await readFile(path, "utf8");

  try {
    return normalizeState(JSON.parse(raw), stateSecret);
  } catch {
    return createDefaultState();
  }
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

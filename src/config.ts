import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { BridgeConfig } from "./types";

const DEFAULT_MCP_PORT = 3000;
const DEFAULT_POKE_API_BASE_URL = "https://poke.com/api/v1";
const DEFAULT_MCP_HOST = "0.0.0.0";
const DEFAULT_CONTEXT_MESSAGE_COUNT = 40;
const DOTENV_PATH = join(process.cwd(), ".env");

function loadDotEnv(path = DOTENV_PATH): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = value == null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): BridgeConfig {
  loadDotEnv();
  const discordToken = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN ?? "";
  const statePath = process.env.POKE_DISCORD_BRIDGE_STATE_PATH
    ?? join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config"), "poke-discord-bridge", "state.json");
  const edgeSecret = process.env.POKE_EDGE_SECRET?.trim() || "";
  const stateSecret = process.env.POKE_STATE_SECRET?.trim() || edgeSecret;
  const ownerDiscordUserId = process.env.POKE_OWNER_DISCORD_USER_ID?.trim() || null;

  if (!discordToken.trim()) throw new Error("Missing DISCORD_BOT_TOKEN.");
  if (!edgeSecret) throw new Error("Missing POKE_EDGE_SECRET.");
  if (!stateSecret) throw new Error("Missing POKE_STATE_SECRET.");

  return {
    discordToken: discordToken.trim(),
    pokeApiBaseUrl: process.env.POKE_API_BASE_URL ?? DEFAULT_POKE_API_BASE_URL,
    mcpHost: process.env.POKE_MCP_HOST ?? DEFAULT_MCP_HOST,
    mcpPort: readNumber(process.env.POKE_MCP_PORT, DEFAULT_MCP_PORT),
    statePath,
    contextMessageCount: readNumber(process.env.POKE_CONTEXT_MESSAGES, DEFAULT_CONTEXT_MESSAGE_COUNT),
    edgeSecret,
    stateSecret,
    ownerDiscordUserId,
    bridgeMode: "hybrid"
  };
}

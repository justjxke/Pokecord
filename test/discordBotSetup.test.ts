import assert from "node:assert/strict";
import test from "node:test";

import { buildDmSetupModal, buildGuildSetupModal, buildSetupLinkedMessage, parseDmSetupModal, parseGuildSetupModal } from "../src/discordBot";

test("builds a DM setup modal that links the current user", () => {
  const modal = buildDmSetupModal("user-123");
  assert.equal(modal.data.custom_id, "poke-dm-setup:user-123");
  assert.equal(modal.data.title, "Link Poke to this account");
});

test("builds a guild setup modal that keeps the server context", () => {
  const modal = buildGuildSetupModal("guild-1", "channel-1", "user-123");
  assert.equal(modal.data.custom_id, "poke-guild-setup:guild-1:channel-1:user-123");
  assert.equal(modal.data.title, "Link Poke to this server");
});

test("parses DM and guild setup modal ids", () => {
  assert.deepEqual(parseDmSetupModal("poke-dm-setup:user-123"), { userId: "user-123" });
  assert.deepEqual(parseGuildSetupModal("poke-guild-setup:guild-1:channel-1:user-123"), {
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-123"
  });
});

test("builds a linked setup message", () => {
  const message = buildSetupLinkedMessage({
    mode: "hybrid",
    owner: {
      discordUserId: "user-123",
      dmChannelId: "dm-1",
      linkedAt: 123,
      encryptedPokeApiKey: {
        algorithm: "aes-256-gcm",
        salt: "salt",
        iv: "iv",
        tag: "tag",
        ciphertext: "ciphertext",
        createdAt: 123
      }
    },
    users: {},
    guildInstallations: {},
    recentMessageIds: []
  }, { kind: "owner", id: "user-123" }, {
    discordToken: "token",
    pokeApiBaseUrl: "https://poke.com/api/v1",
    mcpHost: "0.0.0.0",
    mcpPort: 3000,
    statePath: "/data/state.json",
    autoTunnel: false,
    contextMessageCount: 40,
    edgeSecret: "secret",
    stateSecret: "secret",
    ownerDiscordUserId: "user-123",
    bridgeMode: "hybrid"
  });

  assert.equal(message, "Owner namespace: <@user-123> (linked). Use /poke status if you want the full view, or /poke reset to relink.");
});

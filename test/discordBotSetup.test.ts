import assert from "node:assert/strict";
import test from "node:test";

import { buildDmSetupModal, buildGuildSetupModal, parseDmSetupModal, parseGuildSetupModal } from "../src/discordBot";

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

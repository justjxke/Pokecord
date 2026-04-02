import assert from "node:assert/strict";
import test from "node:test";

import { decryptTenantSecret } from "../src/tenantSecrets";
import { normalizeState } from "../src/bridgePolicy";

test("normalizes legacy bridge state into hybrid tenant state with encrypted secrets", () => {
  const state = normalizeState({
    mode: "private",
    private: {
      ownerUserId: "owner-user",
      dmChannelId: "dm-channel",
      linkedAt: 123,
      pokeApiKey: "owner-key"
    },
    guildInstallations: {
      "guild-1": {
        installedByUserId: "admin-user",
        installedAt: 456,
        updatedAt: 789,
        linkedAt: 111,
        allowedChannelIds: ["channel-1"],
        pokeApiKey: "guild-key"
      }
    },
    recentMessageIds: ["message-1"]
  }, "master-secret");

  assert.equal(state.mode, "hybrid");
  assert.equal(state.owner.discordUserId, "owner-user");
  assert.equal(state.owner.dmChannelId, "dm-channel");
  assert.equal(state.owner.linkedAt, 123);
  assert.equal(decryptTenantSecret(state.owner.encryptedPokeApiKey!, "master-secret"), "owner-key");
  assert.equal(state.guildInstallations["guild-1"]?.installedByUserId, "admin-user");
  assert.equal(state.guildInstallations["guild-1"]?.linkedAt, 111);
  assert.equal(decryptTenantSecret(state.guildInstallations["guild-1"]!.encryptedPokeApiKey!, "master-secret"), "guild-key");
  assert.deepEqual(state.recentMessageIds, ["message-1"]);
});

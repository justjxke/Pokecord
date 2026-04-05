import { describe, expect, test } from "bun:test";

import { buildLavalinkConfig } from "../src/launchConfig";

describe("buildLavalinkConfig", () => {
  test("disables legacy youtube source under lavalink.server.sources", () => {
    const config = buildLavalinkConfig("super-secret");

    expect(config).toContain("lavalink:");
    expect(config).toContain("  server:");
    expect(config).toContain("    sources:");
    expect(config).toContain("      youtube: false");
  });

  test("includes poToken configuration when provided", () => {
    const config = buildLavalinkConfig("super-secret", {
      youtubePoToken: "po-token",
      youtubeVisitorData: "visitor-data"
    });

    expect(config).toContain("    pot:");
    expect(config).toContain('      token: "po-token"');
    expect(config).toContain('      visitorData: "visitor-data"');
  });

  test("includes oauth configuration when provided", () => {
    const config = buildLavalinkConfig("super-secret", {
      youtubeOauthRefreshToken: "refresh-token",
      youtubeOauthSkipInitialization: true
    });

    expect(config).toContain("    oauth:");
    expect(config).toContain("      enabled: true");
    expect(config).toContain('      refreshToken: "refresh-token"');
    expect(config).toContain("      skipInitialization: true");
  });
});

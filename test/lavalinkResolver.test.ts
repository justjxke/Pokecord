import { describe, expect, test } from "bun:test";

import { resolveLavalinkTrackIdentifier } from "../src/lavalinkResolver";

describe("resolveLavalinkTrackIdentifier", () => {
  test("resolves spotify tracks to a direct youtube watch url", async () => {
    const playDl = {
      yt_validate: () => false,
      sp_validate: () => "track" as const,
      spotify: async () => ({
        type: "track" as const,
        name: "Uptown Funk",
        url: "https://open.spotify.com/track/spotify-track-id",
        artists: [{ name: "Mark Ronson" }, { name: "Bruno Mars" }]
      }),
      search: async () => [
        {
          url: "https://www.youtube.com/watch?v=OPf0YbXqDm0",
          title: "Mark Ronson - Uptown Funk ft. Bruno Mars (Official Video)",
          channel: { name: "Mark Ronson" }
        }
      ]
    };

    await expect(resolveLavalinkTrackIdentifier(playDl as never, "https://open.spotify.com/track/spotify-track-id")).resolves.toBe(
      "https://www.youtube.com/watch?v=OPf0YbXqDm0"
    );
  });

  test("prefers the youtube result that matches the spotify track title", async () => {
    const playDl = {
      yt_validate: () => false,
      sp_validate: () => "track" as const,
      spotify: async () => ({
        type: "track" as const,
        name: "Uptown Funk",
        url: "https://open.spotify.com/track/spotify-track-id",
        artists: [{ name: "Mark Ronson" }, { name: "Bruno Mars" }]
      }),
      search: async () => [
        {
          url: "https://www.youtube.com/watch?v=bad-match",
          title: "Random Bruno Mars Interview",
          channel: { name: "Random Channel" }
        },
        {
          url: "https://www.youtube.com/watch?v=OPf0YbXqDm0",
          title: "Mark Ronson - Uptown Funk ft. Bruno Mars (Official Video)",
          channel: { name: "Mark Ronson" }
        }
      ]
    };

    await expect(resolveLavalinkTrackIdentifier(playDl as never, "https://open.spotify.com/track/spotify-track-id")).resolves.toBe(
      "https://www.youtube.com/watch?v=OPf0YbXqDm0"
    );
  });
});

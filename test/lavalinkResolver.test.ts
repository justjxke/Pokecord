import { describe, expect, test } from "bun:test";

import { resolveLavalinkTrackIdentifier } from "../src/lavalinkResolver";

const spotifyConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  market: "US"
};

describe("resolveLavalinkTrackIdentifier", () => {
  test("resolves direct youtube video urls to canonical watch urls", async () => {
    const playDl = {
      yt_validate: () => "video" as const,
      sp_validate: () => false,
      video_info: async () => ({
        format: [
          {
            url: "https://rr2---sn-8pgbpohxqp5-aiges.googlevideo.com/videoplayback?itag=18",
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            audioChannels: 2,
            bitrate: 477506,
            qualityLabel: "360p"
          }
        ]
      }),
      decipher_info: async <T>(data: T) => data,
      search: async () => []
    };

    await expect(resolveLavalinkTrackIdentifier(playDl as never, "https://www.youtube.com/watch?v=OPf0YbXqDm0")).resolves.toBe(
      "https://www.youtube.com/watch?v=OPf0YbXqDm0"
    );
  });

  test("resolves spotify tracks to ranked youtube watch urls", async () => {
    const playDl = {
      yt_validate: () => false,
      sp_validate: () => "track" as const,
      search: async () => [
        {
          url: "https://www.youtube.com/watch?v=OPf0YbXqDm0",
          title: "Mark Ronson - Uptown Funk ft. Bruno Mars (Official Video)",
          channel: { name: "Mark Ronson" }
        }
      ],
      video_info: async () => ({
        format: [
          {
            url: "https://rr2---sn-8pgbpohxqp5-aiges.googlevideo.com/videoplayback?itag=18",
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            audioChannels: 2,
            bitrate: 477506,
            qualityLabel: "360p"
          }
        ]
      }),
      decipher_info: async <T>(data: T) => data
    };

    const spotifyTrackFetcher = async () => ({
      id: "spotify-track-id",
      name: "Uptown Funk",
      url: "https://open.spotify.com/track/spotify-track-id",
      artists: [{ name: "Mark Ronson" }, { name: "Bruno Mars" }]
    });

    await expect(
      resolveLavalinkTrackIdentifier(playDl as never, "https://open.spotify.com/track/spotify-track-id", spotifyConfig, spotifyTrackFetcher)
    ).resolves.toBe("https://www.youtube.com/watch?v=OPf0YbXqDm0");
  });

  test("returns best-ranked youtube result url for spotify tracks", async () => {
    const playDl = {
      yt_validate: () => false,
      sp_validate: () => "track" as const,
      search: async () => [
        {
          url: "https://www.youtube.com/watch?v=OPf0YbXqDm0",
          title: "Mark Ronson - Uptown Funk ft. Bruno Mars (Official Video)",
          channel: { name: "Mark Ronson" }
        },
        {
          url: "https://www.youtube.com/watch?v=bad-match",
          title: "Random Bruno Mars Interview",
          channel: { name: "Random Channel" }
        }
      ],
      video_info: async (url: string) => ({
        format: url.includes("bad-match")
          ? []
          : [
              {
                url: `${url}&direct=1`,
                mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
                audioChannels: 2,
                bitrate: 477506,
                qualityLabel: "360p"
              }
            ]
      }),
      decipher_info: async <T>(data: T) => data
    };

    const spotifyTrackFetcher = async () => ({
      id: "spotify-track-id",
      name: "Uptown Funk",
      url: "https://open.spotify.com/track/spotify-track-id",
      artists: [{ name: "Mark Ronson" }, { name: "Bruno Mars" }]
    });

    await expect(
      resolveLavalinkTrackIdentifier(playDl as never, "https://open.spotify.com/track/spotify-track-id", spotifyConfig, spotifyTrackFetcher)
    ).resolves.toBe("https://www.youtube.com/watch?v=OPf0YbXqDm0");
  });

  test("normalizes youtu.be short links to canonical youtube watch urls", async () => {
    const playDl = {
      yt_validate: () => "video" as const,
      sp_validate: () => false,
      video_info: async () => ({ format: [] }),
      decipher_info: async <T>(data: T) => data,
      search: async () => []
    };

    const trackUrl = "https://youtu.be/cache-test-123?t=5";
    const first = await resolveLavalinkTrackIdentifier(playDl as never, trackUrl);
    const second = await resolveLavalinkTrackIdentifier(playDl as never, trackUrl);

    expect(first).toBe("https://www.youtube.com/watch?v=cache-test-123");
    expect(second).toBe(first);
  });
});

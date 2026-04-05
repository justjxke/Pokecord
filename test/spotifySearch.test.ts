import { describe, expect, test } from "bun:test";

import { fetchSpotifyTrackMetadata, parseSpotifySearchResponse } from "../src/spotifySearch";

describe("parseSpotifySearchResponse", () => {
  test("parses track search results", () => {
    const results = parseSpotifySearchResponse(
      JSON.stringify({
        tracks: {
          items: [
            {
              id: "1",
              name: "Uptown Funk",
              external_urls: { spotify: "https://open.spotify.com/track/1" },
              artists: [{ name: "Mark Ronson" }, { name: "Bruno Mars" }]
            }
          ]
        }
      }),
      200
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "1",
      name: "Uptown Funk",
      url: "https://open.spotify.com/track/1"
    });
  });

  test("throws on malformed search responses", () => {
    expect(() => parseSpotifySearchResponse(JSON.stringify({ foo: "bar" }), 200)).toThrow(
      "Spotify search returned an unexpected response"
    );
  });

  test("throws on api error payloads", () => {
    expect(() => parseSpotifySearchResponse(JSON.stringify({ error: { status: 403, message: "Forbidden" } }), 403)).toThrow(
      "Spotify search failed (403): Forbidden"
    );
  });

  test("fetches spotify track metadata from the web api", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("accounts.spotify.com/api/token")) {
        return new Response(JSON.stringify({
          access_token: "access-token",
          token_type: "Bearer",
          expires_in: 3600
        }), { status: 200 });
      }

      if (url.includes("api.spotify.com/v1/tracks/")) {
        return new Response(JSON.stringify({
          id: "1",
          name: "Uptown Funk",
          external_urls: { spotify: "https://open.spotify.com/track/1" },
          artists: [{ name: "Mark Ronson" }, { name: "Bruno Mars" }]
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      await expect(
        fetchSpotifyTrackMetadata("https://open.spotify.com/track/1", {
          clientId: "client-id",
          clientSecret: "client-secret",
          refreshToken: "refresh-token",
          market: "US"
        })
      ).resolves.toMatchObject({
        id: "1",
        name: "Uptown Funk",
        url: "https://open.spotify.com/track/1",
        artists: [{ name: "Mark Ronson" }, { name: "Bruno Mars" }]
      });

      expect(calls).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

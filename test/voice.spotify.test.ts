import { describe, expect, test } from "bun:test";

import { isSpotifySearchResponseError } from "../src/voice";

describe("isSpotifySearchResponseError", () => {
  test("matches the play-dl malformed tracks payload crash", () => {
    expect(isSpotifySearchResponseError("undefined is not an object (evaluating 'n.tracks.items')")).toBe(true);
  });

  test("matches spotify auth and request failures", () => {
    expect(isSpotifySearchResponseError("Spotify Data is missing")).toBe(true);
    expect(isSpotifySearchResponseError("Got 403 from the request")).toBe(true);
  });

  test("ignores unrelated errors", () => {
    expect(isSpotifySearchResponseError("Lavalink is not ready.")).toBe(false);
  });
});

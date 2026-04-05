import { fetchSpotifyTrackMetadata, type SpotifyAuthConfig, type SpotifySearchTrack } from "./spotifySearch";

function normalizeSearchPart(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isYouTubeVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean).length > 0;
    }

    if (!parsed.hostname.includes("youtube.com")) {
      return false;
    }

    return parsed.pathname === "/watch" && parsed.searchParams.has("v");
  } catch {
    return false;
  }
}

export function buildSpotifyTrackSearchIdentifier(track: SpotifySearchTrack): string {
  const artists = (track.artists ?? [])
    .map(artist => normalizeSearchPart(artist.name))
    .filter(Boolean)
    .join(" ");
  const name = normalizeSearchPart(track.name);
  return `ytsearch:${[artists, name].filter(Boolean).join(" ").trim()}`;
}

export async function resolveLavalinkTrackIdentifier(
  url: string,
  spotifyConfig: SpotifyAuthConfig | null = null,
  spotifyTrackFetcher: (url: string, config: SpotifyAuthConfig) => Promise<SpotifySearchTrack> = fetchSpotifyTrackMetadata
): Promise<string> {
  if (isYouTubeVideoUrl(url)) {
    return url.trim();
  }

  if (url.includes("spotify.com/track/") || url.startsWith("spotify:track:")) {
    if (!spotifyConfig) {
      throw new Error("Spotify auth is not configured. Set the Spotify auth env vars or send a direct YouTube link.");
    }

    const track = await spotifyTrackFetcher(url, spotifyConfig);
    return buildSpotifyTrackSearchIdentifier(track);
  }

  throw new Error("Only YouTube video URLs or Spotify track URLs are supported.");
}

import { fetchSpotifyTrackMetadata, type SpotifyAuthConfig, type SpotifySearchTrack } from "./spotifySearch";

type PlayDlSpotifyTrackLike = {
  name: string;
  url: string;
  artists?: { name: string }[];
};

type PlayDlYouTubeVideoLike = {
  url: string;
  title?: string;
  channel?: {
    name?: string;
  };
};

type PlayDlYouTubeInfoLike = {
  format: Array<{
    url?: string;
    bitrate?: number;
    mimeType?: string;
    audioQuality?: string;
    audioChannels?: number;
    qualityLabel?: string;
    itag?: number;
  }>;
};

export type PlayDlLike = {
  yt_validate(url: string): "playlist" | "video" | "search" | false;
  sp_validate(url: string): "track" | "playlist" | "album" | "search" | false;
  video_info(url: string): Promise<PlayDlYouTubeInfoLike>;
  decipher_info<T extends PlayDlYouTubeInfoLike>(data: T, audioOnly?: boolean): Promise<T>;
  search(query: string, options: {
    source: {
      youtube: "video";
    };
    limit?: number;
  }): Promise<PlayDlYouTubeVideoLike[]>;
};

function buildSpotifySearchQuery(track: PlayDlSpotifyTrackLike): string {
  const artists = track.artists?.map(artist => artist.name.trim()).filter(Boolean).join(" ") ?? "";
  return [track.name.trim(), artists].filter(Boolean).join(" ").trim();
}

function normalizeSearchKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function scoreYouTubeVideoResult(track: PlayDlSpotifyTrackLike, result: PlayDlYouTubeVideoLike): number {
  const title = normalizeSearchKey(result.title ?? "");
  const channel = normalizeSearchKey(result.channel?.name ?? "");
  const trackName = normalizeSearchKey(track.name);
  const artists = track.artists?.map(artist => normalizeSearchKey(artist.name)).filter(Boolean) ?? [];

  if (!result.url.trim() || !title) return Number.NEGATIVE_INFINITY;

  let score = 0;

  if (title.includes(trackName)) score += 4;
  if (trackName.includes(title)) score += 1;

  for (const artist of artists) {
    if (title.includes(artist)) score += 2;
    if (channel.includes(artist)) score += 1;
  }

  return score;
}

function rankYouTubeVideoResults(track: PlayDlSpotifyTrackLike, results: PlayDlYouTubeVideoLike[]): PlayDlYouTubeVideoLike[] {
  return results
    .filter(result => Boolean(result.url.trim()))
    .map(result => ({
      result,
      score: scoreYouTubeVideoResult(track, result)
    }))
    .sort((left, right) => right.score - left.score)
    .map(entry => entry.result);
}

function selectBestYouTubeStreamUrl(info: PlayDlYouTubeInfoLike): string | null {
  let bestUrl: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const format of info.format) {
    if (!format.url) continue;

    let score = 0;
    if (format.mimeType?.includes("audio")) score += 3;
    if (typeof format.audioChannels === "number") score += 2;
    if (typeof format.bitrate === "number") score += Math.min(5, Math.floor(format.bitrate / 50_000));
    if (format.qualityLabel) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestUrl = format.url;
    }
  }

  return bestUrl;
}

async function resolveYouTubeMediaUrl(playDl: PlayDlLike, url: string): Promise<string> {
  try {
    const info = await playDl.decipher_info(await playDl.video_info(url), true);
    const mediaUrl = selectBestYouTubeStreamUrl(info);
    if (!mediaUrl) {
      throw new Error("Couldn't find a playable YouTube stream.");
    }

    return mediaUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve a playable YouTube stream: ${message}`);
  }
}

async function resolveSpotifyTrackToMediaUrl(
  playDl: PlayDlLike,
  url: string,
  spotifyConfig: SpotifyAuthConfig | null,
  spotifyTrackFetcher: (url: string, config: SpotifyAuthConfig) => Promise<SpotifySearchTrack>
): Promise<string> {
  if (!spotifyConfig) {
    throw new Error("Spotify auth is not configured. Set the Spotify auth env vars or send a direct link.");
  }

  const track = await spotifyTrackFetcher(url, spotifyConfig);
  const results = await playDl.search(buildSpotifySearchQuery(track), {
    source: {
      youtube: "video"
    },
    limit: 10
  });

  const rankedResults = rankYouTubeVideoResults(track, results);
  let lastError: unknown = null;

  for (const selected of rankedResults) {
    try {
      return await resolveYouTubeMediaUrl(playDl, selected.url);
    } catch (error) {
      lastError = error;
    }
  }

  const lastMessage = lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "";
  throw new Error(`Couldn't find a playable YouTube version.${lastMessage ? ` ${lastMessage}` : ""}`.trim());
}

export async function resolveLavalinkTrackIdentifier(
  playDl: PlayDlLike,
  url: string,
  spotifyConfig: SpotifyAuthConfig | null = null,
  spotifyTrackFetcher: (url: string, config: SpotifyAuthConfig) => Promise<SpotifySearchTrack> = fetchSpotifyTrackMetadata
): Promise<string> {
  try {
    if (playDl.yt_validate(url) === "video") {
      return await resolveYouTubeMediaUrl(playDl, url);
    }

    if (playDl.sp_validate(url) === "track") {
      return await resolveSpotifyTrackToMediaUrl(playDl, url, spotifyConfig, spotifyTrackFetcher);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message || "Failed to resolve a playable track.");
  }

  throw new Error("Only YouTube video URLs or Spotify track URLs are supported.");
}

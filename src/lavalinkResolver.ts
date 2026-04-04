type PlayDlSpotifyTrackLike = {
  type: "track" | "playlist" | "album";
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

export type PlayDlLike = {
  yt_validate(url: string): "playlist" | "video" | "search" | false;
  sp_validate(url: string): "track" | "playlist" | "album" | "search" | false;
  spotify(url: string): Promise<PlayDlSpotifyTrackLike>;
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

function selectBestYouTubeVideoResult(track: PlayDlSpotifyTrackLike, results: PlayDlYouTubeVideoLike[]): PlayDlYouTubeVideoLike | null {
  let bestResult: PlayDlYouTubeVideoLike | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const result of results) {
    const score = scoreYouTubeVideoResult(track, result);
    if (score > bestScore) {
      bestScore = score;
      bestResult = result;
    }
  }

  return bestResult;
}

export async function resolveLavalinkTrackIdentifier(playDl: PlayDlLike, url: string): Promise<string> {
  if (playDl.yt_validate(url) === "video") {
    return url;
  }

  if (playDl.sp_validate(url) === "track") {
    const track = await playDl.spotify(url);
    if (track.type !== "track") {
      throw new Error("Only Spotify track URLs are supported.");
    }

    const results = await playDl.search(buildSpotifySearchQuery(track), {
      source: {
        youtube: "video"
      },
      limit: 10
    });

    const selected = selectBestYouTubeVideoResult(track, results);
    if (!selected?.url) {
      throw new Error("Couldn't find a playable YouTube version.");
    }

    return selected.url;
  }

  throw new Error("Only YouTube video URLs or Spotify track URLs are supported.");
}

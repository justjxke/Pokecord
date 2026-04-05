const LAVALINK_PORT = 2334;
const YOUTUBE_PLUGIN_VERSION = "1.18.0";

interface BuildLavalinkConfigOptions {
  youtubePoToken?: string | null;
  youtubeVisitorData?: string | null;
  youtubeOauthRefreshToken?: string | null;
  youtubeOauthSkipInitialization?: boolean;
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildLavalinkConfig(password: string, options: BuildLavalinkConfigOptions = {}): string {
  const lines = [
    "server:",
    `  port: ${LAVALINK_PORT}`,
    "  address: 0.0.0.0",
    "lavalink:",
    "  server:",
    `    password: "${escapeYamlString(password)}"`,
    "    sources:",
    "      youtube: false",
    "  plugins:",
    `    - dependency: "dev.lavalink.youtube:youtube-plugin:${YOUTUBE_PLUGIN_VERSION}"`,
    "      snapshot: false",
    "plugins:",
    "  youtube:",
    "    enabled: true",
    "    allowSearch: true",
    "    allowDirectVideoIds: true",
    "    allowDirectPlaylistIds: true",
    "    clientOptions:",
    "      WEB:",
    "        playback: true",
    "        videoLoading: true",
    "        playlistLoading: true",
    "        searching: true",
    "      WEBEMBEDDED:",
    "        playback: true",
    "        videoLoading: true",
    "        playlistLoading: false",
    "        searching: false",
    "    clients:",
    "      - MUSIC",
    "      - ANDROID_VR",
    "      - WEB",
    "      - WEBEMBEDDED"
  ];

  if (options.youtubeOauthRefreshToken) {
    lines.push(
      "    oauth:",
      "      enabled: true",
      `      refreshToken: "${escapeYamlString(options.youtubeOauthRefreshToken)}"`,
      `      skipInitialization: ${options.youtubeOauthSkipInitialization === false ? "false" : "true"}`
    );
  } else if (options.youtubePoToken && options.youtubeVisitorData) {
    lines.push(
      "    pot:",
      `      token: "${escapeYamlString(options.youtubePoToken)}"`,
      `      visitorData: "${escapeYamlString(options.youtubeVisitorData)}"`
    );
  }

  lines.push("");
  return lines.join("\n");
}

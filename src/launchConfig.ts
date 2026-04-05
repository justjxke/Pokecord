const LAVALINK_PORT = 2334;
const YOUTUBE_PLUGIN_VERSION = "1.18.0";

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildLavalinkConfig(password: string): string {
  return [
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
    "    clients:",
    "      - MUSIC",
    "      - ANDROID_VR",
    "      - WEB",
    "      - WEBEMBEDDED",
    ""
  ].join("\n");
}

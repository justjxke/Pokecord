#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$ROOT_DIR/worker"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
BACKEND_PLIST="$LAUNCH_AGENTS_DIR/com.pokediscord.bridge.plist"
TUNNEL_PLIST="$LAUNCH_AGENTS_DIR/com.pokediscord.tunnel.plist"
CLOUDFLARED_CONFIG="$HOME/.cloudflared/poke-discord-bridge.yml"
WRANGLER_CONFIG="$WORKER_DIR/wrangler.toml"
BACKEND_PORT="3000"
WORKER_NAME="poke-discord-bridge"
DEFAULT_TUNNEL_NAME="poke-discord-bridge"
DEFAULT_WORKERS_SUBDOMAIN="pokediscord"
POKE_RECIPE_LINK="https://poke.com/refer/w1uUvXkX0m5"

log() {
  printf '\n[poke-discord-bridge] %s\n' "$*"
}

die() {
  printf '\n[poke-discord-bridge] %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

prompt() {
  local __name="$1"
  local __default="${2:-}"
  local __message="$3"
  local __reply=""

  if [[ -n "$__default" ]]; then
    read -r -p "$__message [$__default]: " __reply
    __reply="${__reply:-$__default}"
  else
    read -r -p "$__message: " __reply
    [[ -n "$__reply" ]] || die "$__message is required."
  fi

  printf -v "$__name" '%s' "$__reply"
}

prompt_secret() {
  local __name="$1"
  local __message="$2"
  local __reply=""

  read -r -s -p "$__message: " __reply
  printf '\n'
  [[ -n "$__reply" ]] || die "$__message is required."
  printf -v "$__name" '%s' "$__reply"
}

confirm() {
  local __reply=""
  read -r -p "$1 [y/N]: " __reply
  case "$(printf '%s' "$__reply" | tr '[:upper:]' '[:lower:]')" in
    y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "This installer is for macOS."
}

ensure_deps() {
  require_cmd node
  require_cmd pnpm
  require_cmd curl
  require_cmd cloudflared
  require_cmd launchctl
}

backup_file() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  local backup="${path}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$path" "$backup"
  log "Backed up $(basename "$path") to $(basename "$backup")."
}

write_env() {
  cat > "$ROOT_DIR/.env" <<EOF
DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN
POKE_EDGE_SECRET=$EDGE_SECRET
POKE_STATE_SECRET=$EDGE_SECRET
POKE_BRIDGE_MODE=hybrid
POKE_MCP_PORT=$BACKEND_PORT
POKE_MCP_HOST=0.0.0.0
POKE_AUTO_TUNNEL=false
EOF
  if [[ -n "${OWNER_DISCORD_USER_ID:-}" ]]; then
    printf 'POKE_OWNER_DISCORD_USER_ID=%s\n' "$OWNER_DISCORD_USER_ID" >> "$ROOT_DIR/.env"
  fi
  chmod 600 "$ROOT_DIR/.env"
}

write_worker_config() {
  cat > "$WRANGLER_CONFIG" <<EOF
name = "$WORKER_NAME"
main = "src/index.ts"
compatibility_date = "2026-03-31"

[vars]
POKE_BACKEND_ORIGIN = "https://$BACKEND_HOSTNAME"
EOF
}

write_backend_plist() {
  cat > "$BACKEND_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pokediscord.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd $ROOT_DIR &amp;&amp; set -a &amp;&amp; . $ROOT_DIR/.env &amp;&amp; set +a &amp;&amp; pnpm start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/poke-discord-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/poke-discord-bridge.err</string>
</dict>
</plist>
EOF
}

write_tunnel_config() {
  mkdir -p "$HOME/.cloudflared"
  cat > "$CLOUDFLARED_CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $BACKEND_HOSTNAME
    service: http://127.0.0.1:$BACKEND_PORT
  - service: http_status:404
EOF
}

write_tunnel_plist() {
  cat > "$TUNNEL_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pokediscord.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cloudflared tunnel --config $CLOUDFLARED_CONFIG run $TUNNEL_NAME</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/poke-discord-tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/poke-discord-tunnel.err</string>
</dict>
</plist>
EOF
}

launch_agent() {
  local label="$1"
  local path="$2"
  launchctl bootout "gui/$(id -u)" "$path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$path" >/dev/null
  launchctl enable "gui/$(id -u)/$label" >/dev/null 2>&1 || true
}

ensure_workers_subdomain() {
  local whoami_json account_id token response
  whoami_json="$(cd "$WORKER_DIR" && npx wrangler whoami --json)"
  account_id="$(printf '%s' "$whoami_json" | node -e 'const fs=require("node:fs"); const input=JSON.parse(fs.readFileSync(0,"utf8")); const account=input.accounts?.[0]?.id; if (!account) process.exit(1); process.stdout.write(account);')"
  token="$(node -e 'const fs=require("node:fs"); const path=require("node:path"); const file=path.join(process.env.HOME, "Library/Preferences/.wrangler/config/default.toml"); const text=fs.readFileSync(file, "utf8"); const match=text.match(/oauth_token = "([^"]+)"/); if (!match) process.exit(1); process.stdout.write(match[1]);')"

  log "Ensuring workers.dev subdomain: $WORKERS_SUBDOMAIN"
  response="$(curl -sS -X PUT -H 'Content-Type: application/json' -H "Authorization: Bearer $token" -d "{\"subdomain\":\"$WORKERS_SUBDOMAIN\"}" "https://api.cloudflare.com/client/v4/accounts/$account_id/workers/subdomain")"

  if ! printf '%s' "$response" | node -e 'const fs=require("node:fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); if (!data.success) process.exit(1);'; then
    printf '%s\n' "$response" >&2
    die "Could not create the workers.dev subdomain. Open Workers & Pages once in the Cloudflare dashboard, then rerun the installer."
  fi
}

ensure_tunnel() {
  local tunnels tunnel_json existing_tunnel
  tunnels="$(cloudflared tunnel list --output json)"
  existing_tunnel="$(printf '%s' "$tunnels" | node -e 'const fs=require("node:fs"); const list=JSON.parse(fs.readFileSync(0,"utf8")); const name=process.argv[1]; const tunnel=list.find(item => item.name === name); if (tunnel) process.stdout.write(tunnel.id);' "$TUNNEL_NAME" || true)"

  if [[ -z "$existing_tunnel" ]]; then
    log "Creating Cloudflare tunnel: $TUNNEL_NAME"
    tunnel_json="$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1 | tee /dev/stderr)"
    existing_tunnel="$(printf '%s' "$tunnel_json" | node -e 'const fs=require("node:fs"); const text=fs.readFileSync(0,"utf8"); const match=text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (!match) process.exit(1); process.stdout.write(match[0]);')"
  else
    log "Reusing Cloudflare tunnel: $TUNNEL_NAME"
  fi

  TUNNEL_ID="$existing_tunnel"
  cloudflared tunnel route dns "$TUNNEL_NAME" "$BACKEND_HOSTNAME"
  write_tunnel_config
  write_tunnel_plist
}

ensure_cloudflare_login() {
  if ! (cd "$WORKER_DIR" && npx wrangler whoami --json >/dev/null 2>&1); then
    log "Logging into Cloudflare for wrangler..."
    (cd "$WORKER_DIR" && npx wrangler login)
  fi

  if [[ -f "$HOME/.cloudflared/cert.pem" ]]; then
    log "Cloudflared is already authenticated."
    return 0
  fi

  log "Logging into Cloudflare for cloudflared..."
  cloudflared tunnel login
  [[ -f "$HOME/.cloudflared/cert.pem" ]] || die "Cloudflared login did not finish. Open the Cloudflare login page in a normal browser, sign in, then rerun the installer."
}

main() {
  ensure_macos
  ensure_deps

  log "This will set up the backend, Cloudflare Worker, and named tunnel."
  confirm "Continue" || die "Cancelled."

  prompt_secret DISCORD_BOT_TOKEN "Discord bot token"
  prompt BACKEND_HOSTNAME "mcp.example.com" "Backend hostname for the Cloudflare Tunnel"
  prompt TUNNEL_NAME "$DEFAULT_TUNNEL_NAME" "Cloudflare tunnel name"
  prompt WORKERS_SUBDOMAIN "$DEFAULT_WORKERS_SUBDOMAIN" "Cloudflare workers.dev subdomain"
  read -r -p "Owner Discord user ID (optional): " OWNER_DISCORD_USER_ID

  EDGE_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

  backup_file "$ROOT_DIR/.env"
  write_env

  log "Installing project dependencies..."
  (cd "$ROOT_DIR" && pnpm install)

  write_backend_plist
  launch_agent "com.pokediscord.bridge" "$BACKEND_PLIST"

  ensure_cloudflare_login
  ensure_workers_subdomain
  ensure_tunnel
  write_worker_config

  log "Deploying Cloudflare Worker..."
  (cd "$WORKER_DIR" && printf '%s' "$EDGE_SECRET" | npx wrangler secret put POKE_EDGE_SECRET)
  (cd "$WORKER_DIR" && npx wrangler deploy)

  launch_agent "com.pokediscord.tunnel" "$TUNNEL_PLIST"

  log "Done."
  printf '\nPoke recipe link: %s\n' "$POKE_RECIPE_LINK"
  printf 'Public MCP URL: https://poke-discord-bridge.%s.workers.dev/mcp\n' "$WORKERS_SUBDOMAIN"
  printf 'Backend hostname: https://%s\n' "$BACKEND_HOSTNAME"
  printf 'Next step in Poke Kitchen: save the integration, then refresh the connection.\n'
}

main "$@"

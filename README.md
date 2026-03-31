
## A thank you message

Thank you to the team at [interaction](https://interaction.co) for [Poke](https://poke.com), an amazing personal superintelligence that sits in your pocket..or in your discord!



# Poke Discord Bridge

A self hosted Discord bridge for Poke.

It runs a Discord bot, exposes an MCP endpoint for Poke through Cloudflare, and lets Poke send messages back into Discord through the `sendDiscordMessage` tool.

## Easiest setup

Run the installer from the repo root:

```bash
./install.sh
```

It will ask for your Discord bot token, Poke API key, Cloudflare hostname, tunnel name, and workers.dev subdomain, then set up the backend, Worker, and auto start for you! Enjoy speaking to Poke in discord.

## What you need

- Node.js 22 or newer.
- pnpm.
- A Discord bot token.
- A Poke API key.
- Cloudflare is required if you want Poke to call the bridge back into Discord.

## What runs where

- `src/` is the local Node backend.
- `worker/` is the Cloudflare Worker that exposes the public MCP URL.
- `launchd/` has the macOS auto start example.

## Manual quick start

1. Install dependencies.

```bash
pnpm install
```

2. Create your environment file.

```bash
cp .env.example .env
```

3. Fill in `.env` with your [Discord bot token](https://discord.com/developers/home) and Poke [API key](https://poke.com/kitchen/api-keys).

4. Start the bridge.

```bash
pnpm start
```

That starts the Discord bot and the local MCP server.

This is enough for local Discord testing, but Poke cannot call `sendDiscordMessage` back until you also set up the Cloudflare Worker path below.

If you already ran `./install.sh`, you do not need to do these steps by hand.

## Environment variables

### Local backend

- `DISCORD_BOT_TOKEN` or `DISCORD_TOKEN`
- `POKE_API_KEY`
- `POKE_EDGE_SECRET` shared with the Worker
- `POKE_MCP_PORT` optional, defaults to `3000`
- `POKE_MCP_HOST` optional, defaults to `127.0.0.1`
- `POKE_CONTEXT_MESSAGES` optional, defaults to `40`
- `POKE_DISCORD_BRIDGE_STATE_PATH` optional

### Worker

- `POKE_BACKEND_ORIGIN` the HTTPS origin for your backend
- `POKE_EDGE_SECRET` the same shared secret as the backend

## Cloudflare setup for full Poke replies

If you want Poke to call the bridge back into Discord, the MCP endpoint must be public. This is the normal release path.

1. Run the backend on your machine or another always on host.
2. Expose the backend with Cloudflare Tunnel or another HTTPS origin.
3. Set `POKE_BACKEND_ORIGIN` for the Worker to that public origin.
4. Set `POKE_EDGE_SECRET` to the same value on both sides.
5. Deploy the Worker from `worker/`.
6. Add this URL in Poke Kitchen:

```text
https://poke-discord-bridge.pokediscord.workers.dev/mcp
```

### Deploy the Worker

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

If your backend origin changes, update `worker/wrangler.toml` or the Worker variables in the Cloudflare dashboard.

Without the Cloudflare path, Poke can't send messages to Discord from your local bot, it will not be able to call `sendDiscordMessage` back through MCP.

## macOS auto start

Use the LaunchAgent example to start the bridge at login.

1. Copy `launchd/com.pokediscord.bridge.plist.example` to `~/Library/LaunchAgents/com.pokediscord.bridge.plist`.
2. Edit the repo path if needed.
3. Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pokediscord.bridge.plist
launchctl enable gui/$(id -u)/com.pokediscord.bridge
```

## Commands

- `!status` shows whether the bridge is linked.
- `!reset` clears the local link state.
- `/poke` sends a server message to Poke.


## Files to look at first

- `src/index.ts` starts the bot and MCP server.
- `src/mcp.ts` implements the MCP transport.
- `src/discordBot.ts` handles Discord.
- `src/pokeClient.ts` sends messages to Poke.
- `worker/src/proxy.ts` proxies the public MCP route.

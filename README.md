# Poke Discord Bridge

Discord bridge for Poke with one bot on one VPS:

- owner-private DMs for your own linked account
- public DMs for each user who links their own Poke key
- guild installs with admin setup and channel allowlists

## Quick Start

1. Install dependencies.

```bash
pnpm install
```

2. Copy the example env file and fill in your secrets.

```bash
cp .env.example .env
```

3. Start the bridge.

```bash
pnpm start
```

## Environment

### VPS bot

Set these in the VPS env for the bot runtime:

- `DISCORD_BOT_TOKEN`
- `POKE_EDGE_SECRET`
- `POKE_STATE_SECRET` optional, defaults to `POKE_EDGE_SECRET`
- `POKE_OWNER_DISCORD_USER_ID` optional, only if you want your owner namespace
- `POKE_MCP_PORT` optional, defaults to `3000`
- `POKE_MCP_HOST` optional, defaults to `0.0.0.0`
- `POKE_CONTEXT_MESSAGES` optional, defaults to `40`
- `POKE_AUTO_TUNNEL` optional, defaults to `false`
- `POKE_API_BASE_URL` optional, defaults to `https://poke.com/api/v1`
- `POKE_DISCORD_BRIDGE_STATE_PATH` optional, defaults to `/data/state.json`

### Cloudflare Worker

Set these only if you keep the public MCP URL on the Worker:

- `POKE_BACKEND_ORIGIN`
- `POKE_EDGE_SECRET`

## Public Setup

For server use:

1. Run the app on an always-on host with a public HTTPS endpoint.
2. In Discord, run `/poke setup` as a server admin or owner.
3. Enter the server's Poke API key in the modal.
4. Use `/poke status` to confirm the enabled channels.
5. Only enabled channels will relay to Poke.

## Private Setup

For your personal owner namespace:

1. Open a DM with the bot.
2. Send `!setup`.
3. Paste your Poke API key in the DM.
4. The bot deletes the paste after capture.
5. Use `!status` or `!reset` if you need to check or clear the link.

## Commands

- DM mode:
  - `!setup`
  - `!status`
  - `!reset`
- Slash commands:
  - `/poke send`
  - `/poke setup`
  - `/poke status`
  - `/poke reset`

## Notes

- Cloudflare is optional if your host already provides a public HTTPS origin.
- Users can paste their Poke API key in DMs to link their own account; the bot deletes the paste after capture.
- The bot refuses operator identity and internal bridge state requests.

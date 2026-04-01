# Poke Discord Bridge

Discord bridge for Poke with two explicit modes:

- `private` for a single DM-linked owner
- `public` for server installs with setup and channel allowlists

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

Set these in `.env`:

- `DISCORD_BOT_TOKEN`
- `POKE_API_KEY`
- `POKE_BRIDGE_MODE` (`private` or `public`)
- `POKE_EDGE_SECRET` if you use the Worker proxy path
- `POKE_MCP_PORT` optional, defaults to `3000`
- `POKE_MCP_HOST` optional, defaults to `0.0.0.0`
- `POKE_CONTEXT_MESSAGES` optional, defaults to `40`

## Public Mode

For server use:

1. Set `POKE_BRIDGE_MODE=public`.
2. Run the app on an always-on host with a public HTTPS endpoint.
3. In Discord, run `/poke setup` as a server admin or owner.
4. Optionally pass `channel:#your-channel` to add that channel to the allowlist.
5. Use `/poke status` to confirm the enabled channels.

## Commands

- Private mode:
  - `!status`
  - `!reset`
- Slash commands:
  - `/poke send`
  - `/poke setup`
  - `/poke status`
  - `/poke reset`

## Notes

- Cloudflare is optional if your host already provides a public HTTPS origin.
- The bot refuses operator identity and internal bridge state requests in public mode.

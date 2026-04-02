# Poke Discord Bridge

Discord bridge for Poke with one hybrid runtime:

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

Set these in `.env`:

- `DISCORD_BOT_TOKEN`
- `POKE_EDGE_SECRET`
- `POKE_STATE_SECRET` optional, defaults to `POKE_EDGE_SECRET`
- `POKE_OWNER_DISCORD_USER_ID` optional, for your private owner namespace
- `POKE_BRIDGE_MODE` ignored by the current runtime; the bot runs in hybrid mode
- `POKE_MCP_PORT` optional, defaults to `3000`
- `POKE_MCP_HOST` optional, defaults to `0.0.0.0`
- `POKE_CONTEXT_MESSAGES` optional, defaults to `40`

## Public Mode

For server use:

1. Run the app on an always-on host with a public HTTPS endpoint.
2. In Discord, run `/poke setup` as a server admin or owner.
3. Enter the server's Poke API key in the modal.
4. Use `/poke status` to confirm the enabled channels.
5. Only enabled channels will relay to Poke.

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

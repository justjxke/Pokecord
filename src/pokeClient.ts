import type { BridgeConfig, DiscordRelayRequest, PokeSendResult } from "./types";

export async function sendToPoke(config: BridgeConfig, pokeApiKey: string, request: DiscordRelayRequest): Promise<PokeSendResult> {
  const response = await fetch(`${config.pokeApiBaseUrl}/inbound/api-message`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pokeApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: request.prompt,
      source: "discord",
      bridgeRequestId: request.bridgeRequestId,
      tenantKind: request.tenant.kind,
      tenantId: request.tenant.id,
      replyTargetChannelId: request.replyTarget.channelId,
      replyTargetMode: request.replyTarget.mode,
      replyTargetLabel: request.replyTarget.label,
      discordUserId: request.discordUserId,
      discordChannelId: request.discordChannelId,
      discordMessageId: request.discordMessageId,
      attachments: request.attachments,
      contextMessages: request.contextMessages
    })
  });

  if (!response.ok) {
    throw new Error(`Poke API failed with ${response.status}`);
  }

  return (await response.json()) as PokeSendResult;
}

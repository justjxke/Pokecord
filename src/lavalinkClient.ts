import { EventEmitter } from "node:events";

import type { Client } from "discord.js";

import type { BridgeConfig } from "./types";

type JsonObject = Record<string, unknown>;

export interface LavalinkTrackInfo {
  identifier?: string;
  isSeekable?: boolean;
  author?: string;
  length?: number;
  isStream?: boolean;
  position?: number;
  title?: string;
  uri?: string;
  artworkUrl?: string | null;
  isrc?: string | null;
  sourceName?: string;
}

export interface LavalinkTrack {
  encoded: string;
  info: LavalinkTrackInfo;
  pluginInfo?: JsonObject;
}

export interface LavalinkSearchResponse {
  loadType: "track" | "playlist" | "search" | "empty" | "error";
  data: LavalinkTrack | { tracks: LavalinkTrack[]; info?: JsonObject } | LavalinkTrack[] | JsonObject;
}

export interface LavalinkVoiceStateUpdate {
  session_id?: string | null;
  channel_id?: string | null;
  self_deaf?: boolean;
  self_mute?: boolean;
}

export interface LavalinkVoiceServerUpdate {
  token: string;
  endpoint: string;
}

export interface LavalinkPlayerOptions {
  track?: { encoded: string | null };
  position?: number;
  paused?: boolean;
  volume?: number;
  filters?: JsonObject;
  voice?: {
    token: string;
    endpoint: string;
    sessionId: string;
    channelId: string;
  };
  endTime?: number;
}

export interface LavalinkPlayerUpdatePayload {
  guildId: string;
  noReplace?: boolean;
  playerOptions: LavalinkPlayerOptions;
}

export interface LavalinkJoinVoiceChannelOptions {
  guildId: string;
  shardId: number;
  channelId: string;
  deaf: boolean;
}

type ReadyState = "connecting" | "ready" | "closed";

function buildBaseUrl(rawUrl: string): URL {
  const parsed = rawUrl.includes("://") ? new URL(rawUrl) : new URL(`http://${rawUrl}`);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class LavalinkRestClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly auth: string,
    private readonly secure: boolean,
    private readonly userAgent: string,
    private readonly timeoutMs: number
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    url.protocol = this.secure ? "https:" : (url.protocol === "https:" ? "https:" : "http:");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: this.auth,
          "User-Agent": this.userAgent,
          "Content-Type": "application/json",
          ...(init.headers ?? {})
        }
      });

      if (!response.ok) {
        throw new Error(`Lavalink request failed: ${response.status} ${response.statusText}`);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      if (response.headers.get("content-type")?.includes("application/json")) {
        return response.json() as Promise<T>;
      }

      return (await response.text()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async resolve(identifier: string): Promise<LavalinkSearchResponse> {
    const query = new URLSearchParams({ identifier });
    return this.request(`/v4/loadtracks?${query.toString()}`);
  }

  async updatePlayer(sessionId: string, data: LavalinkPlayerUpdatePayload): Promise<unknown> {
    const query = new URLSearchParams({ noReplace: String(data.noReplace ?? false) });
    return this.request(
      `/v4/sessions/${sessionId}/players/${data.guildId}?${query.toString()}`,
      {
        method: "PATCH",
        body: JSON.stringify(data.playerOptions)
      }
    );
  }

  async destroyPlayer(guildId: string, sessionId: string): Promise<void> {
    await this.request(`/v4/sessions/${sessionId}/players/${guildId}`, { method: "DELETE" });
  }

  async updateSession(sessionId: string, resuming: boolean, timeout: number): Promise<unknown> {
    return this.request(`/v4/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ resuming, timeout })
    });
  }
}

export class LavalinkPlayer extends EventEmitter {
  public paused = false;
  public position = 0;
  public ping = 0;
  public track: string | null = null;
  public volume = 100;
  public filters: JsonObject = {};

  private voiceStateUpdate: LavalinkVoiceStateUpdate | null = null;
  private voiceServerUpdate: LavalinkVoiceServerUpdate | null = null;
  private voiceReadyResolved = false;
  private readonly voiceReadyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timeout?: ReturnType<typeof setTimeout>; }> = [];
  private destroyed = false;

  constructor(
    private readonly manager: LavalinkManager,
    public readonly guildId: string,
    private readonly shardId: number,
    private readonly channelId: string,
    private readonly deaf: boolean
  ) {
    super();
  }

  public get data(): {
    guildId: string;
    playerOptions: LavalinkPlayerOptions;
  } {
    return {
      guildId: this.guildId,
      playerOptions: {
        track: { encoded: this.track },
        position: this.position,
        paused: this.paused,
        filters: this.filters,
        voice: this.voiceStateUpdate && this.voiceServerUpdate && this.manager.sessionId
          ? {
              token: this.voiceServerUpdate.token,
              endpoint: this.voiceServerUpdate.endpoint,
              sessionId: this.manager.sessionId,
              channelId: this.voiceStateUpdate.channel_id ?? this.channelId
            }
          : undefined,
        volume: this.volume
      }
    };
  }

  public async connect(): Promise<void> {
    if (this.destroyed) throw new Error("Player has already been destroyed.");
    this.manager.sendDiscordVoiceState(this.shardId, {
      guild_id: this.guildId,
      channel_id: this.channelId,
      self_deaf: this.deaf,
      self_mute: false
    });
    await this.waitForVoiceReady(this.manager.voiceConnectionTimeoutMs);
  }

  public setStateUpdate(update: LavalinkVoiceStateUpdate): void {
    this.voiceStateUpdate = update;

    if (!update.channel_id) {
      if (!this.destroyed) {
        this.emit("closed", { code: 1000, reason: "Discord voice connection closed", byRemote: false });
      }
      return;
    }

    void this.syncVoice();
  }

  public setServerUpdate(update: LavalinkVoiceServerUpdate): void {
    this.voiceServerUpdate = update;
    void this.syncVoice();
  }

  public async playTrack(playerOptions: { track: { encoded: string } }, noReplace = false): Promise<void> {
    await this.update({ track: playerOptions.track, paused: false }, noReplace);
  }

  public async stopTrack(): Promise<void> {
    await this.update({ track: { encoded: null }, position: 0 }, false);
  }

  public async setPaused(paused = true): Promise<void> {
    await this.update({ paused }, false);
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.voiceReadyResolved = true;
    this.manager.players.delete(this.guildId);
    this.voiceReadyWaiters.splice(0).forEach(waiter => {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    });

    this.manager.sendDiscordVoiceState(this.shardId, {
      guild_id: this.guildId,
      channel_id: null,
      self_deaf: this.deaf,
      self_mute: false
    });

    const sessionId = this.manager.sessionId;
    if (sessionId) {
      await this.manager.rest.destroyPlayer(sessionId, this.guildId).catch(() => undefined);
    }
  }

  public onPlayerUpdate(json: { state: { position: number; ping: number; } }): void {
    this.position = json.state.position;
    this.ping = json.state.ping;
    this.emit("update", json);
  }

  public onPlayerEvent(json: { type: string; reason?: string; }): void {
    switch (json.type) {
      case "TrackStartEvent":
        this.emit("start", json);
        break;
      case "TrackEndEvent":
        this.emit("end", json);
        break;
      case "TrackStuckEvent":
        this.emit("stuck", json);
        break;
      case "TrackExceptionEvent":
        this.emit("exception", json);
        break;
      case "WebSocketClosedEvent":
        this.emit("closed", json);
        break;
      default:
        break;
    }
  }

  public async update(playerOptions: LavalinkPlayerOptions, noReplace = false): Promise<void> {
    if (this.destroyed) throw new Error("Player has already been destroyed.");
    const sessionId = this.manager.sessionId;
    if (!sessionId) throw new Error("Lavalink is not ready.");

    await this.manager.rest.updatePlayer(sessionId, {
      guildId: this.guildId,
      noReplace,
      playerOptions
    });

    if (!noReplace) this.paused = false;
    if (playerOptions.filters) {
      this.filters = { ...this.filters, ...playerOptions.filters };
    }
    if (typeof playerOptions.track !== "undefined") {
      this.track = playerOptions.track.encoded ?? null;
    }
    if (typeof playerOptions.paused === "boolean") {
      this.paused = playerOptions.paused;
    }
    if (typeof playerOptions.volume === "number") {
      this.volume = playerOptions.volume;
    }
    if (typeof playerOptions.position === "number") {
      this.position = playerOptions.position;
    }
  }

  public async waitForVoiceReady(timeoutMs: number): Promise<void> {
    if (this.voiceReadyResolved) return;

    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: undefined as ReturnType<typeof setTimeout> | undefined
      };

      waiter.timeout = setTimeout(() => {
        const index = this.voiceReadyWaiters.indexOf(waiter);
        if (index >= 0) {
          this.voiceReadyWaiters.splice(index, 1);
        }
        reject(new Error(`The voice connection is not established in ${timeoutMs} seconds`));
      }, timeoutMs);

      this.voiceReadyWaiters.push(waiter);
      void this.syncVoice();
    });
  }

  private resolveVoiceReady(): void {
    if (this.voiceReadyResolved) return;
    this.voiceReadyResolved = true;

    for (const waiter of this.voiceReadyWaiters.splice(0)) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  private rejectVoiceReady(error: Error): void {
    if (this.voiceReadyResolved) return;

    for (const waiter of this.voiceReadyWaiters.splice(0)) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  private async syncVoice(): Promise<void> {
    if (this.destroyed || this.voiceReadyResolved) return;
    if (!this.voiceStateUpdate?.session_id || !this.voiceStateUpdate.channel_id) return;
    if (!this.voiceServerUpdate?.endpoint || !this.voiceServerUpdate.token) return;
    const sessionId = this.manager.sessionId;
    if (!sessionId) return;

    try {
      await this.manager.rest.updatePlayer(sessionId, {
        guildId: this.guildId,
        noReplace: false,
        playerOptions: {
          voice: {
            token: this.voiceServerUpdate.token,
            endpoint: this.voiceServerUpdate.endpoint,
            sessionId: this.voiceStateUpdate.session_id,
            channelId: this.voiceStateUpdate.channel_id
          }
        }
      });
      this.resolveVoiceReady();
    } catch (error) {
      this.rejectVoiceReady(normalizeError(error));
      throw error;
    }
  }
}

export class LavalinkManager extends EventEmitter {
  public readonly rest: LavalinkRestClient;
  public readonly players = new Map<string, LavalinkPlayer>();
  public readonly voiceConnectionTimeoutMs: number;
  public sessionId: string | null = null;

  private readonly baseUrl: URL;
  private headers: HeadersInit;
  private websocket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private readyState: ReadyState = "closed";
  private reconnects = 0;
  private destroyed = false;
  private readonly reconnectTries = 3;
  private readonly reconnectIntervalMs = 5000;

  constructor(private readonly client: Client, config: BridgeConfig) {
    super();
    this.baseUrl = buildBaseUrl(config.lavalinkUrl);
    this.voiceConnectionTimeoutMs = 15_000;
    this.rest = new LavalinkRestClient(this.baseUrl, config.lavalinkPassword, config.lavalinkSecure, "poke-discord-bridge/1.0", 60_000);
    this.headers = {
      Authorization: config.lavalinkPassword,
      "User-Id": "",
      "Client-Name": `poke-discord-bridge/1.0 (${this.baseUrl.hostname})`
    };

    client.on("raw", packet => this.handleRawPacket(packet));
    if (client.user?.id) {
      void this.connect(client.user.id);
    } else {
      client.once("clientReady", () => {
        if (client.user?.id) {
          void this.connect(client.user.id);
        }
      });
    }
  }

  public getIdealNode(): LavalinkManager | null {
    return this.sessionId ? this : null;
  }

  public async connect(userId?: string): Promise<void> {
    if (this.readyState === "ready" || this.readyState === "connecting") {
      return this.connectPromise ?? Promise.resolve();
    }

    if (userId) {
      this.headers = {
        ...this.headers,
        "User-Id": userId
      };
    }

    this.readyState = "connecting";
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });

    void this.openWebSocket();
    return this.connectPromise;
  }

  public async joinVoiceChannel(options: LavalinkJoinVoiceChannelOptions): Promise<LavalinkPlayer> {
    await this.connect(this.client.user?.id ?? undefined);

    const existing = this.players.get(options.guildId);
    if (existing) {
      await existing.destroy().catch(() => undefined);
      this.players.delete(options.guildId);
    }

    const player = new LavalinkPlayer(this, options.guildId, options.shardId, options.channelId, options.deaf);
    this.players.set(options.guildId, player);
    await player.connect();
    return player;
  }

  public async leaveVoiceChannel(guildId: string): Promise<void> {
    const player = this.players.get(guildId);
    if (!player) return;

    this.players.delete(guildId);
    await player.destroy().catch(() => undefined);
  }

  public async updateSession(resuming: boolean, timeout: number): Promise<unknown> {
    if (!this.sessionId) throw new Error("Lavalink is not ready.");
    return this.rest.updateSession(this.sessionId, resuming, timeout);
  }

  public sendDiscordVoiceState(shardId: number, payload: {
    guild_id: string;
    channel_id: string | null;
    self_deaf: boolean;
    self_mute: boolean;
  }): void {
    const shard = (this.client as unknown as { ws?: { shards?: Map<number, { send: (payload: { op: number; d: unknown; }, important: boolean) => void; }>; }; }).ws?.shards?.get(shardId);
    shard?.send({ op: 4, d: payload }, false);
  }

  private async openWebSocket(): Promise<void> {
    const websocketUrl = new URL("/v4/websocket", this.baseUrl);
    websocketUrl.protocol = this.baseUrl.protocol === "https:" ? "wss:" : "ws:";

    const SocketCtor = globalThis.WebSocket as unknown as new (url: string, options?: { headers?: HeadersInit; }) => {
      addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void): void;
      close(code?: number, reason?: string): void;
    };

    const socket = new SocketCtor(websocketUrl.toString(), {
      headers: {
        ...this.headers
      }
    });

    this.websocket = socket as unknown as WebSocket;

    socket.addEventListener("open", () => {
      this.readyState = "connecting";
    });

    socket.addEventListener("message", event => {
      const data = "data" in event ? (event as MessageEvent).data : event;
      void this.handleMessage(data);
    });

    socket.addEventListener("error", event => {
      const error = event && typeof event === "object" && "error" in event && (event as { error?: unknown }).error
        ? normalizeError((event as { error?: unknown }).error)
        : new Error("Lavalink websocket error");
      this.error(error);
    });

    socket.addEventListener("close", event => {
      void this.handleClose(event);
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const text = typeof message === "string"
      ? message
      : message instanceof ArrayBuffer
        ? new TextDecoder().decode(new Uint8Array(message))
        : ArrayBuffer.isView(message)
          ? new TextDecoder().decode(new Uint8Array(message.buffer, message.byteOffset, message.byteLength))
          : String(message);

    let json: { op?: string; [key: string]: unknown; };
    try {
      json = JSON.parse(text) as { op?: string; [key: string]: unknown; };
    } catch (error) {
      this.emit("debug", "Lavalink", `Failed to parse websocket message: ${normalizeError(error).message}`);
      return;
    }

    if (!json?.op) return;
    switch (json.op) {
      case "ready":
        this.sessionId = typeof json.sessionId === "string" ? json.sessionId : null;
        if (!this.sessionId) {
          this.error(new Error("No session id found from ready op."));
          return;
        }
        this.readyState = "ready";
        this.reconnects = 0;
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
        this.emit("ready", Boolean(json.resumed), false);
        for (const player of this.players.values()) {
          void player.waitForVoiceReady(this.voiceConnectionTimeoutMs).catch(() => undefined);
        }
        break;
      case "stats":
        this.emit("stats", json);
        break;
      case "playerUpdate": {
        const guildId = typeof json.guildId === "string" ? json.guildId : null;
        if (!guildId) return;
        const player = this.players.get(guildId);
        if (!player || !json.state || typeof json.state !== "object") return;
        player.onPlayerUpdate(json as { state: { position: number; ping: number; }; });
        break;
      }
      case "event": {
        const guildId = typeof json.guildId === "string" ? json.guildId : null;
        if (!guildId) return;
        const player = this.players.get(guildId);
        if (!player) return;
        player.onPlayerEvent(json as { type: string; reason?: string; });
        if (json.type === "WebSocketClosedEvent") {
          this.players.delete(guildId);
        }
        break;
      }
      default:
        this.emit("debug", "Lavalink", `Unknown message: ${text}`);
        break;
    }
  }

  private async handleClose(event: { code?: number; reason?: string; }): Promise<void> {
    const wasReady = this.readyState === "ready";
    this.readyState = "closed";
    this.websocket = null;

    if (!this.connectResolve && !this.connectReject && !wasReady) {
      return;
    }

    const error = new Error(`Lavalink websocket closed: ${event.code ?? 1000} ${event.reason ?? ""}`);

    if (!wasReady) {
      this.connectReject?.(error);
      this.connectResolve = null;
      this.connectReject = null;
    }

    if (this.destroyed) {
      return;
    }

    this.emit("disconnect", 0);

    if (this.reconnects >= this.reconnectTries) {
      return;
    }

    this.reconnects += 1;
    this.emit("reconnecting", this.reconnectTries - this.reconnects, this.reconnectIntervalMs / 1000);
    await delay(this.reconnectIntervalMs);
    await this.connect(this.client.user?.id ?? undefined).catch(err => this.error(err));
  }

  private error(error: unknown): void {
    const normalized = normalizeError(error);
    this.emit("error", normalized);
    if (this.connectReject) {
      this.connectReject(normalized);
      this.connectResolve = null;
      this.connectReject = null;
    }
  }

  private handleRawPacket(packet: { t?: string; d?: JsonObject; }): void {
    if (!packet?.t || !packet.d) return;
    if (packet.t !== "VOICE_STATE_UPDATE" && packet.t !== "VOICE_SERVER_UPDATE") return;

    const guildId = typeof packet.d.guild_id === "string" ? packet.d.guild_id : null;
    if (!guildId) return;

    const player = this.players.get(guildId);
    if (!player) return;

    if (packet.t === "VOICE_STATE_UPDATE") {
      const userId = typeof packet.d.user_id === "string" ? packet.d.user_id : null;
      if (userId !== this.client.user?.id) return;
      player.setStateUpdate({
        session_id: typeof packet.d.session_id === "string" ? packet.d.session_id : null,
        channel_id: typeof packet.d.channel_id === "string" ? packet.d.channel_id : null,
        self_deaf: Boolean(packet.d.self_deaf),
        self_mute: Boolean(packet.d.self_mute)
      });
      return;
    }

    const endpoint = typeof packet.d.endpoint === "string" ? packet.d.endpoint : null;
    const token = typeof packet.d.token === "string" ? packet.d.token : null;
    if (!endpoint || !token) return;

    player.setServerUpdate({ endpoint, token });
  }
}

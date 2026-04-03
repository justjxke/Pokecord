import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import type { Client, Guild } from "discord.js";

import type {
  DiscordVoiceChannelSnapshot,
  DiscordVoiceContext,
  DiscordVoiceSessionSnapshot,
  DiscordVoiceTrackSummary,
  DiscordVoiceUserSnapshot
} from "./types";

const IDLE_LEAVE_DELAY_MS = 5 * 60 * 1000;
const VOICE_READY_TIMEOUT_MS = 30_000;

type VoiceApi = typeof import("@discordjs/voice");
type PlayDlApi = typeof import("play-dl");

type VoiceTrack = DiscordVoiceTrackSummary;

interface VoiceSession {
  guildId: string;
  voiceChannelId: string;
  voiceChannelName: string | null;
  textChannelId: string | null;
  queue: VoiceTrack[];
  currentTrack: VoiceTrack | null;
  idleLeaveAt: number | null;
  idleLeaveTimer: NodeJS.Timeout | null;
  player: any;
  connection: any;
  destroyed: boolean;
  playNonce: number;
}

export interface QueueVoiceTrackInput {
  bridgeRequestId: string;
  guildId: string;
  requesterId: string;
  requesterUsername: string;
  requesterDisplayName: string;
  requesterVoiceChannelId: string;
  requesterVoiceChannelName: string | null;
  textChannelId: string;
  url: string;
  position?: "front" | "back";
}

export interface ControlVoicePlaybackInput {
  bridgeRequestId: string;
  guildId: string;
  requesterId: string;
  requesterUsername: string;
  requesterDisplayName: string;
  requesterVoiceChannelId: string | null;
  requesterVoiceChannelName: string | null;
  textChannelId: string;
  action: "join" | "pause" | "resume" | "skip" | "stop" | "leave" | "current" | "queue" | "remove" | "clear";
  index?: number;
}

export interface VoiceOperationResult {
  ok: boolean;
  action: string;
  message: string;
  session: DiscordVoiceSessionSnapshot | null;
  track?: DiscordVoiceTrackSummary | null;
  removedTrack?: DiscordVoiceTrackSummary | null;
}

export interface VoiceManager {
  describeVoiceContext(guildId: string, requester: { userId: string; username: string; displayName: string; }): DiscordVoiceContext | null;
  queueVoiceTrack(input: QueueVoiceTrackInput): Promise<VoiceOperationResult>;
  controlVoicePlayback(input: ControlVoicePlaybackInput): Promise<VoiceOperationResult>;
  getSessionSnapshot(guildId: string): DiscordVoiceSessionSnapshot | null;
}

interface VoiceLibraries {
  discordVoice: Pick<VoiceApi, "AudioPlayerStatus" | "NoSubscriberBehavior" | "StreamType" | "VoiceConnectionStatus" | "createAudioPlayer" | "createAudioResource" | "entersState" | "getVoiceConnection" | "joinVoiceChannel">;
  playDl: Pick<PlayDlApi, "stream_from_info" | "video_basic_info" | "yt_validate">;
}

let voiceLibrariesPromise: Promise<VoiceLibraries> | null = null;
let voiceInstallAttempted = false;

function installVoiceDependencies(): void {
  if (voiceInstallAttempted) return;
  voiceInstallAttempted = true;

  const result = spawnSync("bun", ["install", "--frozen-lockfile"], {
    cwd: process.cwd(),
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error("Voice playback dependencies are not installed on this host and bun install failed.");
  }
}

async function loadVoiceLibraries(): Promise<VoiceLibraries> {
  if (!voiceLibrariesPromise) {
    voiceLibrariesPromise = (async () => {
      try {
        const [discordVoice, playDl] = await Promise.all([
          import("@discordjs/voice"),
          import("play-dl")
        ]);

        return {
          discordVoice,
          playDl
        };
      } catch (error) {
        try {
          installVoiceDependencies();
          const [discordVoice, playDl] = await Promise.all([
            import("@discordjs/voice"),
            import("play-dl")
          ]);

          return {
            discordVoice,
            playDl
          };
        } catch {
          throw new Error(`Voice playback dependencies are not installed on this host. Run bun install to enable voice playback. ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
  }

  return voiceLibrariesPromise;
}

function canonicalVoiceChannel(channelId: string | null, channelName: string | null): DiscordVoiceChannelSnapshot {
  return {
    id: channelId,
    name: channelName
  };
}

function summarizeTrack(track: VoiceTrack): DiscordVoiceTrackSummary {
  return {
    id: track.id,
    title: track.title,
    url: track.url,
    requestedByUserId: track.requestedByUserId,
    requestedByName: track.requestedByName,
    requestedAt: track.requestedAt
  };
}

function summarizeSession(session: VoiceSession): DiscordVoiceSessionSnapshot {
  return {
    guildId: session.guildId,
    connected: !session.destroyed,
    voiceChannel: canonicalVoiceChannel(session.voiceChannelId, session.voiceChannelName),
    textChannelId: session.textChannelId,
    currentTrack: session.currentTrack ? summarizeTrack(session.currentTrack) : null,
    queue: session.queue.map(summarizeTrack),
    paused: session.player.state.status === "paused" || session.player.state.status === "autopaused",
    idleLeavesAt: session.idleLeaveAt == null ? null : new Date(session.idleLeaveAt).toISOString()
  };
}

function buildRequesterSnapshot(input: { userId: string; username: string; displayName: string; voiceChannelId: string | null; voiceChannelName: string | null; }): DiscordVoiceUserSnapshot {
  return {
    userId: input.userId,
    username: input.username,
    displayName: input.displayName,
    profileSummary: `${input.displayName} (@${input.username})`,
    voiceChannel: canonicalVoiceChannel(input.voiceChannelId, input.voiceChannelName)
  };
}

function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

async function buildTrack(input: Pick<QueueVoiceTrackInput, "requesterDisplayName" | "requesterId" | "url">): Promise<VoiceTrack> {
  const { playDl } = await loadVoiceLibraries();
  const validation = playDl.yt_validate(input.url);
  if (validation !== "video") {
    throw new Error("Only YouTube video URLs are supported.");
  }

  const info = await playDl.video_basic_info(input.url);
  const title = info.video_details.title?.trim() || describeUrl(input.url);
  return {
    id: randomUUID(),
    title,
    url: info.video_details.url?.trim() || input.url.trim(),
    requestedByUserId: input.requesterId,
    requestedByName: input.requesterDisplayName,
    requestedAt: new Date().toISOString()
  };
}

function buildResourceUrl(track: VoiceTrack): string {
  return track.url;
}

function readRequesterVoiceChannel(guild: Guild, requesterId: string): { id: string; name: string | null; } | null {
  const voiceState = guild.voiceStates.cache.get(requesterId);
  if (!voiceState?.channelId) return null;
  return {
    id: voiceState.channelId,
    name: voiceState.channel?.name ?? null
  };
}

function getGuildSession(sessions: Map<string, VoiceSession>, guildId: string): VoiceSession | null {
  const session = sessions.get(guildId);
  if (!session || session.destroyed) return null;
  return session;
}

function clearIdleTimer(session: VoiceSession): void {
  if (session.idleLeaveAt != null) {
    session.idleLeaveAt = null;
  }
  if (session.idleLeaveTimer != null) {
    clearTimeout(session.idleLeaveTimer);
    session.idleLeaveTimer = null;
  }
}

function scheduleIdleLeave(session: VoiceSession, announce: (channelId: string, content: string) => Promise<void>): void {
  if (session.destroyed) return;
  if (session.idleLeaveAt != null) return;

  session.idleLeaveAt = Date.now() + IDLE_LEAVE_DELAY_MS;
  const leaveAt = session.idleLeaveAt;

  const announcementChannelId = session.textChannelId;
  if (announcementChannelId) {
    void (async () => {
      try {
        await announce(announcementChannelId, "Queue ended. I'll hang out for 5 minutes, then leave if nothing else starts.");
      } catch {
        // Best effort only.
      }
    })();
  }

  session.idleLeaveTimer = setTimeout(() => {
    void (async () => {
      const current = session.destroyed ? null : session;
      if (!current || current.idleLeaveAt !== leaveAt || current.queue.length || current.currentTrack) return;

      const afterAnnouncement = session.destroyed ? null : session;
      if (!afterAnnouncement || afterAnnouncement.idleLeaveAt !== leaveAt || afterAnnouncement.queue.length || afterAnnouncement.currentTrack) return;
      destroySession(sessionsRef.current, afterAnnouncement.guildId);
    })();
  }, IDLE_LEAVE_DELAY_MS);
}

function ensureGuildVoiceChannel(guild: Guild, requesterVoiceChannelId: string | null): { id: string; name: string | null; } {
  if (!requesterVoiceChannelId) {
    throw new Error("Join a voice channel first.");
  }

  const state = guild.voiceStates.cache.get(requesterVoiceChannelId);
  return state?.channelId
    ? {
        id: state.channelId,
        name: state.channel?.name ?? null
      }
    : {
        id: requesterVoiceChannelId,
        name: null
      };
}

const sessionsRef = {
  current: new Map<string, VoiceSession>()
};

async function createSession(client: Client, guildId: string, voiceChannelId: string, voiceChannelName: string | null, textChannelId: string | null, announce: (channelId: string, content: string) => Promise<void>): Promise<VoiceSession> {
  const { discordVoice } = await loadVoiceLibraries();
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
  const existingConnection = discordVoice.getVoiceConnection(guildId);
  if (existingConnection) {
    existingConnection.destroy();
  }

  const player = discordVoice.createAudioPlayer({
    behaviors: {
      noSubscriber: discordVoice.NoSubscriberBehavior.Pause
    }
  });

  const connection = discordVoice.joinVoiceChannel({
    channelId: voiceChannelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });

  const session: VoiceSession = {
    guildId,
    voiceChannelId,
    voiceChannelName,
    textChannelId,
    queue: [],
    currentTrack: null,
    idleLeaveAt: null,
    idleLeaveTimer: null,
    player,
    connection,
    destroyed: false,
    playNonce: 0
  };

  sessionsRef.current.set(guildId, session);
  connection.subscribe(player);

  player.on(discordVoice.AudioPlayerStatus.Idle, () => {
    void advanceQueue(client, session, announce);
  });

  player.on("error", error => {
    console.error(`[poke-discord-bridge] Voice player error in guild ${guildId}:`, error);
    void advanceQueue(client, session, announce);
  });

  connection.on("stateChange", (_, next) => {
    if (next.status === discordVoice.VoiceConnectionStatus.Destroyed) {
      session.destroyed = true;
      sessionsRef.current.delete(guildId);
      return;
    }

    if (next.status === discordVoice.VoiceConnectionStatus.Disconnected) {
      void (async () => {
        try {
          await discordVoice.entersState(connection, discordVoice.VoiceConnectionStatus.Signalling, 5_000);
        } catch {
          if (!session.destroyed) {
            connection.destroy();
          }
        }
      })();
    }
  });

  try {
    await discordVoice.entersState(connection, discordVoice.VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
  } catch (error) {
    connection.destroy();
    sessionsRef.current.delete(guildId);
    throw new Error(`Failed to join the voice channel: ${error instanceof Error ? error.message : String(error)}`);
  }

  return session;
}

function destroySession(sessions: Map<string, VoiceSession>, guildId: string): void {
  const session = sessions.get(guildId);
  if (!session || session.destroyed) return;
  session.destroyed = true;
  clearIdleTimer(session);
  session.queue = [];
  session.currentTrack = null;
  try {
    session.player.stop(true);
  } catch {
    // Ignore stop failures during teardown.
  }
  try {
    session.connection?.destroy();
  } catch {
    // Ignore teardown failures.
  }
  sessions.delete(guildId);
}

async function advanceQueue(client: Client, session: VoiceSession, announce: (channelId: string, content: string) => Promise<void>): Promise<void> {
  if (session.destroyed) return;
  const nextTrack = session.queue.shift() ?? null;

  if (!nextTrack) {
    session.currentTrack = null;
    scheduleIdleLeave(session, announce);
    return;
  }

  clearIdleTimer(session);
  session.currentTrack = nextTrack;
  const nonce = ++session.playNonce;

  try {
    const { discordVoice, playDl } = await loadVoiceLibraries();
    const info = await playDl.video_basic_info(buildResourceUrl(nextTrack));
    if (session.destroyed || session.playNonce !== nonce) return;

    const source = await playDl.stream_from_info(info, { discordPlayerCompatibility: true });
    if (session.destroyed || session.playNonce !== nonce) return;

    const resource = discordVoice.createAudioResource(source.stream, {
      inputType: source.type as any,
      metadata: summarizeTrack(nextTrack)
    });

    session.player.play(resource);
  } catch (error) {
    console.error(`[poke-discord-bridge] Failed to play track in guild ${session.guildId}:`, error);
    if (session.destroyed || session.playNonce !== nonce) return;

    session.currentTrack = null;
    const announcementChannelId = session.textChannelId;
    if (announcementChannelId) {
      try {
        await announce(announcementChannelId, `I couldn't play ${nextTrack.title}. Skipping it.`);
      } catch {
        // Best effort only.
      }
    }

    if (session.queue.length) {
      await advanceQueue(client, session, announce);
      return;
    }

    scheduleIdleLeave(session, announce);
  }
}

function requireSession(sessions: Map<string, VoiceSession>, guildId: string): VoiceSession {
  const session = getGuildSession(sessions, guildId);
  if (!session) {
    throw new Error("Poke is not in a voice channel in this server.");
  }
  return session;
}

function ensureSameChannel(session: VoiceSession, requesterVoiceChannelId: string | null): void {
  if (!requesterVoiceChannelId || session.voiceChannelId !== requesterVoiceChannelId) {
    throw new Error(`Poke is in <#${session.voiceChannelId}>. Join that channel to control playback.`);
  }
}

function queueSnapshot(session: VoiceSession): DiscordVoiceSessionSnapshot {
  return summarizeSession(session);
}

export function createVoiceManager(client: Client, announce: (channelId: string, content: string) => Promise<void>): VoiceManager {
  const sessions = sessionsRef.current;

  return {
    describeVoiceContext(guildId, requester) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return null;

      const requesterVoice = readRequesterVoiceChannel(guild, requester.userId);
      const session = getGuildSession(sessions, guildId);

      return {
        requester: buildRequesterSnapshot({
          userId: requester.userId,
          username: requester.username,
          displayName: requester.displayName,
          voiceChannelId: requesterVoice?.id ?? null,
          voiceChannelName: requesterVoice?.name ?? null
        }),
        bot: session ? queueSnapshot(session) : null
      };
    },

    async queueVoiceTrack(input) {
      const guild = client.guilds.cache.get(input.guildId) ?? await client.guilds.fetch(input.guildId);
      const requesterVoice = ensureGuildVoiceChannel(guild, input.requesterVoiceChannelId);
      const track = await buildTrack({
        requesterId: input.requesterId,
        requesterDisplayName: input.requesterDisplayName,
        url: input.url
      });

      const session = getGuildSession(sessions, input.guildId) ?? await createSession(client, input.guildId, requesterVoice.id, requesterVoice.name, input.textChannelId, announce);

      if (session.voiceChannelId !== requesterVoice.id) {
        throw new Error(`Poke is already in <#${session.voiceChannelId}>. Join that channel to queue music.`);
      }

      session.textChannelId = input.textChannelId;
      clearIdleTimer(session);

      if (input.position === "front") {
        session.queue.unshift(track);
      } else {
        session.queue.push(track);
      }

      const { discordVoice } = await loadVoiceLibraries();
      const shouldStart = !session.currentTrack && session.player.state.status === discordVoice.AudioPlayerStatus.Idle;
      if (shouldStart) {
        await advanceQueue(client, session, announce);
      }

      return {
        ok: true,
        action: "queueVoiceTrack",
        message: shouldStart ? `Joined <#${session.voiceChannelId}> and started ${track.title}.` : `Queued ${track.title}.`,
        session: queueSnapshot(session),
        track: summarizeTrack(track)
      };
    },

    async controlVoicePlayback(input) {
      const guild = client.guilds.cache.get(input.guildId) ?? await client.guilds.fetch(input.guildId);
      const requesterVoice = input.requesterVoiceChannelId ? ensureGuildVoiceChannel(guild, input.requesterVoiceChannelId) : null;
      const existingSession = getGuildSession(sessions, input.guildId);

      if (input.action !== "join" && !existingSession) {
        throw new Error("Poke is not in a voice channel in this server.");
      }

      if (input.action !== "join") {
        if (!requesterVoice?.id) {
          throw new Error("Join Poke in the voice channel to control playback.");
        }
        if (existingSession && existingSession.voiceChannelId !== requesterVoice.id) {
          throw new Error(`Poke is in <#${existingSession.voiceChannelId}>. Join that channel to control playback.`);
        }
      } else if (existingSession && requesterVoice?.id && existingSession.voiceChannelId !== requesterVoice.id) {
        throw new Error(`Poke is in <#${existingSession.voiceChannelId}>. Join that channel to control playback.`);
      }

      let session = existingSession;
      if (input.action === "join") {
        if (!requesterVoice?.id) {
          throw new Error("Join a voice channel first.");
        }

        if (!session) {
          session = await createSession(client, input.guildId, requesterVoice.id, requesterVoice.name, input.textChannelId, announce);
        }
      }

      if (!session) {
        throw new Error("Poke is not in a voice channel in this server.");
      }

      session.textChannelId = input.textChannelId;

      switch (input.action) {
        case "join": {
          if (session.voiceChannelId !== requesterVoice?.id) {
            throw new Error(`Poke is already in <#${session.voiceChannelId}>. Join that channel to control playback.`);
          }
          return {
            ok: true,
            action: "join",
            message: `Ready in <#${session.voiceChannelId}>.`,
            session: queueSnapshot(session)
          };
        }
        case "pause":
          if (session.player.state.status === "paused" || session.player.state.status === "autopaused") {
            return { ok: true, action: "pause", message: "Already paused.", session: queueSnapshot(session) };
          }
          session.player.pause(true);
          return { ok: true, action: "pause", message: "Paused playback.", session: queueSnapshot(session) };
        case "resume":
          if (session.player.state.status !== "paused" && session.player.state.status !== "autopaused") {
            return { ok: true, action: "resume", message: "Playback is not paused.", session: queueSnapshot(session) };
          }
          session.player.unpause();
          return { ok: true, action: "resume", message: "Resumed playback.", session: queueSnapshot(session) };
        case "skip":
          if (!session.currentTrack) {
            return { ok: true, action: "skip", message: "Nothing is playing.", session: queueSnapshot(session) };
          }
          session.player.stop(true);
          return { ok: true, action: "skip", message: "Skipped the current track.", session: queueSnapshot(session) };
        case "stop":
        case "leave": {
          destroySession(sessions, input.guildId);
          return { ok: true, action: input.action, message: "Left the voice channel and cleared playback.", session: null };
        }
        case "current":
          return {
            ok: true,
            action: "current",
            message: session.currentTrack ? `Now playing ${session.currentTrack.title}.` : "Nothing is playing.",
            session: queueSnapshot(session),
            track: session.currentTrack ? summarizeTrack(session.currentTrack) : null
          };
        case "queue":
          return {
            ok: true,
            action: "queue",
            message: session.queue.length ? `There are ${session.queue.length} track${session.queue.length === 1 ? "" : "s"} queued.` : "The queue is empty.",
            session: queueSnapshot(session)
          };
        case "remove": {
          const index = input.index;
          if (index == null || !Number.isInteger(index) || index < 1 || index > session.queue.length) {
            throw new Error("index must point to a queued track.");
          }
          const [removed] = session.queue.splice(index - 1, 1);
          return {
            ok: true,
            action: "remove",
            message: `Removed ${removed.title} from the queue.`,
            session: queueSnapshot(session),
            removedTrack: summarizeTrack(removed)
          };
        }
        case "clear": {
          const removedCount = session.queue.length;
          session.queue = [];
          return {
            ok: true,
            action: "clear",
            message: removedCount ? `Cleared ${removedCount} queued track${removedCount === 1 ? "" : "s"}.` : "The queue is already empty.",
            session: queueSnapshot(session)
          };
        }
        default:
          throw new Error(`Unknown action: ${input.action}`);
      }
    },

    getSessionSnapshot(guildId) {
      const session = getGuildSession(sessions, guildId);
      return session ? queueSnapshot(session) : null;
    }
  };
}

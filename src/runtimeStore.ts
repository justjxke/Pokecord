import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { DiscordRelayRequest, DiscordSentMessageRecord } from "./types";

export interface RuntimeRequestRecord {
  request: DiscordRelayRequest;
  storedAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface RuntimeStore {
  saveRequest(request: DiscordRelayRequest, ttlMs?: number): RuntimeRequestRecord;
  getRequest(bridgeRequestId: string): DiscordRelayRequest | undefined;
  saveSentMessages(bridgeRequestId: string, channelId: string, messageIds: string[]): DiscordSentMessageRecord | undefined;
  getSentMessages(bridgeRequestId: string): DiscordSentMessageRecord | undefined;
  cleanupExpired(now?: number, ttlMs?: number): void;
  close(): void;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export function createRuntimeStore(path: string): RuntimeStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { strict: true });

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS request_contexts (
      bridge_request_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      stored_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sent_messages (
      bridge_request_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS request_contexts_expires_at_idx
      ON request_contexts (expires_at);

    CREATE INDEX IF NOT EXISTS sent_messages_updated_at_idx
      ON sent_messages (updated_at);
  `);

  const upsertRequest = db.query(`
    INSERT INTO request_contexts (
      bridge_request_id,
      payload,
      stored_at,
      updated_at,
      expires_at
    ) VALUES ($bridgeRequestId, $payload, $storedAt, $updatedAt, $expiresAt)
    ON CONFLICT(bridge_request_id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `);

  const selectRequest = db.query("SELECT payload FROM request_contexts WHERE bridge_request_id = ?1");
  const selectSentMessages = db.query("SELECT payload FROM sent_messages WHERE bridge_request_id = ?1");

  const upsertSentMessages = db.query(`
    INSERT INTO sent_messages (
      bridge_request_id,
      channel_id,
      payload,
      updated_at
    ) VALUES ($bridgeRequestId, $channelId, $payload, $updatedAt)
    ON CONFLICT(bridge_request_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);

  const cleanupRequestContexts = db.query("DELETE FROM request_contexts WHERE expires_at < ?1");
  const cleanupSentMessages = db.query("DELETE FROM sent_messages WHERE updated_at < ?1");

  return {
    saveRequest(request, ttlMs = DEFAULT_TTL_MS) {
      const now = Date.now();
      const storedAt = request.replyTarget.createdAt || now;
      const record: RuntimeRequestRecord = {
        request,
        storedAt,
        updatedAt: now,
        expiresAt: storedAt + ttlMs
      };

      upsertRequest.run({
        bridgeRequestId: request.bridgeRequestId,
        payload: JSON.stringify(record),
        storedAt: record.storedAt,
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt
      });

      return record;
    },

    getRequest(bridgeRequestId) {
      const row = selectRequest.get(bridgeRequestId) as { payload: string } | undefined;
      if (!row) return undefined;
      return parseJson<RuntimeRequestRecord>(row.payload).request;
    },

    saveSentMessages(bridgeRequestId, channelId, messageIds) {
      if (!messageIds.length) return undefined;

      const existing = this.getSentMessages(bridgeRequestId);
      const mergedIds = [
        ...(existing?.messageIds ?? []),
        ...messageIds
      ].filter((messageId, index, values) => values.indexOf(messageId) === index);

      const record: DiscordSentMessageRecord = {
        channelId,
        messageIds: mergedIds,
        updatedAt: Date.now()
      };

      upsertSentMessages.run({
        bridgeRequestId,
        channelId,
        payload: JSON.stringify({
          bridgeRequestId,
          ...record
        }),
        updatedAt: record.updatedAt
      });

      return record;
    },

    getSentMessages(bridgeRequestId) {
      const row = selectSentMessages.get(bridgeRequestId) as { payload: string } | undefined;
      if (!row) return undefined;
      return parseJson<{ bridgeRequestId: string; } & DiscordSentMessageRecord>(row.payload);
    },

    cleanupExpired(now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
      cleanupRequestContexts.run(now);
      cleanupSentMessages.run(now - ttlMs);
    },

    close() {
      db.close();
    }
  };
}

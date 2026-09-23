import { randomUUID } from "node:crypto";

import type {
  LocationDeviceState,
  LocationNotification,
  LocationNotificationKind,
  LocationSample,
  LocationVisit,
  SemanticPlace,
} from "../../location/types.js";
import type { StorageDb } from "../types.js";

type Raw = Record<string, unknown>;

export function makeLocationRepo(db: StorageDb) {
  return {
    transaction<T>(fn: () => T): T {
      return db.tx(fn);
    },

    upsertRelayItem(input: {
      id: string;
      payload: string;
      receivedAt: number;
      now: number;
    }): "pending" | "processed" | "failed" {
      db.prepare(
        `INSERT INTO location_relay_items (
          id, payload_ciphertext, received_at, status, attempts, last_error,
          processed_at, updated_at
        ) VALUES (@id, @payload, @received_at, 'pending', 0, NULL, NULL, @now)
        ON CONFLICT(id) DO UPDATE SET
          payload_ciphertext=CASE
            WHEN location_relay_items.status='processed' THEN location_relay_items.payload_ciphertext
            ELSE excluded.payload_ciphertext END,
          received_at=MIN(location_relay_items.received_at, excluded.received_at),
          updated_at=excluded.updated_at`,
      ).run({
        id: input.id,
        payload: input.payload,
        received_at: input.receivedAt,
        now: input.now,
      });
      const row = db.prepare<{ id: string }, Raw>(
        `SELECT status FROM location_relay_items WHERE id=@id`,
      ).get({ id: input.id });
      return status(row?.status);
    },

    markRelayFailed(id: string, error: string, now: number): void {
      db.prepare(
        `UPDATE location_relay_items
            SET status='failed', attempts=attempts+1, last_error=@error,
                processed_at=NULL, updated_at=@now
          WHERE id=@id AND status!='processed'`,
      ).run({ id, error: error.slice(0, 500), now });
    },

    markRelayProcessed(id: string, now: number): void {
      db.prepare(
        `UPDATE location_relay_items
            SET status='processed', attempts=attempts+1, last_error=NULL,
                processed_at=@now, updated_at=@now
          WHERE id=@id`,
      ).run({ id, now });
    },

    insertSample(sample: LocationSample): boolean {
      const result = db.prepare(
        `INSERT INTO location_samples (
          id, relay_item_id, device_id, sampled_at, received_at, latitude,
          longitude, accuracy_meters, quality, processed_at
        ) VALUES (
          @id, @relay_item_id, @device_id, @sampled_at, @received_at, @latitude,
          @longitude, @accuracy_meters, @quality, @processed_at
        ) ON CONFLICT(id) DO NOTHING`,
      ).run({
        id: sample.id,
        relay_item_id: sample.relayItemId,
        device_id: sample.deviceId,
        sampled_at: sample.sampledAt,
        received_at: sample.receivedAt,
        latitude: sample.latitude,
        longitude: sample.longitude,
        accuracy_meters: sample.accuracyMeters,
        quality: sample.quality,
        processed_at: sample.processedAt,
      });
      return Number(result.changes) > 0;
    },

    getDeviceState(deviceId: string): LocationDeviceState | null {
      const row = db.prepare<{ device_id: string }, Raw>(
        `SELECT * FROM location_device_state WHERE device_id=@device_id`,
      ).get({ device_id: deviceId });
      return row ? mapState(row) : null;
    },

    saveDeviceState(state: LocationDeviceState): void {
      db.prepare(
        `INSERT INTO location_device_state (
          device_id, current_visit_id, anchor_latitude, anchor_longitude,
          anchor_sample_count, candidate_started_at, departure_anchor_latitude,
          departure_anchor_longitude, departure_started_at,
          departure_sample_count, last_sample_at, updated_at
        ) VALUES (
          @device_id, @current_visit_id, @anchor_latitude, @anchor_longitude,
          @anchor_sample_count, @candidate_started_at, @departure_anchor_latitude,
          @departure_anchor_longitude, @departure_started_at,
          @departure_sample_count, @last_sample_at, @updated_at
        ) ON CONFLICT(device_id) DO UPDATE SET
          current_visit_id=excluded.current_visit_id,
          anchor_latitude=excluded.anchor_latitude,
          anchor_longitude=excluded.anchor_longitude,
          anchor_sample_count=excluded.anchor_sample_count,
          candidate_started_at=excluded.candidate_started_at,
          departure_anchor_latitude=excluded.departure_anchor_latitude,
          departure_anchor_longitude=excluded.departure_anchor_longitude,
          departure_started_at=excluded.departure_started_at,
          departure_sample_count=excluded.departure_sample_count,
          last_sample_at=excluded.last_sample_at,
          updated_at=excluded.updated_at`,
      ).run(stateParams(state));
    },

    findPlaceByCellHmacs(cellHmacs: readonly string[]): SemanticPlace | null {
      const get = db.prepare<{ cell_hmac: string }, Raw>(
        `SELECT p.* FROM semantic_place_cells c
          JOIN semantic_places p ON p.id=c.place_id
         WHERE c.cell_hmac=@cell_hmac LIMIT 1`,
      );
      for (const cellHmac of cellHmacs) {
        const row = get.get({ cell_hmac: cellHmac });
        if (row) return mapPlace(row);
      }
      return null;
    },

    createPlace(input: { id: string; cellHmacs: readonly string[]; now: number }): SemanticPlace {
      db.prepare(
        `INSERT INTO semantic_places (id, name, city, created_at, updated_at)
         VALUES (@id, NULL, NULL, @now, @now)`,
      ).run({ id: input.id, now: input.now });
      const insertCell = db.prepare(
        `INSERT INTO semantic_place_cells (cell_hmac, place_id, created_at)
         VALUES (@cell_hmac, @place_id, @created_at)
         ON CONFLICT(cell_hmac) DO NOTHING`,
      );
      for (const cellHmac of input.cellHmacs) {
        insertCell.run({ cell_hmac: cellHmac, place_id: input.id, created_at: input.now });
      }
      return this.getPlace(input.id)!;
    },

    getPlace(id: string): SemanticPlace | null {
      const row = db.prepare<{ id: string }, Raw>(
        `SELECT * FROM semantic_places WHERE id=@id`,
      ).get({ id });
      return row ? mapPlace(row) : null;
    },

    getVisit(id: string): LocationVisit | null {
      const row = db.prepare<{ id: string }, Raw>(visitSelect("WHERE v.id=@id")).get({ id });
      return row ? mapVisit(row) : null;
    },

    createVisit(input: {
      id: string;
      deviceId: string;
      placeId: string;
      arrivedAt: number;
      now: number;
    }): LocationVisit {
      db.prepare(
        `INSERT INTO location_visits (
          id, device_id, place_id, arrived_at, departed_at, created_at, updated_at
        ) VALUES (
          @id, @device_id, @place_id, @arrived_at, NULL, @now, @now
        ) ON CONFLICT(device_id, arrived_at) DO NOTHING`,
      ).run({
        id: input.id,
        device_id: input.deviceId,
        place_id: input.placeId,
        arrived_at: input.arrivedAt,
        now: input.now,
      });
      const row = db.prepare<Record<string, unknown>, Raw>(
        visitSelect("WHERE v.device_id=@device_id AND v.arrived_at=@arrived_at"),
      ).get({ device_id: input.deviceId, arrived_at: input.arrivedAt });
      if (!row) throw new Error("failed to create location visit");
      return mapVisit(row);
    },

    closeVisit(id: string, departedAt: number, now: number): LocationVisit | null {
      db.prepare(
        `UPDATE location_visits
            SET departed_at=COALESCE(departed_at, @departed_at), updated_at=@now
          WHERE id=@id`,
      ).run({ id, departed_at: departedAt, now });
      return this.getVisit(id);
    },

    enqueueNotification(input: {
      id?: string;
      placeId: string;
      visitId: string;
      kind: LocationNotificationKind;
      message: string;
      dueAt: number;
      now: number;
    }): void {
      db.prepare(
        `INSERT INTO location_notifications (
          id, place_id, visit_id, kind, message, due_at, status, claim_token,
          claimed_at, lease_expires_at, sent_at, channel, target_id,
          external_message_id, error, created_at, updated_at
        ) VALUES (
          @id, @place_id, @visit_id, @kind, @message, @due_at, 'pending', NULL,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, @now, @now
        ) ON CONFLICT(visit_id, kind) DO NOTHING`,
      ).run({
        id: input.id ?? randomUUID(),
        place_id: input.placeId,
        visit_id: input.visitId,
        kind: input.kind,
        message: input.message,
        due_at: input.dueAt,
        now: input.now,
      });
    },

    enqueueDueNamingPrompts(now: number, delayMs: number): number {
      const rows = db.prepare<{ due_before: number }, Raw>(
        `SELECT v.id AS visit_id, v.place_id
           FROM location_visits v
           JOIN semantic_places p ON p.id=v.place_id
          WHERE v.departed_at IS NULL
            AND p.name IS NULL
            AND v.arrived_at<=@due_before
            AND NOT EXISTS (
              SELECT 1 FROM location_notifications n
               WHERE n.visit_id=v.id AND n.kind='name_prompt'
            )`,
      ).all({ due_before: now - delayMs });
      for (const row of rows) {
        this.enqueueNotification({
          placeId: text(row.place_id),
          visitId: text(row.visit_id),
          kind: "name_prompt",
          message: "已在一个新地点稳定停留。请按“地点名｜城市”回复，例如“公司｜上海”。不会显示或发送坐标。",
          dueAt: now,
          now,
        });
      }
      return rows.length;
    },

    claimNotification(input: {
      channel: string;
      targetId: string;
      now: number;
    }): LocationNotification | null {
      return db.tx(() => {
        db.prepare(
          `UPDATE location_notifications
              SET status='pending', claim_token=NULL, claimed_at=NULL,
                  lease_expires_at=NULL, updated_at=@now
            WHERE status='claimed' AND lease_expires_at<@now`,
        ).run({ now: input.now });
        const row = db.prepare<{ now: number }, Raw>(
          `SELECT * FROM location_notifications
            WHERE status IN ('pending','failed') AND due_at<=@now
            ORDER BY due_at ASC, created_at ASC LIMIT 1`,
        ).get({ now: input.now });
        if (!row) return null;
        const id = text(row.id);
        const claimToken = randomUUID();
        const result = db.prepare(
          `UPDATE location_notifications
              SET status='claimed', claim_token=@claim_token, claimed_at=@now,
                  lease_expires_at=@lease_expires_at, channel=@channel,
                  target_id=@target_id, error=NULL, updated_at=@now
            WHERE id=@id AND status IN ('pending','failed')`,
        ).run({
          id,
          claim_token: claimToken,
          now: input.now,
          lease_expires_at: input.now + 24 * 60 * 60_000,
          channel: input.channel,
          target_id: input.targetId,
        });
        if (Number(result.changes) === 0) return null;
        const claimed = db.prepare<{ id: string }, Raw>(
          `SELECT * FROM location_notifications WHERE id=@id`,
        ).get({ id });
        return claimed ? mapNotification(claimed) : null;
      });
    },

    markNotification(input: {
      id: string;
      claimToken: string;
      status: "sent" | "failed" | "skipped";
      externalMessageId?: string;
      error?: string;
      now: number;
    }): LocationNotification | null {
      const result = db.prepare(
        `UPDATE location_notifications
            SET status=@status,
                sent_at=CASE WHEN @status='sent' THEN @now ELSE sent_at END,
                due_at=CASE WHEN @status='failed' THEN @now+300000 ELSE due_at END,
                external_message_id=@external_message_id, error=@error,
                lease_expires_at=NULL, updated_at=@now
          WHERE id=@id AND claim_token=@claim_token AND status='claimed'`,
      ).run({
        id: input.id,
        claim_token: input.claimToken,
        status: input.status,
        now: input.now,
        external_message_id: input.externalMessageId ?? null,
        error: input.error?.slice(0, 500) ?? null,
      });
      if (Number(result.changes) === 0) return null;
      const row = db.prepare<{ id: string }, Raw>(
        `SELECT * FROM location_notifications WHERE id=@id`,
      ).get({ id: input.id });
      return row ? mapNotification(row) : null;
    },

    resolvePendingName(input: {
      channel: string;
      targetId: string;
      name: string;
      city: string;
      now: number;
    }): SemanticPlace | null {
      return db.tx(() => {
        const row = db.prepare<Record<string, unknown>, Raw>(
          `SELECT p.* FROM location_notifications n
            JOIN semantic_places p ON p.id=n.place_id
           WHERE n.kind='name_prompt' AND n.status='sent'
             AND n.channel=@channel AND n.target_id=@target_id
             AND p.name IS NULL
           ORDER BY n.sent_at DESC LIMIT 1`,
        ).get({ channel: input.channel, target_id: input.targetId });
        if (!row) return null;
        const id = text(row.id);
        db.prepare(
          `UPDATE semantic_places
              SET name=@name, city=@city, updated_at=@now
            WHERE id=@id AND name IS NULL`,
        ).run({ id, name: input.name, city: input.city, now: input.now });
        return this.getPlace(id);
      });
    },

    listVisitsSince(since: number): LocationVisit[] {
      return db.prepare<{ since: number }, Raw>(
        visitSelect("WHERE v.arrived_at>=@since OR v.departed_at IS NULL")
          + " ORDER BY v.arrived_at ASC",
      ).all({ since }).map(mapVisit);
    },

    upsertDaily(localDate: string, summary: string, now: number): void {
      db.prepare(
        `INSERT INTO location_daily_memories (local_date, summary, generated_at, updated_at)
         VALUES (@local_date, @summary, @now, @now)
         ON CONFLICT(local_date) DO UPDATE SET
           summary=excluded.summary, generated_at=excluded.generated_at,
           updated_at=excluded.updated_at`,
      ).run({ local_date: localDate, summary, now });
    },

    getDaily(localDate: string): string | null {
      const row = db.prepare<{ local_date: string }, Raw>(
        `SELECT summary FROM location_daily_memories WHERE local_date=@local_date`,
      ).get({ local_date: localDate });
      return row ? text(row.summary) : null;
    },

    cleanupProcessed(before: number): { relayItems: number; deviceStates: number } {
      const relayItems = Number(db.prepare<{ before: number }>(
        `DELETE FROM location_relay_items
          WHERE status='processed' AND processed_at<@before`,
      ).run({ before }).changes);
      const deviceStates = Number(db.prepare<{ before: number }>(
        `DELETE FROM location_device_state
          WHERE current_visit_id IS NULL AND updated_at<@before`,
      ).run({ before }).changes);
      return { relayItems, deviceStates };
    },

    deleteUnprocessedRelayItems(): number {
      return Number(db.prepare(
        `DELETE FROM location_relay_items WHERE status IN ('pending','failed')`,
      ).run().changes);
    },

    purgeLocationData(): void {
      db.tx(() => {
        db.exec(`DELETE FROM location_notifications;
                 DELETE FROM location_daily_memories;
                 DELETE FROM location_device_state;
                 DELETE FROM location_samples;
                 DELETE FROM location_relay_items;
                 DELETE FROM location_visits;
                 DELETE FROM semantic_place_cells;
                 DELETE FROM semantic_places;`);
      });
    },
  };
}

function visitSelect(where: string): string {
  return `SELECT v.*, p.name AS place_name, p.city
            FROM location_visits v
            JOIN semantic_places p ON p.id=v.place_id ${where}`;
}

function mapState(row: Raw): LocationDeviceState {
  return {
    deviceId: text(row.device_id),
    currentVisitId: nullableText(row.current_visit_id),
    anchorLatitude: nullableNumber(row.anchor_latitude),
    anchorLongitude: nullableNumber(row.anchor_longitude),
    anchorSampleCount: number(row.anchor_sample_count),
    candidateStartedAt: nullableNumber(row.candidate_started_at),
    departureAnchorLatitude: nullableNumber(row.departure_anchor_latitude),
    departureAnchorLongitude: nullableNumber(row.departure_anchor_longitude),
    departureStartedAt: nullableNumber(row.departure_started_at),
    departureSampleCount: number(row.departure_sample_count),
    lastSampleAt: nullableNumber(row.last_sample_at),
    updatedAt: number(row.updated_at),
  };
}

function stateParams(state: LocationDeviceState): Record<string, unknown> {
  return {
    device_id: state.deviceId,
    current_visit_id: state.currentVisitId,
    anchor_latitude: state.anchorLatitude,
    anchor_longitude: state.anchorLongitude,
    anchor_sample_count: state.anchorSampleCount,
    candidate_started_at: state.candidateStartedAt,
    departure_anchor_latitude: state.departureAnchorLatitude,
    departure_anchor_longitude: state.departureAnchorLongitude,
    departure_started_at: state.departureStartedAt,
    departure_sample_count: state.departureSampleCount,
    last_sample_at: state.lastSampleAt,
    updated_at: state.updatedAt,
  };
}

function mapPlace(row: Raw): SemanticPlace {
  return {
    id: text(row.id),
    name: nullableText(row.name),
    city: nullableText(row.city),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at),
  };
}

function mapVisit(row: Raw): LocationVisit {
  return {
    id: text(row.id),
    deviceId: text(row.device_id),
    placeId: text(row.place_id),
    placeName: nullableText(row.place_name),
    city: nullableText(row.city),
    arrivedAt: number(row.arrived_at),
    departedAt: nullableNumber(row.departed_at),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at),
  };
}

function mapNotification(row: Raw): LocationNotification {
  return {
    id: text(row.id),
    placeId: text(row.place_id),
    visitId: text(row.visit_id),
    kind: text(row.kind) as LocationNotificationKind,
    message: text(row.message),
    dueAt: number(row.due_at),
    status: text(row.status) as LocationNotification["status"],
    claimToken: nullableText(row.claim_token),
    claimedAt: nullableNumber(row.claimed_at),
    leaseExpiresAt: nullableNumber(row.lease_expires_at),
    sentAt: nullableNumber(row.sent_at),
    channel: nullableText(row.channel),
    targetId: nullableText(row.target_id),
    externalMessageId: nullableText(row.external_message_id),
    error: nullableText(row.error),
    createdAt: number(row.created_at),
    updatedAt: number(row.updated_at),
  };
}

function status(value: unknown): "pending" | "processed" | "failed" {
  return value === "processed" || value === "failed" ? value : "pending";
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return value == null ? null : text(value) || null;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : number(value);
}

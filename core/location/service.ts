import { randomUUID } from "node:crypto";

import type { RuntimeNamespace } from "../../agent-contract/dto.js";
import type { ResolvedConfig, ResolvedHome } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import type { Logger } from "../logger/types.js";
import type { Repos } from "../storage/repos/index.js";
import { decryptOwnTracksPayload } from "./crypto.js";
import { distanceMeters, neighborhoodHmacs, stableLocationHmac } from "./geo.js";
import type {
  LocationDeviceState,
  LocationNotification,
  LocationSample,
  LocationVisit,
  OwnTracksLocationPayload,
  RelayItem,
  SemanticPlace,
} from "./types.js";

const LEASE_RENEW_MS = 5 * 60_000;
const LEASE_TTL_SECONDS = 10 * 60;
const PULL_LEASE_SECONDS = 5 * 60;
const DEPARTURE_CONFIRM_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const TICK_MS = 15_000;

type LocationConfig = ResolvedConfig["userProfile"]["location"];

export interface LocationService {
  start(): void;
  stop(): Promise<void>;
  runNow(): Promise<void>;
  context(namespace?: RuntimeNamespace, subjectId?: string): Promise<string>;
  claimNotification(input: {
    channel: string;
    targetId: string;
  }): Promise<{ notification: LocationNotification; claimToken: string } | null>;
  markNotification(input: {
    id: string;
    claimToken: string;
    status: "sent" | "failed" | "skipped";
    externalMessageId?: string;
    error?: string;
  }): Promise<LocationNotification | null>;
  resolveName(input: {
    channel: string;
    targetId: string;
    text: string;
  }): Promise<{ placeId: string; name: string; city: string } | null>;
}

export function createLocationService(deps: {
  repos: Pick<Repos, "location">;
  home: ResolvedHome;
  config: ResolvedConfig;
  log: Logger;
  now?: () => number;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  readConfig?: () => Promise<ResolvedConfig>;
}): LocationService {
  const repo = deps.repos.location;
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const log = deps.log.child({ channel: "core.location" });
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;
  let leasedUrl = "";
  let leaseValidUntil = 0;
  let lastLeaseAt = 0;
  let lastPollAt = 0;
  let disabledHandledUrl: string | null = null;

  async function config(): Promise<ResolvedConfig> {
    if (deps.readConfig) return deps.readConfig();
    try {
      return (await loadConfig(deps.home)).config;
    } catch (err) {
      log.warn("config.reload_failed", { err: messageOf(err) });
      return deps.config;
    }
  }

  function start(): void {
    if (timer || stopped) return;
    timer = setInterval(() => {
      void tick().catch((err) => log.warn("tick.failed", { err: messageOf(err) }));
    }, TICK_MS);
    timer.unref?.();
    void tick().catch((err) => log.warn("startup.failed", { err: messageOf(err) }));
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (running) await running.catch(() => undefined);
    const cfg = await config();
    const relayUrl = safeRelayUrl(cfg.userProfile.location.relayUrl);
    if (relayUrl) await revokeRelay(relayUrl, "shutdown");
    repo.deleteUnprocessedRelayItems();
  }

  async function tick(): Promise<void> {
    if (running) return running;
    running = runTick().finally(() => { running = null; });
    return running;
  }

  async function runTick(): Promise<void> {
    const cfg = await config();
    const location = cfg.userProfile.location;
    const relayUrl = safeRelayUrl(location.relayUrl);
    const enabled = cfg.userProfile.enabled && location.enabled;
    if (!enabled) {
      repo.deleteUnprocessedRelayItems();
      if (relayUrl && disabledHandledUrl !== relayUrl) {
        await revokeRelay(relayUrl, "disabled");
        disabledHandledUrl = relayUrl;
      }
      leasedUrl = "";
      leaseValidUntil = 0;
      lastLeaseAt = 0;
      lastPollAt = 0;
      return;
    }
    disabledHandledUrl = null;
    if (!relayUrl) {
      log.warn("enabled_without_relay_url");
      return;
    }
    const secrets = localSecrets(env);
    if (!secrets.controlToken || !secrets.encryptionKey) {
      log.warn("enabled_without_required_secrets", {
        controlTokenConfigured: Boolean(secrets.controlToken),
        encryptionKeyConfigured: Boolean(secrets.encryptionKey),
      });
      return;
    }
    if (leasedUrl && leasedUrl !== relayUrl) {
      await revokeRelay(leasedUrl, "relay_changed");
      leasedUrl = "";
      leaseValidUntil = 0;
    }
    const timestamp = now();
    if (timestamp - lastLeaseAt >= LEASE_RENEW_MS || leaseValidUntil <= timestamp) {
      try {
        await relayRequest(relayUrl, "/control/lease", secrets.controlToken, {
          ttlSeconds: LEASE_TTL_SECONDS,
        });
        leasedUrl = relayUrl;
        lastLeaseAt = timestamp;
        leaseValidUntil = timestamp + LEASE_TTL_SECONDS * 1_000;
      } catch (err) {
        log.warn("relay.lease_failed", { err: messageOf(err) });
        if (leaseValidUntil <= timestamp) return;
      }
    }
    if (timestamp - lastPollAt >= location.pollIntervalSeconds * 1_000) {
      lastPollAt = timestamp;
      try {
        await pollRelay(relayUrl, secrets, location);
      } catch (err) {
        log.warn("relay.poll_failed", { err: messageOf(err) });
      }
    }
    repo.enqueueDueNamingPrompts(
      timestamp,
      location.namingPromptAfterMinutes * 60_000,
    );
    generateSemanticDailyMemories(cfg, timestamp);
    const removed = repo.cleanupProcessed(
      timestamp - location.rawRetentionDays * DAY_MS,
    );
    if (removed.relayItems > 0 || removed.deviceStates > 0) {
      log.info("retention.cleaned", removed);
    }
  }

  async function pollRelay(
    relayUrl: string,
    secrets: LocalSecrets,
    location: LocationConfig,
  ): Promise<void> {
    const response = await relayRequest(
      relayUrl,
      `/pull?limit=100&leaseSeconds=${PULL_LEASE_SECONDS}`,
      secrets.controlToken,
      {},
    );
    const leaseToken = typeof response.leaseToken === "string" ? response.leaseToken : "";
    const items = Array.isArray(response.items) ? response.items.map(relayItem).filter(notNull) : [];
    if (!leaseToken || items.length === 0) return;
    const acknowledged: string[] = [];
    for (const item of items) {
      const current = repo.upsertRelayItem({ ...item, now: now() });
      if (current === "processed") {
        acknowledged.push(item.id);
        continue;
      }
      try {
        const plaintext = await decryptOwnTracksPayload(item.payload, secrets.encryptionKey);
        if (plaintext._type !== "location") {
          repo.markRelayProcessed(item.id, now());
          acknowledged.push(item.id);
          continue;
        }
        const payload = normalizeLocation(plaintext);
        processLocation(item, payload, location, secrets.hmacKey);
        acknowledged.push(item.id);
      } catch (err) {
        repo.markRelayFailed(item.id, messageOf(err), now());
        log.warn("item.processing_failed", {
          relayItemId: item.id,
          errorKind: errorKind(err),
        });
      }
    }
    if (acknowledged.length > 0) {
      await relayRequest(relayUrl, "/ack", secrets.controlToken, {
        leaseToken,
        ids: acknowledged,
      });
    }
  }

  function processLocation(
    item: RelayItem,
    payload: OwnTracksLocationPayload,
    location: LocationConfig,
    hmacKey: string,
  ): void {
    const deviceSource = payload.topic?.trim() || payload.tid?.trim() || "default-device";
    const deviceId = stableLocationHmac(hmacKey, "device", deviceSource);
    const sampledAt = Math.trunc(payload.tst * 1_000);
    const state = repo.getDeviceState(deviceId);
    const quality: LocationSample["quality"] = payload.acc != null
      && payload.acc > location.maxAccuracyMeters
      ? "inaccurate"
      : state?.lastSampleAt != null && sampledAt <= state.lastSampleAt
        ? "out_of_order"
        : "accepted";
    const sampleId = stableLocationHmac(
      hmacKey,
      "sample",
      [deviceId, sampledAt, payload.lat.toFixed(6), payload.lon.toFixed(6)].join(":"),
    );
    const processedAt = now();
    repo.transaction(() => {
      const inserted = repo.insertSample({
        id: sampleId,
        relayItemId: item.id,
        deviceId,
        sampledAt,
        receivedAt: item.receivedAt,
        latitude: payload.lat,
        longitude: payload.lon,
        accuracyMeters: payload.acc ?? 0,
        quality,
        processedAt,
      });
      if (inserted && quality === "accepted") {
        advanceState(
          state ?? emptyState(deviceId, processedAt),
          payload.lat,
          payload.lon,
          sampledAt,
          processedAt,
          location,
          hmacKey,
        );
      }
      repo.markRelayProcessed(item.id, processedAt);
    });
  }

  function advanceState(
    state: LocationDeviceState,
    latitude: number,
    longitude: number,
    sampledAt: number,
    processedAt: number,
    location: LocationConfig,
    hmacKey: string,
  ): void {
    if (!state.currentVisitId) {
      advanceArrival(state, latitude, longitude, sampledAt, processedAt, location, hmacKey);
      return;
    }
    const visit = repo.getVisit(state.currentVisitId);
    if (!visit || state.anchorLatitude == null || state.anchorLongitude == null) {
      resetArrivalCandidate(state, latitude, longitude, sampledAt, processedAt);
      state.currentVisitId = null;
      repo.saveDeviceState(state);
      return;
    }
    const fromPlace = distanceMeters(
      state.anchorLatitude,
      state.anchorLongitude,
      latitude,
      longitude,
    );
    if (fromPlace <= location.departureRadiusMeters) {
      state.departureAnchorLatitude = null;
      state.departureAnchorLongitude = null;
      state.departureStartedAt = null;
      state.departureSampleCount = 0;
      state.lastSampleAt = sampledAt;
      state.updatedAt = processedAt;
      repo.saveDeviceState(state);
      return;
    }
    const sameDepartureCluster = state.departureAnchorLatitude != null
      && state.departureAnchorLongitude != null
      && distanceMeters(
        state.departureAnchorLatitude,
        state.departureAnchorLongitude,
        latitude,
        longitude,
      ) <= location.clusterRadiusMeters;
    if (!sameDepartureCluster) {
      state.departureAnchorLatitude = latitude;
      state.departureAnchorLongitude = longitude;
      state.departureStartedAt = sampledAt;
      state.departureSampleCount = 1;
    } else {
      const count = state.departureSampleCount;
      state.departureAnchorLatitude = mean(state.departureAnchorLatitude!, latitude, count);
      state.departureAnchorLongitude = mean(state.departureAnchorLongitude!, longitude, count);
      state.departureSampleCount = count + 1;
    }
    const confirmed = state.departureStartedAt != null
      && state.departureSampleCount >= location.departureConfirmSamples
      && sampledAt - state.departureStartedAt >= DEPARTURE_CONFIRM_MS;
    if (!confirmed) {
      state.lastSampleAt = sampledAt;
      state.updatedAt = processedAt;
      repo.saveDeviceState(state);
      return;
    }
    const departedAt = state.departureStartedAt!;
    const departureLat = state.departureAnchorLatitude!;
    const departureLon = state.departureAnchorLongitude!;
    const departureCount = state.departureSampleCount;
    const closed = repo.closeVisit(visit.id, departedAt, processedAt);
    if (closed?.placeName) {
      repo.enqueueNotification({
        placeId: closed.placeId,
        visitId: closed.id,
        kind: "departure",
        message: `已离开${placeLabel(closed)}。`,
        dueAt: processedAt,
        now: processedAt,
      });
    }
    state.currentVisitId = null;
    state.anchorLatitude = departureLat;
    state.anchorLongitude = departureLon;
    state.anchorSampleCount = departureCount;
    state.candidateStartedAt = departedAt;
    state.departureAnchorLatitude = null;
    state.departureAnchorLongitude = null;
    state.departureStartedAt = null;
    state.departureSampleCount = 0;
    state.lastSampleAt = sampledAt;
    state.updatedAt = processedAt;
    repo.saveDeviceState(state);
  }

  function advanceArrival(
    state: LocationDeviceState,
    latitude: number,
    longitude: number,
    sampledAt: number,
    processedAt: number,
    location: LocationConfig,
    hmacKey: string,
  ): void {
    const sameCluster = state.anchorLatitude != null
      && state.anchorLongitude != null
      && distanceMeters(
        state.anchorLatitude,
        state.anchorLongitude,
        latitude,
        longitude,
      ) <= location.clusterRadiusMeters;
    if (!sameCluster) {
      resetArrivalCandidate(state, latitude, longitude, sampledAt, processedAt);
    } else {
      const count = state.anchorSampleCount;
      state.anchorLatitude = mean(state.anchorLatitude!, latitude, count);
      state.anchorLongitude = mean(state.anchorLongitude!, longitude, count);
      state.anchorSampleCount = count + 1;
      state.lastSampleAt = sampledAt;
      state.updatedAt = processedAt;
    }
    const confirmed = state.candidateStartedAt != null
      && state.anchorSampleCount >= location.arrivalMinSamples
      && sampledAt - state.candidateStartedAt >= location.arrivalDwellMinutes * 60_000;
    if (!confirmed) {
      repo.saveDeviceState(state);
      return;
    }
    const cellHmacs = neighborhoodHmacs(
      state.anchorLatitude!,
      state.anchorLongitude!,
      hmacKey,
    );
    const place = repo.findPlaceByCellHmacs(cellHmacs)
      ?? repo.createPlace({ id: randomUUID(), cellHmacs, now: processedAt });
    const visit = repo.createVisit({
      id: randomUUID(),
      deviceId: state.deviceId,
      placeId: place.id,
      arrivedAt: state.candidateStartedAt!,
      now: processedAt,
    });
    state.currentVisitId = visit.id;
    state.anchorSampleCount = 0;
    state.candidateStartedAt = null;
    state.departureAnchorLatitude = null;
    state.departureAnchorLongitude = null;
    state.departureStartedAt = null;
    state.departureSampleCount = 0;
    repo.saveDeviceState(state);
    if (place.name) {
      repo.enqueueNotification({
        placeId: place.id,
        visitId: visit.id,
        kind: "arrival",
        message: `已到达${placeLabel({ ...visit, placeName: place.name, city: place.city })}。`,
        dueAt: processedAt,
        now: processedAt,
      });
    }
  }

  function generateSemanticDailyMemories(cfg: ResolvedConfig, timestamp: number): void {
    const timezone = cfg.userProfile.schedule.timezone;
    const today = localDate(timestamp, timezone);
    const yesterday = localDate(timestamp - DAY_MS, timezone);
    const visits = repo.listVisitsSince(timestamp - 3 * DAY_MS);
    for (const date of [yesterday, today]) {
      const matching = visits.filter((visit) => visitOverlapsDate(visit, date, timezone));
      if (matching.length === 0) continue;
      const summary = matching.map((visit) => {
        const arrivalDate = localDate(visit.arrivedAt, timezone);
        const departureDate = visit.departedAt == null ? null : localDate(visit.departedAt, timezone);
        const start = arrivalDate === date ? localTime(visit.arrivedAt, timezone) : "00:00";
        const end = visit.departedAt != null && departureDate === date
          ? localTime(visit.departedAt, timezone)
          : date === today ? "至今" : "24:00";
        return `${placeLabel(visit)} ${start}–${end}`;
      }).join("；");
      repo.upsertDaily(date, summary, timestamp);
    }
  }

  async function context(_namespace?: RuntimeNamespace, _subjectId?: string): Promise<string> {
    const cfg = await config();
    if (!cfg.userProfile.enabled || !cfg.userProfile.location.enabled) return "";
    const timezone = cfg.userProfile.schedule.timezone;
    const timestamp = now();
    const today = localDate(timestamp, timezone);
    const visits = repo.listVisitsSince(timestamp - 2 * DAY_MS)
      .filter((visit) => visitOverlapsDate(visit, today, timezone));
    const active = visits.filter((visit) => visit.departedAt == null);
    const daily = repo.getDaily(today);
    if (active.length === 0 && !daily) return "";
    const lines = [
      "## Location Context",
      "Semantic location only; coordinates are unavailable and must never be requested or displayed.",
    ];
    if (active.length > 0) {
      lines.push(`Current place: ${active.map(placeLabel).join("、")}`);
    }
    if (daily) lines.push(`Today's visits: ${daily}`);
    return lines.join("\n");
  }

  async function claimNotification(input: {
    channel: string;
    targetId: string;
  }): Promise<{ notification: LocationNotification; claimToken: string } | null> {
    const cfg = await config();
    if (!cfg.userProfile.enabled || !cfg.userProfile.location.enabled) return null;
    const notification = repo.claimNotification({ ...input, now: now() });
    if (!notification?.claimToken) return null;
    return { notification, claimToken: notification.claimToken };
  }

  async function markNotification(input: {
    id: string;
    claimToken: string;
    status: "sent" | "failed" | "skipped";
    externalMessageId?: string;
    error?: string;
  }): Promise<LocationNotification | null> {
    const cfg = await config();
    if (!cfg.userProfile.enabled || !cfg.userProfile.location.enabled) return null;
    return repo.markNotification({ ...input, now: now() });
  }

  async function resolveName(input: {
    channel: string;
    targetId: string;
    text: string;
  }): Promise<{ placeId: string; name: string; city: string } | null> {
    const cfg = await config();
    if (!cfg.userProfile.enabled || !cfg.userProfile.location.enabled) return null;
    const parsed = parsePlaceName(input.text);
    if (!parsed) return null;
    const place = repo.resolvePendingName({ ...input, ...parsed, now: now() });
    return place ? { placeId: place.id, name: place.name!, city: place.city! } : null;
  }

  async function revokeRelay(relayUrl: string, reason: string): Promise<void> {
    const token = localSecrets(env).controlToken;
    if (!token) {
      log.warn("relay.revoke_skipped_missing_token", { reason });
      return;
    }
    try {
      await relayRequest(relayUrl, "/control/revoke", token, {});
      log.info("relay.revoked", { reason });
    } catch (err) {
      log.warn("relay.revoke_failed", { reason, err: messageOf(err) });
    }
  }

  async function relayRequest(
    relayUrl: string,
    path: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetcher(`${relayUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`relay HTTP ${response.status}`);
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  }

  return {
    start,
    stop,
    runNow: tick,
    context,
    claimNotification,
    markNotification,
    resolveName,
  };
}

interface LocalSecrets {
  controlToken: string;
  encryptionKey: string;
  hmacKey: string;
}

function localSecrets(env: NodeJS.ProcessEnv): LocalSecrets {
  const encryptionKey = env.PIGMEMORY_LOCATION_ENCRYPTION_KEY?.trim() ?? "";
  return {
    controlToken: env.PIGMEMORY_LOCATION_CONTROL_TOKEN?.trim() ?? "",
    encryptionKey,
    hmacKey: env.PIGMEMORY_LOCATION_HMAC_KEY?.trim() || encryptionKey,
  };
}

function normalizeLocation(value: Record<string, unknown>): OwnTracksLocationPayload {
  const lat = finite(value.lat, "lat");
  const lon = finite(value.lon, "lon");
  const tst = finite(value.tst, "tst");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || tst <= 0) {
    throw new Error("invalid OwnTracks location fields");
  }
  const accuracy = value.acc == null ? 0 : finite(value.acc, "acc");
  if (accuracy < 0) throw new Error("invalid OwnTracks accuracy");
  return {
    _type: "location",
    lat,
    lon,
    tst,
    acc: accuracy,
    topic: typeof value.topic === "string" ? value.topic : undefined,
    tid: typeof value.tid === "string" ? value.tid : undefined,
  };
}

function relayItem(value: unknown): RelayItem | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const payload = typeof value.payload === "string" ? value.payload : "";
  const receivedAt = typeof value.receivedAt === "number" ? value.receivedAt : 0;
  return id && payload && Number.isFinite(receivedAt) && receivedAt > 0
    ? { id, payload, receivedAt }
    : null;
}

function emptyState(deviceId: string, now: number): LocationDeviceState {
  return {
    deviceId,
    currentVisitId: null,
    anchorLatitude: null,
    anchorLongitude: null,
    anchorSampleCount: 0,
    candidateStartedAt: null,
    departureAnchorLatitude: null,
    departureAnchorLongitude: null,
    departureStartedAt: null,
    departureSampleCount: 0,
    lastSampleAt: null,
    updatedAt: now,
  };
}

function resetArrivalCandidate(
  state: LocationDeviceState,
  latitude: number,
  longitude: number,
  sampledAt: number,
  now: number,
): void {
  state.anchorLatitude = latitude;
  state.anchorLongitude = longitude;
  state.anchorSampleCount = 1;
  state.candidateStartedAt = sampledAt;
  state.departureAnchorLatitude = null;
  state.departureAnchorLongitude = null;
  state.departureStartedAt = null;
  state.departureSampleCount = 0;
  state.lastSampleAt = sampledAt;
  state.updatedAt = now;
}

function parsePlaceName(text: string): { name: string; city: string } | null {
  const parts = text.trim().split(/[|｜]/).map((part) => part.trim());
  if (parts.length !== 2) return null;
  const [name, city] = parts;
  if (!name || !city || name.length > 80 || city.length > 80) return null;
  return { name, city };
}

function safeRelayUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
    if (url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function localDate(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function localTime(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function visitOverlapsDate(visit: LocationVisit, date: string, timezone: string): boolean {
  const arrivalDate = localDate(visit.arrivedAt, timezone);
  const departureDate = visit.departedAt == null ? null : localDate(visit.departedAt, timezone);
  return arrivalDate <= date && (departureDate == null || departureDate >= date);
}

function placeLabel(visit: Pick<LocationVisit, "placeName" | "city">): string {
  const name = visit.placeName || "未命名地点";
  return visit.city ? `${name}（${visit.city}）` : name;
}

function mean(current: number, next: number, count: number): number {
  return count <= 0 ? next : (current * count + next) / (count + 1);
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid OwnTracks ${field}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorKind(err: unknown): string {
  const message = messageOf(err).toLowerCase();
  if (message.includes("authentication")) return "decrypt_authentication";
  if (message.includes("encrypted")) return "encrypted_envelope";
  if (message.includes("owntracks")) return "payload_validation";
  return "processing";
}

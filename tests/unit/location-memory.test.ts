import sodium from "libsodium-wrappers";
import { afterEach, describe, expect, it } from "vitest";

import { resolveConfig } from "../../core/config/index.js";
import { ownTracksKey, decryptOwnTracksPayload } from "../../core/location/crypto.js";
import { createLocationService } from "../../core/location/service.js";
import { initTestLogger, rootLogger } from "../../core/logger/index.js";
import { openDb } from "../../core/storage/connection.js";
import { runMigrations } from "../../core/storage/migrator.js";
import { makeRepos } from "../../core/storage/repos/index.js";
import type { StorageDb } from "../../core/storage/types.js";

initTestLogger();

const databases: StorageDb[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe("location memory sidecar", () => {
  it("is disabled by default and the profile master switch wins", () => {
    const defaults = resolveConfig({});
    expect(defaults.userProfile.location.enabled).toBe(false);
    const forcedOff = resolveConfig({
      userProfile: {
        enabled: false,
        location: { enabled: true, relayUrl: "https://relay.example" },
      },
    });
    expect(forcedOff.userProfile.enabled).toBe(false);
    expect(forcedOff.userProfile.location.enabled).toBe(true);
  });

  it("decrypts the OwnTracks nonce+ciphertext SecretBox envelope", async () => {
    const secret = "correct horse";
    const plaintext = { _type: "location", lat: 31.2, lon: 121.4, tst: 1_700_000_000 };
    const envelope = await encryptOwnTracks(plaintext, secret);
    await expect(decryptOwnTracksPayload(envelope, secret)).resolves.toEqual(plaintext);
    await expect(decryptOwnTracksPayload(envelope, "wrong key")).rejects.toThrow(
      "authentication failed",
    );
  });

  it("leases, decrypts, deduplicates, confirms arrival/departure, and ACKs only successes", async () => {
    const db = memoryDb();
    const repos = makeRepos(db);
    const secret = "owntracks-test-key";
    const controlToken = "relay-control-token";
    const baseSeconds = 1_786_320_000;
    let now = (baseSeconds + 20 * 60) * 1_000;
    const pulls: Array<Array<{ id: string; payload: string; receivedAt: number }>> = [
      await Promise.all([
        locationItem("a1", baseSeconds, 31.2304, 121.4737, secret),
        locationItem("a2", baseSeconds + 10 * 60, 31.23045, 121.47375, secret),
        locationItem("a3", baseSeconds + 20 * 60, 31.23042, 121.47372, secret),
      ]),
      await Promise.all([
        locationItem("d1", baseSeconds + 30 * 60, 31.2404, 121.4837, secret),
        locationItem("d2", baseSeconds + 40 * 60, 31.24045, 121.48375, secret),
      ]),
    ];
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path: url.pathname, body });
      expect((init?.headers as Record<string, string>).authorization).toBe(
        `Bearer ${controlToken}`,
      );
      if (url.pathname === "/pull") {
        return Response.json({ leaseToken: `lease-${calls.length}`, items: pulls.shift() ?? [] });
      }
      return Response.json({ ok: true });
    };
    let config = enabledConfig();
    const service = createLocationService({
      repos,
      home: testHome(),
      config,
      log: rootLogger,
      now: () => now,
      fetch: fetcher,
      env: {
        PIGMEMORY_LOCATION_CONTROL_TOKEN: controlToken,
        PIGMEMORY_LOCATION_ENCRYPTION_KEY: secret,
        PIGMEMORY_LOCATION_HMAC_KEY: "separate-neighborhood-key",
      },
      readConfig: async () => config,
    });

    await service.runNow();
    let visits = repos.location.listVisitsSince(0);
    expect(visits).toHaveLength(1);
    expect(visits[0].departedAt).toBeNull();
    expect(visits[0].placeName).toBeNull();
    expect(calls.filter((call) => call.path === "/ack")[0].body.ids).toEqual([
      "a1", "a2", "a3",
    ]);
    expect(await service.context()).toContain("未命名地点");

    now = (baseSeconds + 40 * 60) * 1_000;
    await service.runNow();
    visits = repos.location.listVisitsSince(0);
    expect(visits[0].departedAt).toBe((baseSeconds + 30 * 60) * 1_000);
    expect(calls.filter((call) => call.path === "/ack")[1].body.ids).toEqual(["d1", "d2"]);

    config = resolveConfig({
      userProfile: {
        enabled: false,
        location: { enabled: true, relayUrl: "https://relay.example" },
      },
    });
    await service.runNow();
    await service.runNow();
    expect(calls.filter((call) => call.path === "/control/revoke")).toHaveLength(1);
    expect(await service.context()).toBe("");
    await service.stop();
  });

  it("retains a failed encrypted item locally and does not ACK it", async () => {
    const db = memoryDb();
    const repos = makeRepos(db);
    let now = 1_786_320_000_000;
    const badItem = await locationItem("bad", 1_786_320_000, 31.2, 121.4, "other-key");
    const paths: string[] = [];
    const service = createLocationService({
      repos,
      home: testHome(),
      config: enabledConfig(),
      log: rootLogger,
      now: () => now,
      env: {
        PIGMEMORY_LOCATION_CONTROL_TOKEN: "token",
        PIGMEMORY_LOCATION_ENCRYPTION_KEY: "expected-key",
      },
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === "/pull") {
          return Response.json({ leaseToken: "lease", items: [badItem] });
        }
        return Response.json({ ok: true });
      },
      readConfig: async () => enabledConfig(),
    });
    await service.runNow();
    const row = db.prepare<Record<string, never>, { status: string; last_error: string }>(
      "SELECT status, last_error FROM location_relay_items WHERE id='bad'",
    ).get({});
    expect(row?.status).toBe("failed");
    expect(row?.last_error).not.toContain("31.2");
    expect(paths).not.toContain("/ack");
    now += 60_000;
    await service.stop();
  });

  it("sends one coordinate-free naming prompt and stores a semantic reply", async () => {
    const db = memoryDb();
    const repos = makeRepos(db);
    const secret = "naming-test-key";
    const baseSeconds = 1_786_320_000;
    let now = (baseSeconds + 20 * 60) * 1_000;
    let items = await Promise.all([
      locationItem("n1", baseSeconds, 31.2304, 121.4737, secret),
      locationItem("n2", baseSeconds + 10 * 60, 31.23045, 121.47375, secret),
      locationItem("n3", baseSeconds + 20 * 60, 31.23042, 121.47372, secret),
    ]);
    const config = enabledConfig();
    const service = createLocationService({
      repos,
      home: testHome(),
      config,
      log: rootLogger,
      now: () => now,
      env: {
        PIGMEMORY_LOCATION_CONTROL_TOKEN: "token",
        PIGMEMORY_LOCATION_ENCRYPTION_KEY: secret,
      },
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/pull") {
          const current = items;
          items = [];
          return Response.json({ leaseToken: "lease", items: current });
        }
        return Response.json({ ok: true });
      },
      readConfig: async () => config,
    });
    await service.runNow();
    now = (baseSeconds + 31 * 60) * 1_000;
    await service.runNow();
    const claim = await service.claimNotification({ channel: "feishu", targetId: "chat" });
    expect(claim?.notification.kind).toBe("name_prompt");
    expect(claim?.notification.message).not.toMatch(/31\.230|121\.473/);
    await service.markNotification({
      id: claim!.notification.id,
      claimToken: claim!.claimToken,
      status: "sent",
      externalMessageId: "om_1",
    });
    await expect(service.resolveName({
      channel: "feishu",
      targetId: "chat",
      text: "公司｜上海",
    })).resolves.toMatchObject({ name: "公司", city: "上海" });
    expect(await service.context()).toContain("公司（上海）");
    expect(await service.claimNotification({ channel: "feishu", targetId: "chat" })).toBeNull();
    await service.stop();
  });
});

function memoryDb(): StorageDb {
  const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
  runMigrations(db);
  databases.push(db);
  return db;
}

function enabledConfig() {
  return resolveConfig({
    userProfile: {
      enabled: true,
      location: {
        enabled: true,
        relayUrl: "https://relay.example",
      },
    },
  });
}

function testHome() {
  return {
    root: "/tmp/pigmemory-location-test",
    configFile: "/tmp/pigmemory-location-test/config.yaml",
    dataDir: "/tmp/pigmemory-location-test/data",
    dbFile: "/tmp/pigmemory-location-test/data/memos.db",
    skillsDir: "/tmp/pigmemory-location-test/skills",
    logsDir: "/tmp/pigmemory-location-test/logs",
    daemonDir: "/tmp/pigmemory-location-test/daemon",
  };
}

async function locationItem(
  id: string,
  tst: number,
  lat: number,
  lon: number,
  secret: string,
) {
  return {
    id,
    payload: await encryptOwnTracks({
      _type: "location",
      topic: "owntracks/user/iphone",
      tid: "iP",
      tst,
      lat,
      lon,
      acc: 12,
    }, secret),
    receivedAt: tst * 1_000,
  };
}

async function encryptOwnTracks(value: Record<string, unknown>, secret: string): Promise<string> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const key = ownTracksKey(secret);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  const packed = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);
  sodium.memzero(key);
  return JSON.stringify({ _type: "encrypted", data: packed.toString("base64") });
}

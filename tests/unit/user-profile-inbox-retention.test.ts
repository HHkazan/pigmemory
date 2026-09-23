import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeNamespace } from "../../agent-contract/dto.js";
import { DEFAULT_CONFIG } from "../../core/config/defaults.js";
import { resolveConfig, type ResolvedConfig, type ResolvedHome } from "../../core/config/index.js";
import type { LlmClient } from "../../core/llm/types.js";
import { rootLogger } from "../../core/logger/index.js";
import { ownerFromNamespace } from "../../core/runtime/namespace.js";
import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import type { StorageDb } from "../../core/storage/types.js";
import type { UserContextInboxRow } from "../../core/user-profile/types.js";
import { createUserProfileService } from "../../core/user-profile/service.js";

const DAY_MS = 24 * 60 * 60_000;
const namespace: RuntimeNamespace = { agentKind: "hermes", profileId: "default" };
const owner = ownerFromNamespace(namespace);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("user-profile inbox retention configuration", () => {
  it("defaults to seven integer days and accepts only 1 through 365", () => {
    expect(resolveConfig({}).userProfile.inboxRetentionDays).toBe(7);
    expect(resolveConfig({ userProfile: { inboxRetentionDays: 1 } }).userProfile.inboxRetentionDays).toBe(1);
    expect(resolveConfig({ userProfile: { inboxRetentionDays: 365 } }).userProfile.inboxRetentionDays).toBe(365);
    expect(() => resolveConfig({ userProfile: { inboxRetentionDays: 0 } })).toThrow(/inboxRetentionDays/);
    expect(() => resolveConfig({ userProfile: { inboxRetentionDays: 366 } })).toThrow(/inboxRetentionDays/);
    expect(() => resolveConfig({ userProfile: { inboxRetentionDays: 7.5 } })).toThrow(/inboxRetentionDays/);
  });
});

describe("user-profile inbox retention repository", () => {
  it("deletes only processed rows strictly older than the cutoff across owners and dates", () => {
    const db = testDb();
    const repo = makeRepos(db).userProfile;
    const cutoff = Date.UTC(2026, 7, 7, 12);

    repo.enqueue(inbox("expired_default", cutoff - 1, {
      localDate: "2026-07-01",
    }));
    repo.enqueue(inbox("expired_other_owner", cutoff - DAY_MS, {
      ownerAgentKind: "openclaw",
      ownerProfileId: "work",
      localDate: "2026-06-01",
      subjectId: "another-user",
    }));
    repo.enqueue(inbox("at_cutoff", cutoff, { localDate: "2026-07-31" }));
    repo.enqueue(inbox("recent", cutoff + 1, { localDate: "2026-06-01" }));
    repo.enqueue(inbox("old_unprocessed", null, {
      localDate: "2020-01-01",
      createdAt: cutoff - 100 * DAY_MS,
    }));

    expect(repo.deleteProcessedInboxBefore(cutoff)).toBe(2);
    expect(inboxIds(db)).toEqual(["at_cutoff", "old_unprocessed", "recent"]);
    expect(repo.deleteProcessedInboxBefore(cutoff)).toBe(0);
    db.close();
  });
});

describe("user-profile inbox retention scheduling", () => {
  it("cleans on startup even when the profile master switch is off", async () => {
    const db = testDb();
    const repos = makeRepos(db);
    const currentNow = Date.UTC(2026, 7, 7, 10);
    repos.userProfile.enqueue(inbox("startup_expired", currentNow - 8 * DAY_MS));
    const service = retentionService(repos, DEFAULT_CONFIG, () => currentNow);

    service.start();
    await vi.waitFor(() => expect(inboxIds(db)).toEqual([]));
    service.stop();
    db.close();
  });

  it("cleans at the nightly time with no pending conversations and remains idempotent", async () => {
    vi.useFakeTimers();
    const db = testDb();
    const repos = makeRepos(db);
    let currentNow = Date.UTC(2026, 7, 7, 15, 9); // 23:09 Asia/Shanghai
    const service = retentionService(repos, DEFAULT_CONFIG, () => currentNow);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    repos.userProfile.enqueue(inbox("nightly_expired", currentNow - 8 * DAY_MS));
    currentNow += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(inboxIds(db)).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(inboxIds(db)).toEqual([]);
    service.stop();
    db.close();
  });

  it("runs a truncate checkpoint after deleting expired rows", async () => {
    const db = testDb();
    const repos = makeRepos(db);
    const currentNow = Date.UTC(2026, 7, 7, 10);
    const service = retentionService(repos, DEFAULT_CONFIG, () => currentNow);
    repos.userProfile.enqueue(inbox("manual_expired", currentNow - 8 * DAY_MS));
    const checkpoint = vi.spyOn(repos.userProfile, "checkpointWalTruncate");

    await expect(service.runNow()).resolves.toMatchObject({ failed: 0, processed: 0 });
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(inboxIds(db)).toEqual([]);

    db.close();
  });

  it("does not fail a successful consolidation when cleanup throws", async () => {
    const db = testDb();
    const repos = makeRepos(db);
    const currentNow = Date.UTC(2026, 7, 7, 15, 20);
    const config: ResolvedConfig = {
      ...DEFAULT_CONFIG,
      userProfile: { ...DEFAULT_CONFIG.userProfile, enabled: true },
    };
    repos.userProfile.enqueue(inbox("pending_for_consolidation", null, {
      localDate: "2026-08-07",
      ts: currentNow,
    }));
    const llm = {
      model: "fake-profile-model",
      completeJson: async () => ({
        value: {
          profileFacts: [],
          summary: "当天摘要",
          highlights: [],
          events: [],
          openLoops: [],
          moodSignals: [],
          proactiveCandidate: null,
        },
        raw: "{}",
        provider: "local_only",
        model: "fake-profile-model",
        servedBy: "local_only",
        durationMs: 1,
      }),
    } as unknown as LlmClient;
    const service = createUserProfileService({
      repos,
      llm,
      home: fakeHome(),
      defaultNamespace: namespace,
      config,
      readConfig: async () => config,
      log: rootLogger,
      now: () => currentNow,
    });

    vi.spyOn(repos.userProfile, "deleteProcessedInboxBefore").mockImplementation(() => {
      throw new Error("simulated cleanup failure");
    });
    await expect(service.runNow({ memoryDate: "2026-08-07" })).resolves.toMatchObject({
      failed: 0,
      processed: 1,
    });
    expect(repos.userProfile.listPending({
      ...owner,
      subjectId: "user-a",
      memoryDate: "2026-08-07",
    })).toEqual([]);
    db.close();
  });
});

function testDb(): StorageDb {
  const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
  runMigrations(db);
  return db;
}

function inbox(
  id: string,
  processedAt: number | null,
  patch: Partial<UserContextInboxRow> = {},
): UserContextInboxRow {
  return {
    id,
    ...owner,
    subjectId: "user-a",
    sessionId: `session-${id}`,
    episodeId: null,
    traceId: null,
    localDate: "2026-07-30",
    ts: 1,
    userText: "raw user turn",
    agentText: "raw agent turn",
    context: {},
    processedAt,
    createdAt: 1,
    ...patch,
  };
}

function inboxIds(db: StorageDb): string[] {
  return db.prepare<undefined, { id: string }>(
    "SELECT id FROM user_context_inbox ORDER BY id ASC",
  ).all().map((row) => row.id);
}

function retentionService(
  repos: ReturnType<typeof makeRepos>,
  config: ResolvedConfig,
  now: () => number,
) {
  return createUserProfileService({
    repos,
    llm: null,
    home: fakeHome(),
    defaultNamespace: namespace,
    config,
    readConfig: async () => config,
    log: rootLogger,
    now,
  });
}

function fakeHome(): ResolvedHome {
  return {
    root: "/tmp/pigmemory-user-profile-retention-test",
    configFile: "/tmp/pigmemory-user-profile-retention-test/config.yaml",
    dataDir: "/tmp/pigmemory-user-profile-retention-test/data",
    dbFile: "/tmp/pigmemory-user-profile-retention-test/data/memos.db",
    skillsDir: "/tmp/pigmemory-user-profile-retention-test/skills",
    logsDir: "/tmp/pigmemory-user-profile-retention-test/logs",
  };
}

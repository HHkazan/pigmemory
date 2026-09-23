import { describe, expect, it } from "vitest";

import type { RuntimeNamespace } from "../../agent-contract/dto.js";
import { DEFAULT_CONFIG } from "../../core/config/defaults.js";
import type { ResolvedConfig, ResolvedHome } from "../../core/config/index.js";
import type { LlmClient } from "../../core/llm/types.js";
import { rootLogger } from "../../core/logger/index.js";
import { ownerFromNamespace } from "../../core/runtime/namespace.js";
import { makeRepos, openDb, runMigrations } from "../../core/storage/index.js";
import { createUserProfileService } from "../../core/user-profile/service.js";
import { addLocalDays, isTimeAtOrAfter, isWithinQuietHours, zonedClock } from "../../core/user-profile/time.js";

const namespace: RuntimeNamespace = {
  agentKind: "hermes",
  profileId: "default",
};
const owner = ownerFromNamespace(namespace);

describe("sidecar user-profile memory", () => {
  it("stores profile data outside every L1/L2/L3 table and claims outbox rows once", () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    const repo = repos.userProfile;
    const subjectId = "ou_user_1";

    repo.enqueue({
      id: "uci_1",
      ...owner,
      subjectId,
      sessionId: "se_1",
      episodeId: "ep_1",
      traceId: "tr_audit_only",
      localDate: "2026-08-07",
      ts: 100,
      userText: "我喜欢直接的技术讨论",
      agentText: "知道了",
      context: { platform: "feishu" },
      processedAt: null,
      createdAt: 100,
    });

    expect(repo.pendingDatesThrough("2026-08-07")).toHaveLength(1);
    expect(repos.traces.count()).toBe(0);
    expect(repos.policies.count()).toBe(0);
    expect(repos.worldModel.count()).toBe(0);
    expect(repos.skills.count()).toBe(0);

    repo.upsertFact({
      id: "upf_1",
      ...owner,
      subjectId,
      dimension: "communication_style",
      claim: "用户喜欢直接的技术讨论",
      evidenceKind: "explicit",
      confidence: 0.95,
      sourceInboxIds: ["uci_1"],
      firstSeenAt: 100,
      lastConfirmedAt: 100,
      updatedAt: 100,
      status: "active",
      editedAt: null,
    });
    repo.upsertDaily({
      id: "udm_1",
      ...owner,
      subjectId,
      memoryDate: "2026-08-07",
      summary: "设计用户画像功能。",
      highlights: ["确定画像独立于 L1/L2/L3"],
      events: [],
      openLoops: ["继续实现"],
      moodSignals: [],
      sourceInboxIds: ["uci_1"],
      createdAt: 100,
      updatedAt: 100,
    });
    repo.upsertProactive({
      id: "pai_1",
      ...owner,
      subjectId,
      sourceDate: "2026-08-07",
      reason: "有明确的未完成计划",
      message: "昨天那个画像功能，今天还继续吗？",
      score: 0.9,
      dueDate: "2026-08-08",
      dueTime: "09:30",
      status: "pending",
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      sentAt: null,
      channel: null,
      targetId: null,
      externalMessageId: null,
      error: null,
      createdAt: 100,
      updatedAt: 100,
    });

    const claimed = repo.claimDue({
      ...owner,
      subjectId,
      localDate: "2026-08-08",
      localTime: "09:31",
      channel: "feishu",
      targetId: "chat_1",
    }, 200);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.claimToken).toBeTruthy();
    expect(repo.claimDue({
      ...owner,
      subjectId,
      localDate: "2026-08-08",
      localTime: "09:31",
      channel: "feishu",
      targetId: "chat_1",
    }, 201)).toBeNull();

    const sent = repo.markProactive({
      id: "pai_1",
      claimToken: claimed!.claimToken!,
      status: "sent",
      externalMessageId: "om_1",
    }, 250);
    expect(sent?.status).toBe("sent");
    expect(repo.sentCount({ ...owner, subjectId, dueDate: "2026-08-08" })).toBe(1);
    db.close();
  });

  it("captures raw turns cheaply, consolidates at night, and builds separate context", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    const fixedNow = Date.UTC(2026, 7, 7, 15, 20); // 23:20 Asia/Shanghai
    const config = enabledConfig();
    const llm = {
      model: "fake-profile-model",
      completeJson: async () => ({
        value: {
          profileFacts: [{
            dimension: "communication_style",
            claim: "用户喜欢直接、具体的技术讨论",
            evidenceKind: "explicit",
            confidence: 0.95,
            evidenceInboxIds: ["uci_fake"],
          }],
          summary: "用户确定了独立用户画像的设计。",
          highlights: ["画像与 L1/L2/L3 隔离"],
          events: [{
            kind: "decision",
            summary: "决定在深夜整理用户画像",
            state: "observed",
            salience: 0.9,
            confidence: 0.95,
            evidenceInboxIds: [],
          }],
          openLoops: ["继续完成实现"],
          moodSignals: [],
          proactiveCandidate: {
            reason: "存在明确未完成事项",
            message: "昨天的用户画像功能，今天要继续收尾吗？",
            score: 0.88,
          },
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
      now: () => fixedNow,
    });

    expect(await service.captureTurn({
      namespace,
      subjectId: "ou_user_2",
      sessionId: "se_2",
      episodeId: "ep_2",
      traceId: "tr_audit",
      userText: "我希望每天晚上十一点后整理，并且画像不要进入 L1/L2/L3。",
      agentText: "明白。",
      ts: fixedNow,
      context: { platform: "feishu" },
    })).toBe(true);

    const pending = repos.userProfile.listPending({
      ...owner,
      subjectId: "ou_user_2",
      memoryDate: "2026-08-07",
    });
    expect(pending).toHaveLength(1);
    // Match the generated inbox id so evidence validation stays auditable.
    const originalComplete = llm.completeJson.bind(llm);
    llm.completeJson = (async (...args: Parameters<LlmClient["completeJson"]>) => {
      const result = await originalComplete(...args);
      (result.value as any).profileFacts[0].evidenceInboxIds = [pending[0]!.id];
      return result;
    }) as LlmClient["completeJson"];

    const result = await service.runNow({
      namespace,
      subjectId: "ou_user_2",
      memoryDate: "2026-08-07",
    });
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    const snapshot = await service.snapshot(namespace, "ou_user_2");
    expect(snapshot.facts[0]?.claim).toContain("直接");
    const days = await service.daily(namespace, {
      subjectId: "ou_user_2",
      fromDate: "2026-08-07",
      toDate: "2026-08-07",
    });
    expect(days[0]?.summary).toContain("独立用户画像");
    const context = await service.context(namespace, "ou_user_2");
    expect(context).toContain("## User Context");
    expect(context).toContain("communication_style");
    expect(repos.policies.count()).toBe(0);
    expect(repos.worldModel.count()).toBe(0);
    db.close();
  });

  it("does not capture or inject anything when the master switch is off", async () => {
    const db = openDb({ filepath: ":memory:", agent: "test", wal: false });
    runMigrations(db);
    const repos = makeRepos(db);
    const service = createUserProfileService({
      repos,
      llm: null,
      home: fakeHome(),
      defaultNamespace: namespace,
      config: DEFAULT_CONFIG,
      readConfig: async () => DEFAULT_CONFIG,
      log: rootLogger,
      now: () => Date.UTC(2026, 7, 7, 15, 20),
    });
    expect(await service.captureTurn({
      namespace,
      subjectId: "ou_disabled",
      sessionId: "se_disabled",
      userText: "不要记录",
      agentText: "好的",
      ts: Date.UTC(2026, 7, 7, 15, 20),
    })).toBe(false);
    expect(repos.userProfile.pendingDatesThrough("2026-08-07")).toEqual([]);
    expect(await service.context(namespace, "ou_disabled")).toBe("");
    db.close();
  });
});

describe("user-profile local time helpers", () => {
  it("evaluates the 23:10 schedule and cross-midnight quiet hours", () => {
    const clock = zonedClock(Date.UTC(2026, 7, 7, 15, 20), "Asia/Shanghai");
    expect(clock).toMatchObject({ date: "2026-08-07", time: "23:20" });
    expect(isTimeAtOrAfter(clock.time, "23:10")).toBe(true);
    expect(isWithinQuietHours("23:20", "22:30", "08:30")).toBe(true);
    expect(isWithinQuietHours("09:30", "22:30", "08:30")).toBe(false);
    expect(addLocalDays("2026-08-07", 1)).toBe("2026-08-08");
  });
});

function enabledConfig(): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    userProfile: {
      ...DEFAULT_CONFIG.userProfile,
      enabled: true,
      proactiveInteraction: {
        ...DEFAULT_CONFIG.userProfile.proactiveInteraction,
        enabled: true,
      },
    },
  };
}

function fakeHome(): ResolvedHome {
  return {
    root: "/tmp/pigmemory-user-profile-test",
    configFile: "/tmp/pigmemory-user-profile-test/config.yaml",
    dataDir: "/tmp/pigmemory-user-profile-test/data",
    dbFile: "/tmp/pigmemory-user-profile-test/data/memos.db",
    skillsDir: "/tmp/pigmemory-user-profile-test/skills",
    logsDir: "/tmp/pigmemory-user-profile-test/logs",
  };
}

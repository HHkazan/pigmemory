import { describe, expect, it } from "vitest";

import { toPacket } from "../../core/retrieval/injector.js";
import type { RankedCandidate } from "../../core/retrieval/ranker.js";
import type { SkillCandidate } from "../../core/retrieval/types.js";

function rankedSkill(status: "active" | "candidate"): RankedCandidate {
  const candidate: SkillCandidate = {
    tier: "tier1",
    refKind: "skill",
    refId: `skill-${status}`,
    skillName: `${status} skill`,
    status,
    eta: 0.8,
    summary: "Short teaser",
    trigger: "When testing candidate exposure",
    invocationGuide: "SECRET FULL GUIDE\n1. Execute the whole procedure.",
    cosine: 0.9,
    vec: null,
    ts: 1,
  } as SkillCandidate;
  return {
    candidate,
    relevance: 0.9,
    rrf: 0,
    score: 0.9,
    normSq: null,
  };
}

describe("retrieval injector", () => {
  it("keeps candidate skills teaser-only even when full injection is configured", () => {
    const result = toPacket({
      ranked: [rankedSkill("candidate")],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: 1,
      sessionId: "session-1",
      episodeId: "episode-1",
      skillInjectionMode: "full",
    });
    const body = result.packet.snippets[0]?.body ?? "";
    expect(body).toContain("Status: candidate");
    expect(body).toContain("memos_skill_get");
    expect(body).not.toContain("SECRET FULL GUIDE");
  });

  it("allows full inline guides only for active skills", () => {
    const result = toPacket({
      ranked: [rankedSkill("active")],
      reason: "turn_start",
      tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 },
      now: 1,
      sessionId: "session-1",
      episodeId: "episode-1",
      skillInjectionMode: "full",
    });
    expect(result.packet.snippets[0]?.body).toContain("SECRET FULL GUIDE");
  });
});

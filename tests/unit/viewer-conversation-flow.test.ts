import { describe, expect, it } from "vitest";

import { buildConversationFlow } from "../../viewer/src/conversation-flow.js";

describe("viewer conversation flow", () => {
  const traces = [
    { episodeId: "ep-1", sessionId: "session-1", turnId: 1_000, ts: 1_100, userText: "first", toolCalls: [] },
    { episodeId: "ep-1", sessionId: "session-1", turnId: 2_000, ts: 2_100, userText: "second", toolCalls: [] },
  ];

  it("places exact turn-start retrieval before Hermes and capture after Hermes", () => {
    const result = buildConversationFlow(traces, [
      { id: 1, toolName: "memos_search", input: { type: "turn_start" }, episodeId: "ep-1", turnId: "2000", calledAt: 2_010 },
      { id: 2, toolName: "memory_add", input: { phase: "lite" }, episodeId: "ep-1", turnId: "2000", calledAt: 2_200 },
    ]);
    expect(result.turns[1]?.memosBefore[0]).toMatchObject({ id: 1, flowAssociation: "exact" });
    expect(result.turns[1]?.memosAfter[0]).toMatchObject({ id: 2, flowAssociation: "exact" });
  });

  it("associates legacy episode logs causally without claiming an exact id", () => {
    const result = buildConversationFlow(traces, [
      { id: 3, toolName: "task_done", episodeId: "ep-1", calledAt: 2_500 },
    ]);
    expect(result.turns[1]?.memosAfter[0]).toMatchObject({ id: 3, flowAssociation: "episode_time" });
  });

  it("uses a bounded session-time fallback and leaves unrelated logs asynchronous", () => {
    const result = buildConversationFlow(traces, [
      { id: 4, toolName: "session_relation_classify", sessionId: "session-1", calledAt: 2_020 },
      { id: 5, toolName: "system_error", sessionId: "session-1", calledAt: 4_000_000 },
    ]);
    expect(result.turns[1]?.memosBefore[0]).toMatchObject({ id: 4, flowAssociation: "session_time" });
    expect(result.asynchronousLogs).toEqual([expect.objectContaining({ id: 5 })]);
  });
});

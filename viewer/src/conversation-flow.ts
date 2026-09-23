export type FlowAssociation = "exact" | "episode_time" | "session_time";

export interface FlowLog extends Record<string, any> {
  flowAssociation: FlowAssociation;
}

export interface ConversationFlowTurn {
  key: string;
  episodeId: string;
  turnId: string;
  at: number;
  endedAt: number;
  traces: any[];
  memosBefore: FlowLog[];
  memosAfter: FlowLog[];
}

export interface ConversationFlow {
  turns: ConversationFlowTurn[];
  asynchronousLogs: any[];
}

const SESSION_ASSOCIATION_WINDOW_MS = 30 * 60 * 1_000;

export function buildConversationFlow(traces: any[], logs: any[]): ConversationFlow {
  const byKey = new Map<string, ConversationFlowTurn>();
  for (const trace of traces) {
    const episodeId = String(trace.episodeId ?? "");
    const turnId = String(trace.turnId ?? trace.ts ?? "");
    if (!episodeId || !turnId) continue;
    const key = `${episodeId}:${turnId}`;
    const at = finiteTime(trace.turnId) ?? finiteTime(trace.ts) ?? 0;
    const endedAt = Math.max(
      finiteTime(trace.ts) ?? at,
      ...((Array.isArray(trace.toolCalls) ? trace.toolCalls : []).map((tool: any) => finiteTime(tool.endedAt) ?? finiteTime(tool.startedAt) ?? at)),
    );
    const current = byKey.get(key);
    if (current) {
      current.traces.push(trace);
      current.at = current.at > 0 ? Math.min(current.at, at || current.at) : at;
      current.endedAt = Math.max(current.endedAt, endedAt);
    } else {
      byKey.set(key, {
        key,
        episodeId,
        turnId,
        at,
        endedAt,
        traces: [trace],
        memosBefore: [],
        memosAfter: [],
      });
    }
  }

  const turns = [...byKey.values()].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const asynchronousLogs: any[] = [];
  for (const log of logs.slice().sort((a, b) => Number(a.calledAt) - Number(b.calledAt))) {
    const association = associateLog(log, turns);
    if (!association) {
      asynchronousLogs.push(log);
      continue;
    }
    const item: FlowLog = { ...log, flowAssociation: association.kind };
    if (isBeforeHermes(log)) association.turn.memosBefore.push(item);
    else association.turn.memosAfter.push(item);
  }
  return { turns, asynchronousLogs };
}

export function associationLabel(value: FlowAssociation): string {
  if (value === "exact") return "精确回合编号";
  if (value === "episode_time") return "按任务片段时间关联";
  return "按会话时间关联";
}

function associateLog(
  log: any,
  turns: ConversationFlowTurn[],
): { turn: ConversationFlowTurn; kind: FlowAssociation } | null {
  if (turns.length === 0) return null;
  const episodeId = String(log.episodeId ?? "");
  const turnId = String(log.turnId ?? "");
  if (episodeId && turnId) {
    const exact = turns.find((turn) => turn.episodeId === episodeId && turn.turnId === turnId);
    if (exact) return { turn: exact, kind: "exact" };
  }

  const episodeTurns = episodeId ? turns.filter((turn) => turn.episodeId === episodeId) : [];
  if (episodeTurns.length > 0) {
    return { turn: closestCausalTurn(episodeTurns, Number(log.calledAt)), kind: "episode_time" };
  }

  if (log.sessionId) {
    const turn = closestByDistance(turns, Number(log.calledAt));
    if (Math.abs(turn.at - Number(log.calledAt)) <= SESSION_ASSOCIATION_WINDOW_MS) {
      return { turn, kind: "session_time" };
    }
  }
  return null;
}

function closestCausalTurn(turns: ConversationFlowTurn[], calledAt: number): ConversationFlowTurn {
  const before = turns.filter((turn) => turn.at <= calledAt);
  if (before.length > 0) return before[before.length - 1]!;
  return closestByDistance(turns, calledAt);
}

function closestByDistance(turns: ConversationFlowTurn[], calledAt: number): ConversationFlowTurn {
  return turns.reduce((best, turn) => (
    Math.abs(turn.at - calledAt) < Math.abs(best.at - calledAt) ? turn : best
  ));
}

function isBeforeHermes(log: any): boolean {
  if (log.toolName === "session_relation_classify") return true;
  return log.toolName === "memos_search" && log.input?.type === "turn_start";
}

function finiteTime(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

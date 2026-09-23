import type { EpisodeId } from "../../agent-contract/dto.js";
import { writeJson } from "../middleware/io.js";
import type { ServerDeps } from "../types.js";
import { writeError, type RouteContext, type Routes } from "./registry.js";

const SHANGHAI_OFFSET = "+08:00";

export function registerMonitorRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/monitor/summary", async () => {
    const base = await deps.core.monitorSummary();
    const components = {
      ...asRecord(base.components),
    };
    const bridge = deps.bridgeStatus?.();
    if (bridge) {
      components.stdioBridge = {
        status: bridge.status === "connected"
          ? "ok"
          : bridge.status === "disconnected"
            ? "error"
            : "warning",
        lastSuccessAt: bridge.lastOkAt,
        lastErrorAt: bridge.lastErrorAt,
        lastError: bridge.lastError,
        uptimeMs: asRecord(components.core).uptimeMs ?? 0,
      };
    }
    const statuses = Object.values(components).map((item) => asRecord(item).status);
    const status = statuses.includes("error")
      ? "fault"
      : statuses.includes("warning")
        ? "degraded"
        : "healthy";
    return { ...base, status, components };
  });

  routes.set("GET /api/v1/monitor/sessions", async (ctx) => {
    const range = shanghaiRange(ctx);
    return await deps.core.monitorSessions({
      ...range,
      cursor: textParam(ctx, "cursor"),
      limit: numberParam(ctx, "limit"),
    });
  });

  routes.set("GET /api/v1/monitor/logs", async (ctx) => {
    const range = shanghaiRange(ctx);
    return await deps.core.monitorLogs({
      ...range,
      sessionId: textParam(ctx, "sessionId") ?? textParam(ctx, "session"),
      episodeId: textParam(ctx, "episodeId") ?? textParam(ctx, "episode"),
      level: textParam(ctx, "level"),
      category: textParam(ctx, "category"),
      cursor: textParam(ctx, "cursor"),
      limit: numberParam(ctx, "limit"),
    });
  });

  routes.set("GET /api/v1/monitor/conversation", async (ctx) => {
    const sessionId = textParam(ctx, "sessionId") ?? textParam(ctx, "session");
    if (!sessionId) {
      writeError(ctx, 400, "invalid_argument", "sessionId is required");
      return undefined;
    }
    const range = shanghaiRange(ctx);
    const episodes = await deps.core.listEpisodeRows({
      sessionId,
      limit: 500,
      offset: 0,
      includeAllNamespaces: true,
    });
    const timelines = await Promise.all(episodes.map(async (episode) => ({
      episodeId: episode.id,
      traces: await deps.core.timeline({
        episodeId: episode.id as EpisodeId,
        includeAllNamespaces: true,
      }),
    })));
    const traces = timelines.flatMap((timeline) => timeline.traces).filter((trace) => {
      const at = Number(trace.turnId) || Number(trace.ts);
      if (range.fromMs != null && at < range.fromMs) return false;
      if (range.toMs != null && at >= range.toMs) return false;
      return true;
    });
    const visibleEpisodeIds = new Set(traces.map((trace) => trace.episodeId));
    return {
      sessionId,
      episodes: episodes.filter((episode) => visibleEpisodeIds.has(episode.id)),
      traces,
    };
  });

  routes.set("GET /api/v1/monitor/retrieval-runs", async (ctx) => {
    const range = shanghaiRange(ctx);
    return await deps.core.monitorRetrievalRuns({
      ...range,
      sessionId: textParam(ctx, "sessionId") ?? textParam(ctx, "session"),
      source: textParam(ctx, "source"),
      cursor: textParam(ctx, "cursor"),
      limit: numberParam(ctx, "limit"),
    });
  });

  routes.set("GET /api/v1/monitor/today-changes", async () => {
    const now = Date.now();
    return await deps.core.monitorLifecycleChanges({
      fromMs: startOfShanghaiDay(now),
      toMs: now,
      limit: 120,
    });
  });

  routes.setPattern("GET /api/v1/monitor/retrieval-runs/:id", async (ctx) => {
    const run = await deps.core.monitorRetrievalRun(ctx.params.id ?? "");
    if (!run) {
      writeJson(ctx.res, 404, { error: { code: "not_found", message: "retrieval run not found" } });
      return undefined;
    }
    return run;
  });

  routes.setPattern("GET /api/v1/monitor/entities/:kind/:id/history", async (ctx) => {
    const kind = ctx.params.kind ?? "";
    if (!new Set(["trace", "policy", "skill", "world_model", "episode"]).has(kind)) {
      writeJson(ctx.res, 400, { error: { code: "invalid_argument", message: "unknown entity kind" } });
      return undefined;
    }
    return await deps.core.monitorEntityHistory(kind, ctx.params.id ?? "");
  });
}

function shanghaiRange(ctx: RouteContext): { fromMs?: number; toMs?: number } {
  const single = textParam(ctx, "date");
  const from = single ?? textParam(ctx, "from") ?? textParam(ctx, "dateFrom");
  const to = single ?? textParam(ctx, "to") ?? textParam(ctx, "dateTo");
  const fromMs = parseShanghaiDateBoundary(from, false);
  const toMs = parseShanghaiDateBoundary(to, true);
  return {
    ...(fromMs == null ? {} : { fromMs }),
    ...(toMs == null ? {} : { toMs }),
  };
}

export function parseShanghaiDateBoundary(
  value: string | undefined,
  endExclusive: boolean,
): number | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = Date.parse(`${value}T00:00:00.000${SHANGHAI_OFFSET}`);
    return Number.isFinite(start) ? start + (endExclusive ? 24 * 60 * 60 * 1_000 : 0) : undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function startOfShanghaiDay(now: number): number {
  const shifted = new Date(now + 8 * 60 * 60 * 1_000);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - 8 * 60 * 60 * 1_000;
}

function textParam(ctx: RouteContext, name: string): string | undefined {
  const value = ctx.url.searchParams.get(name)?.trim();
  return value || undefined;
}

function numberParam(ctx: RouteContext, name: string): number | undefined {
  const raw = ctx.url.searchParams.get(name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

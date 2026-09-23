import type { ServerDeps } from "../types.js";
import { parseJson, parseQuery, writeError, type Routes } from "./registry.js";

interface ProfileQuery {
  subjectId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: string;
}

export function registerUserProfileRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/user-profile/subjects", async () => ({
    subjects: await deps.core.listUserProfileSubjects(),
  }));

  routes.set("GET /api/v1/user-profile", async (ctx) => {
    const query = parseQuery<ProfileQuery>(ctx);
    return await deps.core.getUserProfileSnapshot({ subjectId: query.subjectId });
  });

  routes.set("GET /api/v1/user-profile/daily", async (ctx) => {
    const query = parseQuery<ProfileQuery>(ctx);
    return {
      dailyMemories: await deps.core.listUserDailyMemories({
        subjectId: query.subjectId,
        fromDate: query.fromDate,
        toDate: query.toDate,
        limit: int(query.limit, 90, 1, 500),
      }),
    };
  });

  routes.set("GET /api/v1/user-profile/interactions", async (ctx) => {
    const query = parseQuery<ProfileQuery>(ctx);
    return {
      interactions: await deps.core.listProactiveInteractions({
        subjectId: query.subjectId,
        limit: int(query.limit, 30, 1, 200),
      }),
    };
  });

  routes.setPattern("PATCH /api/v1/user-profile/facts/:id", async (ctx) => {
    const patch = parseJson<Record<string, unknown>>(ctx);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      writeError(ctx, 400, "invalid_argument", "body must be an object");
      return;
    }
    const updated = await deps.core.updateUserProfileFact(ctx.params.id ?? "", {
      dimension: typeof patch.dimension === "string" ? patch.dimension : undefined,
      claim: typeof patch.claim === "string" ? patch.claim : undefined,
      confidence: typeof patch.confidence === "number" ? patch.confidence : undefined,
      status: patch.status === "active" || patch.status === "archived" ? patch.status : undefined,
    });
    if (!updated) {
      writeError(ctx, 404, "not_found", "user profile fact not found");
      return;
    }
    return updated;
  });

  routes.setPattern("DELETE /api/v1/user-profile/facts/:id", async (ctx) => {
    const result = await deps.core.deleteUserProfileFact(ctx.params.id ?? "");
    if (!result.deleted) {
      writeError(ctx, 404, "not_found", "user profile fact not found");
      return;
    }
    return result;
  });

  routes.set("POST /api/v1/user-profile/run", async (ctx) => {
    const body = ctx.body.length > 0 ? parseJson<Record<string, unknown>>(ctx) : {};
    return await deps.core.runUserProfileNow({
      subjectId: typeof body.subjectId === "string" ? body.subjectId : undefined,
      memoryDate: typeof body.memoryDate === "string" ? body.memoryDate : undefined,
    });
  });
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

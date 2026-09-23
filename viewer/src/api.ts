export const AUTH_REQUIRED_EVENT = "pigmemory:auth-required";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: init?.credentials ?? "same-origin",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
  if (!response.ok) {
    const code = payload?.error?.code;
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    }
    throw new ApiError(
      payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`,
      response.status,
      typeof code === "string" ? code : undefined,
    );
  }
  return payload as T;
}

export function json(method: string, body?: unknown): RequestInit {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

export function qs(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const out = params.toString();
  return out ? `?${out}` : "";
}

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function time(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `${dateTime.format(n)} 北京时间` : "—";
}

export function dayInShanghai(value = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function duration(value: unknown): string {
  const ms = Math.max(0, Number(value) || 0);
  if (ms < 1_000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} 秒`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分 ${Math.round(ms % 60_000 / 1_000)} 秒`;
  return `${Math.floor(ms / 3_600_000)} 小时 ${Math.floor(ms % 3_600_000 / 60_000)} 分`;
}

export function clip(value: unknown, max = 180): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

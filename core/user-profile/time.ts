export interface ZonedClock {
  date: string;
  time: string;
  hour: number;
  minute: number;
}

export function zonedClock(value: number, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "00";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    hour,
    minute,
  };
}

export function addLocalDays(date: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta);
  return new Date(utc).toISOString().slice(0, 10);
}

export function isTimeAtOrAfter(current: string, scheduled: string): boolean {
  return /^\d{2}:\d{2}$/.test(current) && /^\d{2}:\d{2}$/.test(scheduled)
    ? current >= scheduled
    : false;
}

export function isWithinQuietHours(current: string, start: string, end: string): boolean {
  if (start === end) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

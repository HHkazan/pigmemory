/**
 * Append-only JSONL transport.
 *
 * Used by `events-log` and `llm-log` and `perf-log` sinks: those are pure
 * machine-consumed streams where rotation by date is enough (no size cap),
 * streams. Operational streams use the configured retention window; audit
 * callers can opt into permanent monthly history with `keepForever: true`.
 *
 * Implementation note: under the hood this is just `FileRotatingTransport`
 * with `maxSizeMb=0` (date-only rotation) and a "keep forever" mode toggle.
 */

import { FileRotatingTransport, type FileRotatingOptions } from "./file-rotating.js";

export interface JsonlEventsOptions {
  filePath: string;
  /** Default: forever. */
  keepForever?: boolean;
  /** When `keepForever` is false, archives older than this many days get pruned. */
  retentionDays?: number;
  gzip?: boolean;
}

export class JsonlEventsTransport extends FileRotatingTransport {
  constructor(opts: JsonlEventsOptions) {
    const inner: FileRotatingOptions = {
      filePath: opts.filePath,
      format: "json",
      maxSizeMb: 0,                              // date-only rotation
      maxFiles: 0,
      retentionDays: opts.keepForever === false ? opts.retentionDays : undefined,
      gzip: opts.gzip ?? true,
      mode: opts.keepForever === false ? "default" : "audit",
    };
    super(inner);
  }
}

import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileRotatingTransport } from "../../core/logger/transports/file-rotating.js";

describe("file log retention", () => {
  it("removes operational archives by age while preserving audit archives", () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-log-retention-"));
    const operationalPath = join(dir, "memos.log");
    const expiredOperational = `${operationalPath}.expired.log`;
    const retainedOperational = `${operationalPath}.retained.log`;
    const auditPath = join(dir, "audit.log");
    const expiredAudit = `${auditPath}.expired.log`;
    const nowSeconds = Date.now() / 1_000;
    try {
      writeFileSync(expiredOperational, "old\n");
      writeFileSync(retainedOperational, "recent\n");
      writeFileSync(expiredAudit, "permanent\n");
      utimesSync(expiredOperational, nowSeconds - 91 * 86_400, nowSeconds - 91 * 86_400);
      utimesSync(retainedOperational, nowSeconds - 89 * 86_400, nowSeconds - 89 * 86_400);
      utimesSync(expiredAudit, nowSeconds - 365 * 86_400, nowSeconds - 365 * 86_400);

      const operational = new FileRotatingTransport({
        filePath: operationalPath,
        format: "json",
        maxSizeMb: 0,
        maxFiles: 0,
        retentionDays: 90,
        gzip: false,
      });
      const audit = new FileRotatingTransport({
        filePath: auditPath,
        format: "json",
        maxSizeMb: 0,
        maxFiles: 0,
        retentionDays: 90,
        gzip: false,
        mode: "audit",
      });
      operational.close();
      audit.close();

      expect(existsSync(expiredOperational)).toBe(false);
      expect(existsSync(retainedOperational)).toBe(true);
      expect(existsSync(expiredAudit)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const entries = ["bridge.cts", "bridge.mts"] as const;

describe("bridge entry parity", () => {
  it.each(entries)("keeps required lifecycle protections in %s", (entry) => {
    const source = readFileSync(resolve(process.cwd(), entry), "utf8");

    expect(source).toContain("runtimeScope?: string");
    expect(source).toContain("bridge-stdio-${args.runtimeScope}.pid");
    expect(source).toContain("profileId: resolvedProfileId");
    expect(source).toContain("initLogging: true");
    expect(source).toContain("withShutdownTimeout(waitForShutdown");
    expect(source).toContain("isHermesChatRunning");
  });
});

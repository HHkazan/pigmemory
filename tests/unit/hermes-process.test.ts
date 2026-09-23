import { describe, expect, it, vi } from "vitest";

import {
  HERMES_CHAT_PROCESS_PATTERN,
  isHermesChatRunning,
  matchesHermesChatCommandLine,
} from "../../bridge/hermes-process.js";

describe("Hermes chat process detection", () => {
  it("accepts all supported chat invocation shapes", () => {
    expect(matchesHermesChatCommandLine("hermes chat")).toBe(true);
    expect(
      matchesHermesChatCommandLine(
        "/usr/bin/hermes chat --skills memory-routing",
      ),
    ).toBe(true);
    expect(
      matchesHermesChatCommandLine(
        "/usr/bin/hermes --skills memory-routing chat",
      ),
    ).toBe(true);
    expect(
      matchesHermesChatCommandLine(
        "/usr/bin/hermes\0--provider\0local\0chat\0",
      ),
    ).toBe(true);
  });

  it("rejects unrelated processes and non-chat subcommands", () => {
    expect(matchesHermesChatCommandLine("hermes status")).toBe(false);
    expect(matchesHermesChatCommandLine("hermes chatter")).toBe(false);
    expect(matchesHermesChatCommandLine("hermes chat-server")).toBe(false);
    expect(
      matchesHermesChatCommandLine(
        "node /home/user/.hermes/memos-plugin/dist/bridge.mjs",
      ),
    ).toBe(false);
    expect(matchesHermesChatCommandLine("pgrep -af hermes")).toBe(false);
  });

  it("uses a POSIX-safe broad query and validates candidates in JavaScript", () => {
    const execFile = vi.fn(() => [
      "101 node /home/user/.hermes/memos-plugin/dist/bridge.mjs",
      "202 /usr/bin/hermes --skills memory-routing chat",
    ].join("\n"));

    expect(isHermesChatRunning(execFile)).toBe(true);
    expect(HERMES_CHAT_PROCESS_PATTERN).toBe("hermes");
    expect(execFile).toHaveBeenCalledWith(
      "pgrep",
      ["-af", "hermes"],
      { encoding: "utf8", timeout: 1000 },
    );
  });

  it("returns false when broad candidates do not contain a chat process", () => {
    const execFile = vi.fn(() =>
      "101 node /home/user/.hermes/memos-plugin/dist/bridge.mjs",
    );
    expect(isHermesChatRunning(execFile)).toBe(false);
  });
});

/**
 * Hermes chat process detection.
 *
 * The viewer daemon (`bridge.cts --daemon`) wants to know whether the
 * user has a `hermes chat` session attached to *some* bridge stdio
 * process so it can upgrade its own `"disconnected"` status to
 * `"reconnecting"` instead of leaving the viewer permanently red.
 *
 * Implementation: ask `pgrep -af hermes` for a broad candidate list, then
 * validate every full command line with JavaScript. The split is deliberate:
 * procps `pgrep` uses POSIX ERE and rejects JavaScript-only constructs such as
 * non-capturing groups. The JavaScript matcher covers all three CLI invocation
 * shapes the Hermes CLI supports:
 *
 *   • no flags                    — `hermes chat`
 *   • flags after the subcommand  — `hermes chat --skills memory-routing`
 *   • global flags before it      — `hermes --skills memory-routing chat`
 *
 * The third shape is the bug reported in #1915: the previous literal
 * pattern `"hermes chat"` requires the two tokens to be contiguous and
 * therefore misses any invocation with a global flag (`--skills`,
 * `-m`, `--provider`, …) between them.
 *
 * `matchesHermesChatCommandLine()` requires an executable token named
 * `hermes`, followed eventually by a standalone `chat` token. It therefore
 * rejects paths that merely contain `.hermes`, as well as `chatter`,
 * `chat-server`, and flag values such as `--profile=chat`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as childProcess from "node:child_process";

/**
 * Deliberately simple POSIX-compatible pgrep candidate pattern.
 *
 * Exported separately so callers — and tests — can introspect the exact
 * string we hand to `pgrep`. Semantic validation happens in JavaScript.
 */
export const HERMES_CHAT_PROCESS_PATTERN = "hermes";

const HERMES_CHAT_COMMAND_PATTERN =
  /(?:^|[\/\\\s])hermes(?:\s+\S+)*\s+chat(?=\s|$)/;

/**
 * Validate one full process command line. Kept deliberately stateless so
 * callers can pass either `pgrep -af` output or `/proc/<pid>/cmdline` text.
 */
export function matchesHermesChatCommandLine(commandLine: string): boolean {
  return HERMES_CHAT_COMMAND_PATTERN.test(commandLine.replace(/\0/g, " "));
}

/**
 * Shape of the `execFileSync`-compatible helper that
 * `isHermesChatRunning` shells out through. Carved out as a named type
 * so tests can pass a `vi.fn()` without depending on Node's overloaded
 * `ExecFileSyncOptions` union.
 */
export type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number },
) => string;

const defaultExecFileSync: ExecFileSyncLike = (file, args, options) =>
  childProcess.execFileSync(file, [...args], options) as unknown as string;

/**
 * Returns `true` when the broad `pgrep -af` candidate list contains at least
 * one command line accepted by `matchesHermesChatCommandLine`.
 *
 * `pgrep` exits non-zero when there is no match, when it cannot be
 * found, or on permission errors — all of which we collapse into
 * `false` because the caller only uses the boolean to decide whether
 * to upgrade `"disconnected"` to `"reconnecting"`. Surfacing the
 * difference would just turn a UI hint into a noisy crash path.
 *
 * `execFile` is overridable so the unit test can inject a stub instead
 * of mocking `node:child_process` globally — a Node ESM namespace is
 * frozen at import time, so spy-based mocking is brittle. Injection is
 * the same dependency pattern the rest of the bridge uses (see
 * `startStdioServer`'s `stdin` / `stdout` options).
 */
export function isHermesChatRunning(
  execFile: ExecFileSyncLike = defaultExecFileSync,
): boolean {
  try {
    const out = execFile("pgrep", ["-af", HERMES_CHAT_PROCESS_PATTERN], {
      encoding: "utf8",
      timeout: 1000,
    });
    return out.split(/\r?\n/).some(matchesHermesChatCommandLine);
  } catch {
    return false;
  }
}

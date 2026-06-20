/**
 * In-run console renderers selectable per run (issue #65 P10). An `EventSink`
 * consumes already-parsed stream events; the runner owns the streaming/parse
 * logic and only forwards events here.
 *
 *   - `VerboseSink` reproduces today's firehose by delegating to `renderEvent`.
 *   - `ConsoleUi` is the quiet default: it classifies each event into at most
 *     one terse line (edit / commit / tests / error), suppressing the rest.
 *
 * All styling goes through stream-render's TTY-gated primitives, so NO_COLOR
 * and non-TTY output degrade automatically.
 */

import {
  bold,
  cyan,
  dim,
  green,
  red,
  renderEvent,
  SYM,
  type StreamJson,
  type ToolTrack,
} from "./stream-render.js";

export interface EventSink {
  setStage(iteration: number, stage: string): void;
  onEvent(ev: StreamJson): void;
}

/** Reproduces today's in-run output byte-for-byte by delegating to renderEvent. */
export class VerboseSink implements EventSink {
  private readonly toolMap = new Map<string, ToolTrack>();
  setStage(): void {
    // No per-stage header in verbose mode — the loop's own banner stands in.
  }
  onEvent(ev: StreamJson): void {
    renderEvent(ev, this.toolMap);
  }
}

type AssistantBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
};
type UserBlock = {
  type: string;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
};

const TEST_RUNNER_RE =
  /\b(pnpm (run )?test|vitest|tsc|node --test|dotnet test|dotnet build|pytest|go test|cargo test)\b/;

const ERROR_SNIPPET = 160;

/** Quiet renderer: one terse line per meaningful action; suppresses noise. */
export class ConsoleUi implements EventSink {
  // tool_use id → tracking, mirroring renderEvent's toolMap pattern. A pending
  // entry is `kind: "test"` when its Bash command looked like a test/typecheck
  // run, so the paired tool_result can be summarized; "other" entries only carry
  // the name for error attribution.
  private readonly pending = new Map<
    string,
    { name: string; kind: "test" | "other" }
  >();

  setStage(iteration: number, stage: string): void {
    process.stderr.write(
      `${dim(`${SYM.rule}${SYM.rule} iter ${iteration} · ${stage} ${SYM.rule}${SYM.rule}`)}\n`
    );
  }

  onEvent(ev: StreamJson): void {
    if (ev.type === "assistant") this.onAssistant(ev);
    else if (ev.type === "user") this.onUser(ev);
  }

  private onAssistant(ev: StreamJson): void {
    const content =
      (ev as { message?: { content?: AssistantBlock[] } }).message?.content ??
      [];
    for (const block of content) {
      if (block.type !== "tool_use") continue; // suppress text/thinking
      const name = block.name ?? "?";
      const input =
        block.input && typeof block.input === "object"
          ? (block.input as Record<string, unknown>)
          : {};

      if (name === "Edit" || name === "Write") {
        const path = typeof input.file_path === "string" ? input.file_path : "?";
        process.stderr.write(`${cyan(SYM.bullet)} edited ${bold(path)}\n`);
        continue;
      }

      if (name === "Bash") {
        const command =
          typeof input.command === "string" ? input.command : "";
        if (/git commit/.test(command)) {
          const subject = commitSubject(command);
          process.stderr.write(
            `${cyan(SYM.bullet)} committed: ${bold(subject)}\n`
          );
          continue;
        }
        if (TEST_RUNNER_RE.test(command)) {
          if (block.id) this.pending.set(block.id, { name, kind: "test" });
          continue;
        }
        if (block.id) this.pending.set(block.id, { name, kind: "other" });
        continue; // suppress other Bash output until/unless it errors
      }

      // Read/Glob/Grep/anything else: track name (for error attribution), no line.
      if (block.id) this.pending.set(block.id, { name, kind: "other" });
    }
  }

  private onUser(ev: StreamJson): void {
    const content =
      (ev as { message?: { content?: UserBlock[] } }).message?.content ?? [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id;
      const tracked = id ? this.pending.get(id) : undefined;
      if (id) this.pending.delete(id);
      const text = stringifyToolResult(block.content);

      if (block.is_error) {
        const name = tracked?.name ?? "tool";
        const snippet = text.replace(/\s+/g, " ").trim().slice(0, ERROR_SNIPPET);
        process.stderr.write(
          `${red(SYM.cross)} ${bold(name)} failed: ${red(snippet)}${text.length > snippet.length ? " " + SYM.ellip : ""}\n`
        );
        continue;
      }

      if (tracked?.kind === "test") {
        const { ok, summary } = summarizeTests(text);
        const label = ok ? green(SYM.check) : red(`${SYM.cross} FAIL`);
        process.stderr.write(
          `${cyan(SYM.bullet)} tests: ${label}${summary ? " " + dim(summary) : ""}\n`
        );
      }
      // Non-error, non-test results are suppressed in quiet mode.
    }
  }
}

/** Pull the commit subject: the `-m "…"` value, else the first non-empty line. */
function commitSubject(command: string): string {
  const m = command.match(/-m\s+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  if (m) return (m[1] ?? m[2] ?? m[3] ?? "").trim();
  const first = command
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ?? command.trim();
}

/** Classify a test/typecheck result text as pass/fail with a short summary. */
function summarizeTests(text: string): { ok: boolean; summary: string } {
  const flat = text.replace(/\s+/g, " ").trim();
  // A bare fail/error signals trouble, but "0 failed" / "0 errors" do not.
  const hasFailureWord = /\b(fail|failed|failure|error)\b/i.test(flat);
  const onlyZeroFailures = /\b0\s+(failed|failures|errors)\b/i.test(flat);
  const failed = hasFailureWord && !onlyZeroFailures;
  const ok = !failed;
  // Surface the first line that mentions a count/failure, else a short head.
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /\b(fail|error|passed|failed)\b/i.test(l)) ??
    flat.slice(0, 80);
  return { ok, summary: line.slice(0, 80) };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c)
          return String((c as { text: unknown }).text ?? "");
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

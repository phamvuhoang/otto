import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleUi, VerboseSink } from "../console-ui.js";
import type { StreamJson } from "../stream-render.js";

function stderrText(): string {
  return (
    process.stderr.write as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls
    .map((c) => String(c[0]))
    .join("");
}

function stdoutText(): string {
  return (
    process.stdout.write as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls
    .map((c) => String(c[0]))
    .join("");
}

function toolUse(name: string, input: unknown, id = "t1"): StreamJson {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input, id }] },
  } as StreamJson;
}

function toolResult(
  text: string,
  opts: { id?: string; is_error?: boolean } = {}
): StreamJson {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          content: text,
          tool_use_id: opts.id ?? "t1",
          is_error: opts.is_error,
        },
      ],
    },
  } as StreamJson;
}

describe("ConsoleUi (quiet)", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits an edited line for an Edit tool_use", () => {
    new ConsoleUi().onEvent(
      toolUse("Edit", { file_path: "src/foo.ts" })
    );
    expect(stderrText()).toMatch(/edited.*src\/foo\.ts/);
  });

  it("emits an edited line for a Write tool_use", () => {
    new ConsoleUi().onEvent(
      toolUse("Write", { file_path: "src/new.ts" })
    );
    expect(stderrText()).toMatch(/edited.*src\/new\.ts/);
  });

  it("emits a committed line with the -m subject for a git commit Bash", () => {
    new ConsoleUi().onEvent(
      toolUse("Bash", { command: 'git commit -m "feat: x" --no-verify' })
    );
    expect(stderrText()).toMatch(/committed:\s+feat: x/);
  });

  it("summarizes a passing test run from its tool_result", () => {
    const ui = new ConsoleUi();
    ui.onEvent(toolUse("Bash", { command: "pnpm test" }, "tt"));
    ui.onEvent(toolResult("12 passed, 0 failed", { id: "tt" }));
    expect(stderrText()).toMatch(/tests:/);
    expect(stderrText()).not.toMatch(/FAIL/);
  });

  it("summarizes a failing test run from its tool_result", () => {
    const ui = new ConsoleUi();
    ui.onEvent(toolUse("Bash", { command: "vitest run" }, "tt"));
    ui.onEvent(toolResult("1 failed, 3 passed\nError: boom", { id: "tt" }));
    expect(stderrText()).toMatch(/tests:.*FAIL/);
  });

  it("emits a failed line for an is_error tool_result", () => {
    const ui = new ConsoleUi();
    ui.onEvent(toolUse("Bash", { command: "ls /nope" }, "e1"));
    ui.onEvent(
      toolResult("ls: /nope: No such file or directory", {
        id: "e1",
        is_error: true,
      })
    );
    expect(stderrText()).toMatch(/Bash failed:/);
    expect(stderrText()).toMatch(/No such file/);
  });

  it("suppresses assistant text blocks", () => {
    new ConsoleUi().onEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello there" }] },
    } as StreamJson);
    expect(stdoutText()).toBe("");
    expect(stderrText()).toBe("");
  });

  it("suppresses a Read tool_use", () => {
    new ConsoleUi().onEvent(toolUse("Read", { file_path: "src/foo.ts" }));
    expect(stderrText()).toBe("");
    expect(stdoutText()).toBe("");
  });

  it("suppresses a plain (non-test, non-commit) Bash", () => {
    new ConsoleUi().onEvent(toolUse("Bash", { command: "ls -la" }));
    expect(stderrText()).toBe("");
  });

  it("setStage prints a compact header", () => {
    new ConsoleUi().setStage(2, "implementer");
    const out = stderrText();
    expect(out).toMatch(/iter 2/);
    expect(out).toMatch(/implementer/);
  });
});

describe("VerboseSink", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates to renderEvent (firehose) for an assistant text block", () => {
    new VerboseSink().onEvent({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello firehose" }] },
    } as StreamJson);
    expect(stdoutText()).toMatch(/hello firehose/);
  });

  it("renders tool_use previews like renderEvent does (Read shown)", () => {
    new VerboseSink().onEvent(toolUse("Read", { file_path: "src/foo.ts" }));
    expect(stderrText()).toMatch(/Read/);
  });

  it("setStage is a no-op (prints nothing)", () => {
    new VerboseSink().setStage(1, "implementer");
    expect(stderrText()).toBe("");
    expect(stdoutText()).toBe("");
  });
});

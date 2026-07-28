import { describe, expect, it } from "vitest";
import {
  extractGuardCandidate,
  formatKiroAskDecision,
  toRepoRelativePath,
} from "./hook-adapter.js";

describe("formatKiroAskDecision", () => {
  it("emits a Kiro permissionDecision of 'ask' carrying the block feedback as the reason", () => {
    // Regression guard for the enforcement fix: a plain exit-2 block was
    // verified NOT to stop a Kiro agent (MiniMax M2.5 and DeepSeek v3.2 both
    // applied a protected-behavior-removing edit after the hook returned 2).
    // The 'ask' decision routes the gate through the IDE's confirmation prompt
    // instead, so the shape of this payload is load-bearing.
    const feedback = "WHYGUARD BLOCKED THIS EDIT\nProtected property:\nOne key, one order.";

    const parsed: unknown = JSON.parse(formatKiroAskDecision(feedback));

    expect(parsed).toEqual({
      hookSpecificOutput: {
        permissionDecision: "ask",
        permissionDecisionReason: feedback,
      },
    });
  });

  it("produces single-line JSON so it survives being read as hook STDOUT", () => {
    const decision = formatKiroAskDecision("line one\nline two");

    expect(decision).not.toContain("\n");
    // The newline must survive as an escaped sequence inside the JSON string,
    // not as a literal line break that would truncate the payload.
    expect(decision).toContain("\\n");
  });
});

describe("extractGuardCandidate", () => {
  it("extracts a candidate from a real Kiro PreToolUse fs_write event (snake_case)", () => {
    // Captured live from a real Kiro session on 2026-07-26 via a diagnostic
    // PreToolUse hook (paths anonymized) — confirms the actual field names Kiro
    // sends, which are snake_case ("tool_name"/"tool_input"), not the camelCase
    // names this adapter originally only checked for ("toolName"/"toolInput").
    // Before this fix, extractGuardCandidate returned null for every real Kiro
    // hook invocation, so `whyguard hook` silently allowed every edit without
    // ever running any analysis — found via manual end-to-end verification, not
    // a theoretical concern.
    const realEvent = {
      session_id: "sess_45641da5-2277-4406-a314-1ba4b7ae185f",
      hook_event_name: "PreToolUse",
      cwd: "/home/user/projects/example",
      tool_name: "fs_write",
      tool_input: {
        path: "src/payments/create-order.ts",
        text: "export function createOrder() {}\n",
      },
    };

    const candidate = extractGuardCandidate(realEvent);

    expect(candidate).toEqual({
      filePath: "src/payments/create-order.ts",
      afterContent: "export function createOrder() {}\n",
    });
  });

  it("still supports the camelCase tool/toolInput shape", () => {
    const camelCaseEvent = {
      tool: { name: "fs_write", input: { path: "a.ts", text: "content" } },
    };
    expect(extractGuardCandidate(camelCaseEvent)).toEqual({
      filePath: "a.ts",
      afterContent: "content",
    });

    const flatCamelCaseEvent = {
      toolName: "fs_write",
      toolInput: { path: "b.ts", content: "content-b" },
    };
    expect(extractGuardCandidate(flatCamelCaseEvent)).toEqual({
      filePath: "b.ts",
      afterContent: "content-b",
    });
  });

  it("returns a null afterContent for str_replace when no file reader is supplied", () => {
    const strReplaceEvent = {
      tool_name: "str_replace",
      tool_input: {
        path: "src/payments/create-order.ts",
        oldStr: "if (existing) { return existing; }",
        newStr: "",
      },
    };

    expect(extractGuardCandidate(strReplaceEvent)).toEqual({
      filePath: "src/payments/create-order.ts",
      afterContent: null,
    });
  });

  it("computes the full afterContent for str_replace using the supplied file reader", () => {
    const strReplaceEvent = {
      tool_name: "str_replace",
      tool_input: {
        path: "src/payments/create-order.ts",
        oldStr: "if (existing) return existing;",
        newStr: "",
      },
    };
    const currentContent =
      "function createOrder() {\n  if (existing) return existing;\n  return {};\n}\n";

    const candidate = extractGuardCandidate(strReplaceEvent, () => currentContent);

    expect(candidate).toEqual({
      filePath: "src/payments/create-order.ts",
      afterContent: "function createOrder() {\n  \n  return {};\n}\n",
    });
  });

  it("falls back to null afterContent when oldStr matches more than once without replaceAll", () => {
    const strReplaceEvent = {
      tool_name: "str_replace",
      tool_input: { path: "a.ts", oldStr: "foo", newStr: "bar" },
    };
    const currentContent = "foo foo";

    expect(extractGuardCandidate(strReplaceEvent, () => currentContent)).toEqual({
      filePath: "a.ts",
      afterContent: null,
    });
  });

  it("replaces every occurrence when replaceAll is set", () => {
    const strReplaceEvent = {
      tool_name: "str_replace",
      tool_input: { path: "a.ts", oldStr: "foo", newStr: "bar", replaceAll: true },
    };
    const currentContent = "foo foo";

    expect(extractGuardCandidate(strReplaceEvent, () => currentContent)).toEqual({
      filePath: "a.ts",
      afterContent: "bar bar",
    });
  });

  it("falls back to null afterContent when the file reader cannot find the file", () => {
    const strReplaceEvent = {
      tool_name: "str_replace",
      tool_input: { path: "missing.ts", oldStr: "foo", newStr: "bar" },
    };

    expect(extractGuardCandidate(strReplaceEvent, () => null)).toEqual({
      filePath: "missing.ts",
      afterContent: null,
    });
  });

  it("returns null for a tool call that has no recognizable file path", () => {
    // A tool with no path-shaped field at all (e.g. list_directory) must
    // return null rather than throwing, so the hook allows it immediately
    // without invoking any WhyGuard analysis.
    expect(extractGuardCandidate({ tool_name: "list_directory", tool_input: {} })).toBeNull();
  });
});

describe("toRepoRelativePath", () => {
  it("converts a real absolute Windows path under the repo root to a relative one", () => {
    // Reproduces a real false negative found during manual end-to-end
    // verification: Kiro's real tool_input.path is absolute
    // ("C:\\...\\whyguard-fixture\\src\\payments\\create-order.ts"), but every
    // downstream lookup (file read, evidence, rationale contract scope) is keyed
    // on a repo-relative, forward-slash path. Before this conversion,
    // `whyguard hook` silently allowed every edit because the file could never
    // be read at the (wrong) joined path.
    const repoRoot = "C:\\repo\\project\\.tmp\\whyguard-fixture";
    const absolutePath =
      "C:\\repo\\project\\.tmp\\whyguard-fixture\\src\\payments\\create-order.ts";

    expect(toRepoRelativePath(repoRoot, absolutePath)).toBe("src/payments/create-order.ts");
  });

  it("returns an already-relative path unchanged", () => {
    expect(toRepoRelativePath("/repo", "src/a.ts")).toBe("src/a.ts");
  });

  it("returns the original absolute path unchanged when it falls outside the repo root", () => {
    const outsidePath = "/home/someone/other-project/src/a.ts";
    expect(toRepoRelativePath("/repo", outsidePath)).toBe(outsidePath);
  });
});

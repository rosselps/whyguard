/**
 * Translates a Kiro `PreToolUse` hook event (received on STDIN by a `command`
 * action, per this repository's README on hooks) into a WhyGuard `GuardRequest`
 * (see @whyguard/contracts). This module intentionally does not assume Kiro's
 * exact event schema is stable — it reads defensively and only extracts what it
 * needs, falling back to `null`/`undefined` rather than throwing when a field is
 * missing, so an unexpected Kiro event shape degrades to "no sensitive change
 * detected" (exit 0) instead of crashing the hook's hook exit-code contract ("Other non-zero exit: hook failure; do not
 * claim the code is unsafe").
 */

import { isAbsolute, relative, sep } from "node:path";

export type KiroPreToolUseEvent = {
  tool?: { name?: string; input?: Record<string, unknown> };
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // Real Kiro PreToolUse payloads (confirmed via a live capture on 2026-07-26)
  // use snake_case field names instead: `{"tool_name": "fs_write", "tool_input":
  // {"path":..., "text":...}}`. Both shapes are supported here since Kiro's
  // exact schema isn't contractually documented (see this module's top comment)
  // — reading only the camelCase names previously meant every real hook
  // invocation fell through to "no candidate" and silently allowed every edit.
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
};

export type HookGuardRequestCandidate = {
  filePath: string;
  afterContent: string | null;
} | null;

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Kiro's real PreToolUse `tool_input.path` is the absolute path of the file
 * being edited (confirmed via a live capture during manual verification), not
 * a path relative to any repo root. Every downstream consumer of `filePath`
 * (reading the current file, matching a rationale contract's `scope.files`,
 * looking up a demo evidence fixture) expects a repo-root-relative path like
 * `"src/payments/create-order.ts"` — passing the absolute path through
 * unchanged silently breaks all of them: `join(repoRoot, absolutePath)`
 * produces a path that never exists on Windows, so the file read (and every
 * evidence/contract lookup keyed on the relative path) fails and WhyGuard
 * falls back to "no analysis possible" instead of blocking.
 *
 * Returns the path unchanged if it isn't absolute, or doesn't fall under
 * `repoRoot` at all (e.g. an edit outside the guarded repo — not this hook's
 * concern; `guardChange` will simply find no history for it).
 */
export function toRepoRelativePath(repoRoot: string, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  const relativePath = relative(repoRoot, filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return filePath;
  return relativePath.split(sep).join("/");
}

/**
 * Extracts a candidate `{ filePath, afterContent }` pair from a Kiro PreToolUse
 * event for the write-shaped tools this hook is meant to guard (`fs_write`,
 * `str_replace`, and similarly-shaped custom tools). Returns null when the event
 * does not look like a file write at all, so the caller can allow the call
 * immediately without invoking any WhyGuard logic.
 *
 * `readCurrentContent` is used for `str_replace`-shaped events (see below) to
 * compute the full resulting file body — pass the repo-root-relative file
 * reader you already use elsewhere (e.g. `readCurrentFileContent` in
 * `index.ts`) rather than duplicating that logic here.
 */
/**
 * Serializes a WhyGuard block into the Kiro `PreToolUse` permission-decision
 * payload that Kiro reads from a hook's STDOUT on a successful (exit 0) run.
 *
 * Returning `"ask"` makes the Kiro IDE prompt the human to confirm before the
 * guarded write proceeds. This exists because a plain exit-2 "block" from a
 * PreToolUse hook is only advisory to the agent: verified on 2026-07-26 in the
 * Kiro IDE with MiniMax M2.5 and DeepSeek v3.2, the hook fired and returned 2
 * and both models applied the protected-behavior-removing edit regardless. The
 * confirmation prompt is enforced by the IDE, so it does not depend on the
 * agent choosing to cooperate.
 */
export function formatKiroAskDecision(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  });
}

export function extractGuardCandidate(
  event: KiroPreToolUseEvent,
  readCurrentContent?: (filePath: string) => string | null,
): HookGuardRequestCandidate {
  const input = event.tool?.input ?? event.toolInput ?? event.tool_input ?? {};
  const path = readString(input.path) ?? readString(input.targetFile) ?? readString(input.file);
  if (!path) return null;

  // fs_write-style: a full new file body under "text" or "content".
  const fullText = readString(input.text) ?? readString(input.content);
  if (fullText !== undefined) {
    return { filePath: path, afterContent: fullText };
  }

  // str_replace-style: only a replacement fragment is available (oldStr/newStr,
  // or their oldString/newString aliases), not the whole resulting file. Kiro's
  // real str_replace tool_input only ever replaces a single occurrence unless
  // `replaceAll`/`replace_all` is set — mirror that here so a non-unique match
  // is never guessed at.
  const oldStr = readString(input.oldStr) ?? readString(input.oldString);
  const newStr = readString(input.newStr) ?? readString(input.newString) ?? "";
  const replaceAll = input.replaceAll === true || input.replace_all === true;

  if (oldStr !== undefined && readCurrentContent) {
    const currentContent = readCurrentContent(path);
    if (currentContent !== null) {
      const occurrences = currentContent.split(oldStr).length - 1;
      if (occurrences === 1 || (occurrences > 1 && replaceAll)) {
        const afterContent = replaceAll
          ? currentContent.split(oldStr).join(newStr)
          : currentContent.replace(oldStr, newStr);
        return { filePath: path, afterContent };
      }
      // occurrences === 0 (oldStr no longer matches the current file — stale
      // hook input) or an ambiguous multi-match without replaceAll: too
      // uncertain to compute a trustworthy afterContent, fall through to null.
    }
  }

  // No way to compute the resulting file body (no reader was supplied, the
  // file could not be read, or oldStr/newStr were absent entirely).
  // `detectSensitiveChanges` treats a null before/after as "skip analysis" (see
  // packages/ast-adapter/src/detector.ts), which fails open to "no findings"
  // for this call rather than risking an incorrect block.
  return { filePath: path, afterContent: null };
}

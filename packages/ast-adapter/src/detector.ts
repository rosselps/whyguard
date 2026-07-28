import { Project, SyntaxKind, type Node, type SourceFile } from "ts-morph";
import type { SensitiveChange, SensitiveChangeKind } from "@whyguard/contracts";

/**
 * TypeScript/JavaScript sensitive-change detector.
 *
 * Implements 5 of the 6 MVP patterns:
 *   1. condition_removed  — removed `if` guard / early return
 *   2. boundary_changed   — comparison operator moved (`<` -> `<=`)
 *   3. timeout_changed    — a named duration value moved
 *   4. validation_removed — a validation call disappeared
 *   5. retry_removed      — retry count lowered, or a retry wrapper deleted
 *
 * Not implemented: removed browser/provider/timezone special cases, and removed or
 * weakened regression tests.
 *
 * This intentionally does not classify every diff — false-positive control requires a strict allowlist rather than broad heuristics.
 *
 * Approach: parse the "before" and "after" contents of a single file in-memory, match
 * function-like declarations by name, and diff their guard clauses, validation calls,
 * comparison operators, and named numeric settings.
 */

let idCounter = 0;
function nextChangeId(): string {
  idCounter += 1;
  return `sc_${idCounter.toString().padStart(3, "0")}`;
}

export function resetChangeIdCounterForTests(): void {
  idCounter = 0;
}

/**
 * Derives a stable name for a function-like node so "the same function" can be matched
 * across the before/after versions of a file.
 *
 * Arrow functions and function expressions have no name of their own — their identity
 * comes from what they are assigned to (`const calculateRetryDelay = (...) => {...}`,
 * `{ onRetry: function () {...} }`, `export default () => {...}`). Skipping them was a
 * real false negative found while testing against `sindresorhus/got`: removing a guard
 * clause from an arrow-function module produced *zero* findings, because the enclosing
 * function was never collected in the first place. Arrow functions are the dominant
 * style in modern TS/JS, so this was silently skipping most real code.
 *
 * Returns null for a genuinely anonymous function (an inline callback such as
 * `items.filter(x => x.active)`). Those are deliberately not tracked: with no stable
 * name there is nothing to match against in the "after" version, and guessing by
 * position would invent findings whenever a callback moved.
 */
function deriveFunctionName(node: Node): string | null {
  const ownName = (node as unknown as { getName?: () => string | undefined }).getName?.();
  if (ownName) return ownName;

  const parent = node.getParent();
  if (!parent) return null;

  if (parent.getKind() === SyntaxKind.VariableDeclaration) {
    return parent.asKindOrThrow(SyntaxKind.VariableDeclaration).getName();
  }

  if (parent.getKind() === SyntaxKind.PropertyAssignment) {
    return parent.asKindOrThrow(SyntaxKind.PropertyAssignment).getName();
  }

  if (parent.getKind() === SyntaxKind.PropertyDeclaration) {
    return parent.asKindOrThrow(SyntaxKind.PropertyDeclaration).getName();
  }

  if (parent.getKind() === SyntaxKind.ExportAssignment) {
    // `export default () => {...}` — one per module, so the module itself is the identity.
    return "default";
  }

  return null;
}

const FUNCTION_LIKE_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);

function getFunctionLikeDeclarations(sourceFileText: string, fileName: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(fileName, sourceFileText);
  const declarations: { name: string; node: Node }[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!FUNCTION_LIKE_KINDS.has(node.getKind())) return;

    if (node.getKind() === SyntaxKind.Constructor) {
      declarations.push({ name: "constructor", node });
      return;
    }

    const name = deriveFunctionName(node);
    if (name) declarations.push({ name, node });
  });

  return { project, sourceFile, declarations };
}

type GuardClause = {
  conditionText: string;
  /** Identifier-renaming-invariant shape of the condition; see `normalizeIdentifiers`. */
  conditionSignature: string;
  hasEarlyExit: boolean;
  lineStart: number;
  lineEnd: number;
};

/**
 * Builds a renaming-invariant "shape" signature for an expression: every local
 * identifier (variables, parameters — not property names in a member access) is
 * replaced by a placeholder assigned in first-occurrence order, so `existing` and
 * `priorOrder` both become `#id0`, while every other token (keywords, operators,
 * literals, punctuation, and property names like `.amount`) is kept verbatim.
 *
 * Regression fix for a real false positive found during manual end-to-end
 * verification: a guard clause that is cosmetically renamed (e.g. `if (existing)
 * return existing;` -> `if (priorOrder) return priorOrder;`, identical behavior)
 * was being reported as `condition_removed` because `compareGuardClauses`
 * previously matched guards by raw condition text only. Two occurrences of the
 * *same* identifier still map to the same placeholder, so a genuine logic change
 * such as `if (a === a)` -> `if (a === b)` still produces a different signature
 * and is not silently ignored.
 *
 * Trade-off, documented rather than hidden: two *unrelated* guards that
 * happen to share the same shape (e.g. `if (order) return order;` and
 * `if (payment) return payment;`) are indistinguishable by signature alone. This
 * mirrors the already-accepted trade-off for `compareBoundaries`' positional
 * fallback — acceptable for the MVP's single-guard-per-early-exit scope.
 */
function normalizeIdentifiers(node: Node): string {
  let nextPlaceholderIndex = 0;
  const placeholderByIdentifier = new Map<string, string>();
  const parts: string[] = [];

  function visit(current: Node): void {
    if (current.getKind() === SyntaxKind.ParenthesizedExpression) {
      // Redundant grouping parens (`(existing)` vs `existing`) do not change
      // behavior — treat them as transparent so they don't produce a spurious
      // signature mismatch. Regression test: "reformat condition with extra
      // parens" in detector.test.ts.
      const inner = current.asKindOrThrow(SyntaxKind.ParenthesizedExpression).getExpression();
      visit(inner);
      return;
    }

    if (current.getKind() === SyntaxKind.Identifier) {
      const parent = current.getParent();
      const isPropertyName =
        parent !== undefined &&
        parent.getKind() === SyntaxKind.PropertyAccessExpression &&
        parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getNameNode() === current;

      if (isPropertyName) {
        // Property names are a real behavioral signal (`.amount` vs `.total` is
        // not a rename of the same thing) — keep them verbatim, do not normalize.
        parts.push(`.${current.getText()}`);
        return;
      }

      const text = current.getText();
      let placeholder = placeholderByIdentifier.get(text);
      if (placeholder === undefined) {
        placeholder = `#id${nextPlaceholderIndex}`;
        nextPlaceholderIndex += 1;
        placeholderByIdentifier.set(text, placeholder);
      }
      parts.push(placeholder);
      return;
    }

    const children = current.getChildren();
    if (children.length === 0) {
      parts.push(current.getText());
      return;
    }
    for (const child of children) visit(child);
  }

  visit(node);
  return parts.join(" ");
}

/**
 * True when `node` belongs to `fnNode` directly rather than to a nested function
 * inside it.
 *
 * Now that arrow functions and function expressions are collected as their own
 * declarations, a node inside a nested callback would otherwise be attributed to
 * *both* the outer function and the inner one, reporting the same removal twice. Each
 * node is attributed only to its nearest enclosing function-like ancestor.
 */
function belongsDirectlyTo(node: Node, fnNode: Node): boolean {
  let current = node.getParent();
  while (current) {
    if (current === fnNode) return true;
    if (FUNCTION_LIKE_KINDS.has(current.getKind())) return false;
    current = current.getParent();
  }
  return false;
}

function extractGuardClauses(fnNode: Node): GuardClause[] {
  const guards: GuardClause[] = [];
  fnNode.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.IfStatement) return;
    if (!belongsDirectlyTo(node, fnNode)) return;
    const ifStatement = node.asKindOrThrow(SyntaxKind.IfStatement);
    const thenStatement = ifStatement.getThenStatement();
    const text = thenStatement.getText();
    const hasEarlyExit =
      text.includes("return") || text.includes("throw") || text.includes("continue");
    const conditionNode = ifStatement.getExpression();
    guards.push({
      conditionText: conditionNode.getText().trim(),
      conditionSignature: normalizeIdentifiers(conditionNode),
      hasEarlyExit,
      lineStart: ifStatement.getStartLineNumber(),
      lineEnd: ifStatement.getEndLineNumber(),
    });
  });
  return guards;
}

type ValidationCall = {
  /** Full call text, used for human-readable Finding output. */
  fullText: string;
  /**
   * The callee's own text only (e.g. `validateAmount`, or `validator.check` for
   * a member-access call) — used to match "the same validation call" across
   * before/after so that adding/reformatting arguments (e.g. `validateAmount(amount)`
   * -> `validateAmount(amount, { strict: true })`, a strengthening, not a removal)
   * does not read as `validation_removed`. Regression test: "reformat validation
   * call arguments" in detector.test.ts.
   *
   * Renaming the callee itself (e.g. `validateAmount` -> `checkAmount`) is
   * intentionally still treated as removal-plus-no-match: unlike a local
   * variable rename in a guard clause, WhyGuard cannot safely assume a renamed
   * function reference is the *same* validation without risking a false
   * negative if a real validation was quietly swapped for a differently-named,
   * weaker one. This is a deliberate, documented trade-off, not an oversight.
   */
  calleeText: string;
};

function extractValidationCalls(fnNode: Node): ValidationCall[] {
  const calls: ValidationCall[] = [];
  fnNode.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    if (!belongsDirectlyTo(node, fnNode)) return;
    const callExpr = node.asKindOrThrow(SyntaxKind.CallExpression);
    const exprText = callExpr.getExpression().getText();
    if (/valid|assert|check|ensure/i.test(exprText)) {
      calls.push({ fullText: callExpr.getText().trim(), calleeText: exprText.trim() });
    }
  });
  return calls;
}

type BinaryComparison = {
  left: string;
  operator: string;
  right: string;
};

const COMPARISON_OPERATORS = new Set(["<", "<=", ">", ">=", "==", "===", "!=", "!=="]);

function extractComparisons(fnNode: Node): BinaryComparison[] {
  const comparisons: BinaryComparison[] = [];
  fnNode.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.BinaryExpression) return;
    if (!belongsDirectlyTo(node, fnNode)) return;
    const binExpr = node.asKindOrThrow(SyntaxKind.BinaryExpression);
    const operator = binExpr.getOperatorToken().getText();
    if (!COMPARISON_OPERATORS.has(operator)) return;
    comparisons.push({
      left: binExpr.getLeft().getText().trim(),
      operator,
      right: binExpr.getRight().getText().trim(),
    });
  });
  return comparisons;
}

/**
 * Names whose numeric value represents a *duration*. A change here is
 * `timeout_changed`.
 *
 * Checked before `RETRY_NAME_PATTERN` because a name can match both — `retryDelayMs`
 * is a duration, not a retry count — and misclassifying it would apply the
 * retry-count direction rule below to a value where it makes no sense.
 */
const DURATION_NAME_PATTERN = /timeout|delay|interval|wait|backoff|ttl|deadline|expir/i;

/** Names whose numeric value represents how many times an operation is re-attempted. */
const RETRY_NAME_PATTERN = /retry|retries|attempt|attempts/i;

/**
 * A named numeric setting found inside a function: a timeout constant, a retry count,
 * a `setTimeout` delay argument, a `{ timeout: 5000 }` option. Matched across
 * before/after by `name`, so only settings that are *still there* under the same name
 * but with a different value are reported — a wholesale rewrite of the surrounding
 * code is a larger, unclassified edit and deliberately out of this detector's
 * allowlist.
 */
type NamedNumericSetting = {
  name: string;
  value: number;
  lineStart: number;
  lineEnd: number;
};

function numericLiteralValue(node: Node): number | undefined {
  if (node.getKind() === SyntaxKind.NumericLiteral) {
    const parsed = Number(node.getText());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  // A negated literal (`-1`, a common "no timeout"/"infinite retries" sentinel) is a
  // PrefixUnaryExpression, not a NumericLiteral.
  if (node.getKind() === SyntaxKind.PrefixUnaryExpression) {
    const unary = node.asKindOrThrow(SyntaxKind.PrefixUnaryExpression);
    if (unary.getOperatorToken() === SyntaxKind.MinusToken) {
      const operand = numericLiteralValue(unary.getOperand());
      return operand === undefined ? undefined : -operand;
    }
  }
  return undefined;
}

/**
 * Collects named numeric settings from the three shapes that carry timeout/retry
 * configuration in practice:
 *
 *   const REQUEST_TIMEOUT_MS = 5000;     variable declaration
 *   fetch(url, { timeout: 5000 }) property assignment in an options object
 *   setTimeout(retry, 5000) numeric argument to a duration-named call
 *
 * Call arguments are keyed by callee *and position* (`setTimeout#1`) so a call with
 * several numeric arguments does not collapse into one ambiguous entry.
 */
function extractNamedNumericSettings(fnNode: Node): NamedNumericSetting[] {
  const settings: NamedNumericSetting[] = [];

  const push = (name: string, valueNode: Node, node: Node): void => {
    const value = numericLiteralValue(valueNode);
    if (value === undefined) return;
    settings.push({
      name,
      value,
      lineStart: node.getStartLineNumber(),
      lineEnd: node.getEndLineNumber(),
    });
  };

  fnNode.forEachDescendant((node) => {
    if (!belongsDirectlyTo(node, fnNode)) return;

    if (node.getKind() === SyntaxKind.VariableDeclaration) {
      const declaration = node.asKindOrThrow(SyntaxKind.VariableDeclaration);
      const initializer = declaration.getInitializer();
      if (initializer) push(declaration.getName(), initializer, node);
      return;
    }

    if (node.getKind() === SyntaxKind.PropertyAssignment) {
      const assignment = node.asKindOrThrow(SyntaxKind.PropertyAssignment);
      const initializer = assignment.getInitializer();
      if (initializer) push(assignment.getName(), initializer, node);
      return;
    }

    if (node.getKind() === SyntaxKind.CallExpression) {
      const callExpr = node.asKindOrThrow(SyntaxKind.CallExpression);
      const calleeText = callExpr.getExpression().getText().trim();
      callExpr.getArguments().forEach((argument, index) => {
        push(`${calleeText}#${index}`, argument, node);
      });
    }
  });

  return settings;
}

/**
 * Call expressions that *are* the retry mechanism (`withRetry(...)`,
 * `retryable(...)`, `client.retry(...)`), as opposed to a numeric retry count.
 * Removing one of these removes the mechanism itself.
 */
function extractRetryCallees(fnNode: Node): string[] {
  const callees: string[] = [];
  fnNode.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    if (!belongsDirectlyTo(node, fnNode)) return;
    const calleeText = node
      .asKindOrThrow(SyntaxKind.CallExpression)
      .getExpression()
      .getText()
      .trim();
    if (RETRY_NAME_PATTERN.test(calleeText)) callees.push(calleeText);
  });
  return callees;
}

export type DetectSensitiveChangesInput = {
  filePath: string;
  beforeContent: string | null;
  afterContent: string | null;
};

/**
 * Compares the before/after content of a single file and returns SensitiveChange
 * records for guard-clause removal, validation-call removal, and boundary/operator
 * changes on structurally matching comparisons.
 */
export function detectSensitiveChanges(input: DetectSensitiveChangesInput): SensitiveChange[] {
  const { filePath, beforeContent, afterContent } = input;
  if (beforeContent === null || afterContent === null) return [];

  const fileName = filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? "file.tsx" : "file.ts";
  const before = getFunctionLikeDeclarations(beforeContent, fileName);
  const after = getFunctionLikeDeclarations(afterContent, fileName);

  const changes: SensitiveChange[] = [];

  for (const beforeFn of before.declarations) {
    const afterFn = after.declarations.find((candidate) => candidate.name === beforeFn.name);
    if (!afterFn) continue; // whole-function removal is out of MVP scope for this detector

    changes.push(...compareGuardClauses(filePath, beforeFn.name, beforeFn.node, afterFn.node));
    changes.push(...compareValidationCalls(filePath, beforeFn.name, beforeFn.node, afterFn.node));
    changes.push(...compareBoundaries(filePath, beforeFn.name, beforeFn.node, afterFn.node));
    changes.push(...compareNumericSettings(filePath, beforeFn.name, beforeFn.node, afterFn.node));
    changes.push(...compareRetryMechanisms(filePath, beforeFn.name, beforeFn.node, afterFn.node));
  }

  changes.push(
    ...diffNumericSettings(
      filePath,
      (setting) => setting.name,
      extractModuleScopeNumericSettings(before.sourceFile),
      extractModuleScopeNumericSettings(after.sourceFile),
    ),
  );

  return changes;
}

function makeChange(
  filePath: string,
  symbol: string,
  kind: SensitiveChangeKind,
  before: string,
  after: string,
  lines: { start: number; end: number },
): SensitiveChange {
  return {
    id: nextChangeId(),
    filePath,
    symbol,
    kind,
    before,
    after,
    lines,
  };
}

function compareGuardClauses(
  filePath: string,
  symbol: string,
  beforeNode: Node,
  afterNode: Node,
): SensitiveChange[] {
  const beforeGuards = extractGuardClauses(beforeNode).filter((g) => g.hasEarlyExit);
  const afterGuards = extractGuardClauses(afterNode).filter((g) => g.hasEarlyExit);
  // Match by renaming-invariant signature, not raw text — see `normalizeIdentifiers`.
  const afterSignatures = new Set(afterGuards.map((g) => g.conditionSignature));

  const removed = beforeGuards.filter((g) => !afterSignatures.has(g.conditionSignature));
  return removed.map((guard) =>
    makeChange(
      filePath,
      symbol,
      "condition_removed",
      `if (${guard.conditionText}) { /* early exit */ }`,
      "(removed)",
      { start: guard.lineStart, end: guard.lineEnd },
    ),
  );
}

function compareValidationCalls(
  filePath: string,
  symbol: string,
  beforeNode: Node,
  afterNode: Node,
): SensitiveChange[] {
  const beforeCalls = extractValidationCalls(beforeNode);
  const afterCallees = new Set(extractValidationCalls(afterNode).map((call) => call.calleeText));
  const removed = beforeCalls.filter((call) => !afterCallees.has(call.calleeText));
  return removed.map((call) =>
    makeChange(filePath, symbol, "validation_removed", call.fullText, "(removed)", {
      start: beforeNode.getStartLineNumber(),
      end: beforeNode.getEndLineNumber(),
    }),
  );
}

/**
 * Detects `timeout_changed` and the numeric half of `retry_removed`, by matching named numeric settings across
 * before/after and reporting those whose value moved.
 *
 * Direction matters, and only for retries: lowering a retry count weakens the
 * mechanism a past incident may depend on, while *raising* it strengthens the same
 * behavior and is not reported. Durations have no such safe direction — shortening a
 * timeout can break a slow-but-legitimate operation, and lengthening one can restore
 * a hang the original value was chosen to avoid — so any duration change is reported
 * and left for the evidence engine to score.
 */
function compareNumericSettings(
  filePath: string,
  symbol: string,
  beforeNode: Node,
  afterNode: Node,
): SensitiveChange[] {
  return diffNumericSettings(
    filePath,
    () => symbol,
    extractNamedNumericSettings(beforeNode),
    extractNamedNumericSettings(afterNode),
  );
}

/**
 * Shared body of the numeric comparison, so a setting declared at module scope is
 * judged by exactly the same rules as one declared inside a function.
 *
 * `symbolFor` exists because the two callers disagree on what the finding is *about*:
 * inside a function the symbol is the enclosing function, while a module-level constant
 * is its own symbol — there is no function to attribute it to, and reporting the file
 * would make the finding impossible to match against a contract's `symbols`.
 */
function diffNumericSettings(
  filePath: string,
  symbolFor: (setting: NamedNumericSetting) => string,
  beforeSettings: NamedNumericSetting[],
  afterSettings: NamedNumericSetting[],
): SensitiveChange[] {
  const afterByName = new Map(afterSettings.map((setting) => [setting.name, setting]));

  const changes: SensitiveChange[] = [];

  for (const before of beforeSettings) {
    const isDuration = DURATION_NAME_PATTERN.test(before.name);
    const isRetryCount = !isDuration && RETRY_NAME_PATTERN.test(before.name);
    if (!isDuration && !isRetryCount) continue;

    const after = afterByName.get(before.name);
    if (!after || after.value === before.value) continue;

    // Raising a retry count preserves (or strengthens) the retry behavior.
    if (isRetryCount && after.value > before.value) continue;

    changes.push(
      makeChange(
        filePath,
        symbolFor(before),
        isDuration ? "timeout_changed" : "retry_removed",
        `${before.name} = ${before.value}`,
        `${after.name} = ${after.value}`,
        { start: before.lineStart, end: before.lineEnd },
      ),
    );
  }

  return changes;
}

/**
 * Collects numeric settings declared at module scope, which is where a timeout or a
 * backoff usually lives: a single exported constant read by every call site.
 *
 * Without this, lowering `export const RETRY_BACKOFF_MS = 2000` to `250` produced no
 * finding at all, because the per-function walk only sees declarations inside a
 * function body. Found while testing a real pull request against a repository whose
 * rationale contract explicitly protected that interval.
 */
function extractModuleScopeNumericSettings(sourceFile: SourceFile): NamedNumericSetting[] {
  const settings: NamedNumericSetting[] = [];

  for (const statement of sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer) continue;
      const value = numericLiteralValue(initializer);
      if (value === undefined) continue;
      settings.push({
        name: declaration.getName(),
        value,
        lineStart: declaration.getStartLineNumber(),
        lineEnd: declaration.getEndLineNumber(),
      });
    }
  }

  return settings;
}

/**
 * Detects removal of a retry *mechanism* — a `withRetry(...)`/`retryable(...)`-style
 * call that existed before and is gone after. This complements the numeric half in
 * `compareNumericSettings`: a retry can be weakened either by lowering its count or
 * by deleting the wrapper entirely.
 *
 * Matched on the callee text, with the same deliberate trade-off documented for
 * validation calls: renaming the wrapper reads as removal, because WhyGuard cannot
 * confirm a differently-named function still retries without risking a false negative.
 */
function compareRetryMechanisms(
  filePath: string,
  symbol: string,
  beforeNode: Node,
  afterNode: Node,
): SensitiveChange[] {
  const afterCallees = new Set(extractRetryCallees(afterNode));
  const removed = extractRetryCallees(beforeNode).filter((callee) => !afterCallees.has(callee));

  return removed.map((callee) =>
    makeChange(filePath, symbol, "retry_removed", `${callee}(...)`, "(removed)", {
      start: beforeNode.getStartLineNumber(),
      end: beforeNode.getEndLineNumber(),
    }),
  );
}

/**
 * Matches a "before" comparison to its corresponding "after" comparison.
 *
 * Matching by `left`/`right` text equality alone is unsound: a function can
 * contain multiple, unrelated comparisons that happen to share operand text
 * (e.g. `humidity > 80` in one `if` and `humidity <= 80` in a different `if`
 * a few lines later, as seen in a real-world false positive during manual
 * verification against an external repository — the function itself was
 * never edited, yet the two *different* comparisons were cross-matched as if
 * one had morphed into the other). When candidates are ambiguous, prefer the
 * "after" comparison at the same positional index as the "before" one — for
 * an edit that only changes an operator, the comparison's position among the
 * function's other comparisons is stable; only fall back to a same-text match
 * when there is exactly one candidate with matching operands, which is
 * unambiguous by construction.
 */
function findMatchingComparison(
  beforeCmp: BinaryComparison,
  beforeIndex: number,
  afterComparisons: BinaryComparison[],
): BinaryComparison | undefined {
  const sameOperands = afterComparisons.filter(
    (afterCmp) => afterCmp.left === beforeCmp.left && afterCmp.right === beforeCmp.right,
  );
  if (sameOperands.length === 1) return sameOperands[0];
  if (sameOperands.length > 1) {
    // Multiple candidates share the same operand text (e.g. two unrelated
    // comparisons in the same function happen to both compare against the
    // same literal): trust the positional match within the full "after"
    // array instead, since it is exact when the function's comparison count
    // hasn't changed — which is the common case this ambiguity arises in.
    return afterComparisons[beforeIndex];
  }
  // No candidate shares the same operand text at all (e.g. the left/right
  // identifiers themselves changed) — too different from the original
  // comparison to safely call this a boundary change rather than a larger,
  // unclassified edit.
  return undefined;
}

function compareBoundaries(
  filePath: string,
  symbol: string,
  beforeNode: Node,
  afterNode: Node,
): SensitiveChange[] {
  const beforeComparisons = extractComparisons(beforeNode);
  const afterComparisons = extractComparisons(afterNode);

  const changes: SensitiveChange[] = [];
  beforeComparisons.forEach((beforeCmp, index) => {
    const match = findMatchingComparison(beforeCmp, index, afterComparisons);
    if (match && match.operator !== beforeCmp.operator) {
      changes.push(
        makeChange(
          filePath,
          symbol,
          "boundary_changed",
          `${beforeCmp.left} ${beforeCmp.operator} ${beforeCmp.right}`,
          `${match.left} ${match.operator} ${match.right}`,
          { start: beforeNode.getStartLineNumber(), end: beforeNode.getEndLineNumber() },
        ),
      );
    }
  });
  return changes;
}

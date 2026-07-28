import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildPaymentFixture } from "@whyguard/test-fixtures";
import { scanDiff, resetScanDiffCountersForTests } from "./scan-diff.js";
import { resetFindingCounterForTests } from "./finding-builder.js";

/**
 * Integration test for the Phase 1 vertical slice described in
 *: `whyguard scan` must detect the payment
 * idempotency guard removal, trace the introducing commit, link fixture evidence
 * for Issue #481 / PR #493, propose the protected property, compute deterministic
 * risk/confidence, and emit a schema-validated Finding — all without an LLM.
 */
describe("scanDiff (vertical slice integration test)", () => {
  const fixtureDir = join(process.cwd(), ".tmp", "whyguard-fixture-test");

  beforeEach(() => {
    resetScanDiffCountersForTests();
    resetFindingCounterForTests();
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("detects the idempotency guard removal with evidence, risk, and confidence", () => {
    const { repoRoot, safeSha, unsafeSha } = buildPaymentFixture(fixtureDir);

    const report = scanDiff({ repoRoot, base: safeSha, head: unsafeSha, source: "cli" });

    expect(report.llmEnabled).toBe(false);
    expect(report.findings).toHaveLength(1);

    const [finding] = report.findings;
    expect(finding?.change.kind).toBe("condition_removed");
    expect(finding?.change.symbol).toBe("createOrder");
    expect(finding?.reasonStatus).toBe("known");
    expect(finding?.severity).toBe("critical");
    expect(finding?.riskScore).toBeGreaterThanOrEqual(80);
    expect(finding?.confidenceScore).toBeGreaterThanOrEqual(75);

    // Requirement 3: Issue #481 and PR #493 must be linked — and they must come from
    // the repository, not from a lookup table. These ids are derived from the fixture's
    // own committed `.whyguard/decisions/payment-idempotency.yml`. The previous
    // assertion checked for `ev_issue_481`/`ev_pr_493`, which were hardcoded in
    // `@whyguard/test-fixtures` and injected for any path ending in
    // `src/payments/create-order.ts` — so this test passed even when the repository
    // contained no such history at all.
    expect(finding?.evidenceIds).toContain("ev_decision_payment-idempotency_issue_481");
    expect(finding?.evidenceIds).toContain("ev_decision_payment-idempotency_pull_request_493");

    // Requirement 2: the introducing commit must be traced.
    const commitEvidence = finding?.evidence.find((item) => item.type === "commit");
    expect(commitEvidence).toBeDefined();
    expect(commitEvidence?.sha).toBe(safeSha);

    // Requirement 4: a protected property must be proposed.
    expect(finding?.protectedProperties.length).toBeGreaterThan(0);
    expect(finding?.protectedProperties[0]?.statement).toContain("idempotency key");
  });

  it("prefers the confirmed rationale contract over a proposed property", () => {
    const { repoRoot, safeSha, unsafeSha } = buildPaymentFixture(join(fixtureDir, "with-decision"));

    const report = scanDiff({ repoRoot, base: safeSha, head: unsafeSha, source: "cli" });
    const [finding] = report.findings;

    // The demo fixture now ships an active `.whyguard/decisions/payment-idempotency.yml`.
    // Its confirmed properties must be used, not a heuristically "proposed" one.
    expect(finding?.protectedProperties.length).toBeGreaterThan(0);
    expect(finding?.protectedProperties.every((property) => property.status === "confirmed")).toBe(
      true,
    );

    // Contract-derived evidence is treated as strong. It is also the only source of
    // `strong` evidence in the deterministic pipeline, which is what makes a confirmed
    // contract the only thing that can push a finding past the block rule.
    const decisionEvidence = finding?.evidence.filter((item) => item.id.startsWith("ev_decision_"));
    expect(decisionEvidence?.length).toBeGreaterThan(0);
    expect(decisionEvidence?.every((item) => item.strength === "strong")).toBe(true);

    expect(finding?.explanation).toContain("payment-idempotency");
  });

  /**
   * Found by running `whyguard scan` against a real repository (axios, 2148 commits),
   * where Git reported renamed files and every one of them produced `fatal: path...
   * exists on disk, but not in <base>` on the terminal plus zero analysis. Reading the
   * previous version with the *head* path can never work for a rename, so a change that
   * removed protected behavior while moving a file was invisible — a plausible shape for
   * exactly the refactor this tool exists to catch.
   */
  it("detects a removal in a file that was renamed in the same range", () => {
    const repoRoot = join(fixtureDir, "renamed-file");
    mkdirSync(repoRoot, { recursive: true });
    const git = (args: string[]): string =>
      execFileSync("git", ["-c", "core.hooksPath=", ...args], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "demo@whyguard.local"]);
    git(["config", "user.name", "WhyGuard Demo"]);

    const guarded =
      "export function withdraw(balance: number, amount: number) {\n" +
      "  if (amount > balance) {\n    throw new Error('insufficient funds');\n  }\n" +
      "  return balance - amount;\n}\n";
    writeFileSync(join(repoRoot, "account.ts"), guarded, "utf-8");
    git(["add", "."]);
    git(["commit", "-m", "Reject overdrawn withdrawals (fixes #7)"]);
    const baseSha = git(["rev-parse", "HEAD"]);

    // Move the file and drop the guard in one commit, which is what Git reports as R.
    rmSync(join(repoRoot, "account.ts"));
    writeFileSync(
      join(repoRoot, "wallet.ts"),
      "export function withdraw(balance: number, amount: number) {\n  return balance - amount;\n}\n",
      "utf-8",
    );
    git(["add", "-A"]);
    git(["commit", "-m", "Move account helpers into wallet"]);
    const headSha = git(["rev-parse", "HEAD"]);

    const report = scanDiff({ repoRoot, base: baseSha, head: headSha, source: "cli" });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.change.kind).toBe("condition_removed");
    expect(report.findings[0]?.change.symbol).toBe("withdraw");
    expect(report.findings[0]?.change.filePath).toBe("wallet.ts");
  });

  /**
   * Found on a real pull request against a deployed API. A pull request scan clones the
   * base branch and never checks the head out, so the "does the required test still
   * exist?" question was answered from the base working tree. A change that deleted the
   * protecting test therefore kept its regression-test evidence and scored *lower* than
   * the same change with the test left alone — backwards, and worth a test of its own.
   */
  it("drops regression-test evidence when the change deletes the required test", () => {
    const repoRoot = join(fixtureDir, "deleted-required-test");
    mkdirSync(repoRoot, { recursive: true });
    const git = (args: string[]): string =>
      execFileSync("git", ["-c", "core.hooksPath=", ...args], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "demo@whyguard.local"]);
    git(["config", "user.name", "WhyGuard Demo"]);

    const guarded =
      "export function createOrder(key: string, store: Map<string, string>) {\n" +
      "  const existing = store.get(key);\n  if (existing) {\n    return existing;\n  }\n" +
      "  return capture(key);\n}\n";
    writeFileSync(join(repoRoot, "orders.ts"), guarded, "utf-8");
    writeFileSync(join(repoRoot, "orders.test.ts"), "// regression test for #1\n", "utf-8");
    mkdirSync(join(repoRoot, ".whyguard", "decisions"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".whyguard", "decisions", "order-idempotency.yml"),
      [
        "id: order-idempotency",
        "version: 1",
        "status: active",
        "scope:",
        "  files:",
        "    - orders.ts",
        "  symbols:",
        "    - createOrder",
        "reason: A retried checkout charged the customer twice.",
        "must_preserve:",
        "  - One idempotency key creates at most one order.",
        "evidence:",
        "  - type: issue",
        '    id: "1"',
        "required_tests:",
        "  - orders.test.ts",
        "owners:",
        "  - checkout",
        "",
      ].join("\n"),
      "utf-8",
    );
    git(["add", "."]);
    git(["commit", "-m", "Return the existing order for a repeated key (fixes #1)"]);
    const baseSha = git(["rev-parse", "HEAD"]);

    const unguarded =
      "export function createOrder(key: string, store: Map<string, string>) {\n" +
      "  return capture(key);\n}\n";

    // Branch A: the guard goes, the test stays.
    writeFileSync(join(repoRoot, "orders.ts"), unguarded, "utf-8");
    git(["add", "-A"]);
    git(["commit", "-m", "Drop the redundant lookup"]);
    const testKeptSha = git(["rev-parse", "HEAD"]);

    // Branch B: same removal, and the now-failing test is deleted too.
    rmSync(join(repoRoot, "orders.test.ts"));
    git(["add", "-A"]);
    git(["commit", "-m", "Remove the failing test"]);
    const testDeletedSha = git(["rev-parse", "HEAD"]);

    const withTest = scanDiff({ repoRoot, base: baseSha, head: testKeptSha, source: "cli" });
    const withoutTest = scanDiff({ repoRoot, base: baseSha, head: testDeletedSha, source: "cli" });

    const testEvidenceOf = (report: typeof withTest): number =>
      report.findings[0]?.evidence.filter((item) => item.type === "test").length ?? 0;

    expect(testEvidenceOf(withTest)).toBe(1);
    expect(testEvidenceOf(withoutTest)).toBe(0);
    expect(withoutTest.findings[0]?.riskScore).toBeGreaterThan(
      withTest.findings[0]?.riskScore ?? 0,
    );
  });

  it("returns no findings for an unrelated, safe change", () => {
    const { repoRoot, safeSha } = buildPaymentFixture(join(fixtureDir, "safe-only"));

    // base == head: no diff, so no findings should be produced.
    const report = scanDiff({ repoRoot, base: safeSha, head: safeSha, source: "cli" });

    expect(report.findings).toHaveLength(0);
  });

  it("marks a sensitive change as unknown when no evidence or decision matches", () => {
    // A different guard clause, in a file/symbol the demo fixture and decisions
    // know nothing about, with a commit message that carries no issue/PR reference.
    const repoRoot = join(fixtureDir, "unknown-case");
    mkdirSync(repoRoot, { recursive: true });
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }).trim();

    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "demo@whyguard.local"]);
    git(["config", "user.name", "WhyGuard Demo"]);

    const filePath = join(repoRoot, "helper.ts");
    writeFileSync(
      filePath,
      "export function helper(x: number) {\n  if (x < 0) {\n    return 0;\n  }\n  return x;\n}\n",
      "utf-8",
    );
    git(["add", "."]);
    git(["commit", "-m", "Add helper"]);
    const baseSha = git(["rev-parse", "HEAD"]);

    writeFileSync(filePath, "export function helper(x: number) {\n  return x;\n}\n", "utf-8");
    git(["add", "."]);
    git(["commit", "-m", "Simplify helper"]);
    const headSha = git(["rev-parse", "HEAD"]);

    const report = scanDiff({ repoRoot, base: baseSha, head: headSha, source: "cli" });
    expect(report.findings).toHaveLength(1);

    const [finding] = report.findings;
    expect(finding?.reasonStatus).toBe("unknown");
    expect(finding?.protectedProperties).toEqual([]);
    expect(finding?.confidenceScore).toBeLessThan(40);
    expect(finding?.explanation).toContain("No reliable historical reason was found");
    expect(finding?.recommendation).toContain("Confirm with the code owner");
  });
});

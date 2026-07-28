import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildPaymentFixture,
  SAFE_CREATE_ORDER,
  UNSAFE_CREATE_ORDER,
} from "@whyguard/test-fixtures";
import { guardChange, resetGuardChangeCountersForTests } from "./guard-change.js";

/**
 * Tests for the `whyguard guard` use case (Kiro PreToolUse guardrail).
 */
describe("guardChange", () => {
  const fixtureDir = join(process.cwd(), ".tmp", "whyguard-guard-test");

  beforeEach(() => {
    resetGuardChangeCountersForTests();
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("blocks removing the idempotency guard when a confirmed decision covers it", () => {
    const { repoRoot } = buildPaymentFixture(join(fixtureDir, "block"));

    const result = guardChange({
      repoRoot,
      filePath: "src/payments/create-order.ts",
      beforeContent: SAFE_CREATE_ORDER,
      afterContent: UNSAFE_CREATE_ORDER,
    });

    expect(result.decision).toBe("block");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.decision).toBe("block");
    expect(result.feedback).toContain("WHYGUARD BLOCKED THIS EDIT");
    expect(result.feedback).toContain("idempotency key");
    expect(result.feedback).toContain("Historical evidence:");
  });

  it("allows a change with no detected sensitive pattern", () => {
    const { repoRoot } = buildPaymentFixture(join(fixtureDir, "allow"));

    const result = guardChange({
      repoRoot,
      filePath: "src/payments/create-order.ts",
      beforeContent: SAFE_CREATE_ORDER,
      afterContent: SAFE_CREATE_ORDER,
    });

    expect(result.decision).toBe("allow");
    expect(result.findings).toHaveLength(0);
    expect(result.feedback).toContain("No sensitive historical-decision changes detected");
  });

  it("warns (does not block) when the reason is unknown and evidence is weak", () => {
    const repoRoot = join(fixtureDir, "warn");
    mkdirSync(repoRoot, { recursive: true });
    const git = (args: string[]): string =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }).trim();
    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "demo@whyguard.local"]);
    git(["config", "user.name", "WhyGuard Demo"]);
    writeFileSync(
      join(repoRoot, "helper.ts"),
      "export function helper(x: number) {\n  if (x < 0) {\n    return 0;\n  }\n  return x;\n}\n",
      "utf-8",
    );
    git(["add", "."]);
    git(["commit", "-m", "Add helper"]);

    const result = guardChange({
      repoRoot,
      filePath: "helper.ts",
      beforeContent:
        "export function helper(x: number) {\n  if (x < 0) {\n    return 0;\n  }\n  return x;\n}\n",
      afterContent: "export function helper(x: number) {\n  return x;\n}\n",
    });

    expect(result.decision).toBe("warn");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.finding.reasonStatus).toBe("unknown");
  });
});

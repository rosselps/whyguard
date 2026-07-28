import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, gitInit } from "./fixture-git.js";
import { SAFE_CREATE_ORDER, UNSAFE_CREATE_ORDER } from "./create-order-versions.js";

/**
 * The confirmed rationale contract for this fixture. Written into the fixture repo at `.whyguard/decisions/` so scanDiff
 * can demonstrate loading a human-confirmed decision instead of only a `proposed`
 * property derived from evidence.
 */
const PAYMENT_IDEMPOTENCY_DECISION = `id: payment-idempotency
version: 1
status: active
scope:
  files:
    - src/payments/create-order.ts
  symbols:
    - createOrder
reason: >
  Prevent duplicate orders when the server completes the operation but the
  client receives a timeout and retries the checkout request.
must_preserve:
  - One idempotency key creates at most one order.
  - Retrying a completed request returns the existing order.
evidence:
  - type: issue
    id: "481"
  - type: pull_request
    id: "493"
required_tests:
  - tests/payments/idempotency.test.ts
expires_when:
  - Every supported payment provider guarantees server-side idempotency.
owners:
  - payments-team
`;

/**
 * Builds a throwaway local Git repository that reproduces the payment-idempotency
 * demo scenario (, 33):
 *
 *   commit 1 ("safe"):   src/payments/create-order.ts contains the idempotency guard.
 *   commit 2 ("unsafe"): the guard is removed (the change WhyGuard must flag).
 *
 * Used by `pnpm whyguard:demo:seed` and by integration tests for `whyguard scan`.
 */

export type PaymentFixtureResult = {
  repoRoot: string;
  safeSha: string;
  unsafeSha: string;
};

export function buildPaymentFixture(targetDir?: string): PaymentFixtureResult {
  const repoRoot = resolve(targetDir ?? join(process.cwd(), ".tmp", "whyguard-fixture"));

  if (existsSync(repoRoot)) {
    rmSync(repoRoot, { recursive: true, force: true });
  }
  mkdirSync(repoRoot, { recursive: true });

  gitInit(repoRoot);

  const paymentsDir = join(repoRoot, "src", "payments");
  mkdirSync(paymentsDir, { recursive: true });
  const filePath = join(paymentsDir, "create-order.ts");

  const decisionsDir = join(repoRoot, ".whyguard", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(
    join(decisionsDir, "payment-idempotency.yml"),
    PAYMENT_IDEMPOTENCY_DECISION,
    "utf-8",
  );

  writeFileSync(filePath, SAFE_CREATE_ORDER, "utf-8");
  git(repoRoot, ["add", "."]);
  git(repoRoot, [
    "commit",
    "-m",
    "Enforce idempotency key on createOrder (fixes #481)\n\nCloses #481. See PR #493.",
  ]);
  const safeSha = git(repoRoot, ["rev-parse", "HEAD"]);

  writeFileSync(filePath, UNSAFE_CREATE_ORDER, "utf-8");
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "Simplify createOrder by removing redundant duplicate check"]);
  const unsafeSha = git(repoRoot, ["rev-parse", "HEAD"]);

  return { repoRoot, safeSha, unsafeSha };
}

/** Repo-relative path of the file the fixture's protected behavior lives in. */
export const PAYMENT_FIXTURE_FILE = join("src", "payments", "create-order.ts");

/**
 * Rewinds the fixture to its "safe" commit and re-applies the guard removal as an
 * *uncommitted* change, so the Git hook and `verify --scope working-tree` have something
 * real to act on. Scanning `safeSha..unsafeSha` still works: `reset --hard` moves the
 * branch pointer without deleting the commit object.
 *
 * Returns the absolute path of the modified file.
 */
export function stageGuardRemovalInWorkingTree(repoRoot: string, safeSha: string): string {
  git(repoRoot, ["reset", "--hard", safeSha]);
  const filePath = join(repoRoot, PAYMENT_FIXTURE_FILE);
  writeFileSync(filePath, UNSAFE_CREATE_ORDER, "utf-8");
  return filePath;
}

/**
 * True only when this file is being executed directly as a script (i.e. by
 * `pnpm whyguard:demo:seed`), so the demo-seeding side effect below never runs as a
 * side effect of merely importing this module.
 *
 * The filename check is load-bearing, not redundant. Comparing `process.argv[1]` to
 * `import.meta.url` alone is true whenever this module *is* the entry file — and once
 * the CLI is bundled into a single artifact for npm, every inlined module reports the
 * bundle's own path as `import.meta.url`. That made `whyguard` with no arguments build
 * a throwaway demo repository inside the user's project instead of printing usage.
 * Found by installing the packed tarball; no unit test would have caught it, since the
 * bug only exists after bundling.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (resolve(entry) !== resolve(fileURLToPath(import.meta.url))) return false;
  return /build-payment-fixture(\.[cm]?[jt]s)?$/.test(basename(entry));
}

if (isMainModule()) {
  const result = buildPaymentFixture();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    `\nRun:\n  pnpm whyguard scan --base ${result.safeSha} --head ${result.unsafeSha} --format json --repo ${result.repoRoot}\n`,
  );
}

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseRationaleContract, type RationaleContract } from "@whyguard/contracts";

/**
 * Loads and matches `.whyguard/decisions/*.yml` rationale contracts. These are human-confirmed decisions —
 * loading them here never marks anything as confirmed on its own; it only surfaces
 * what a human already approved and committed to the repository.
 */

const DECISIONS_DIR = join(".whyguard", "decisions");

export type LoadRationaleContractsResult = {
  contracts: RationaleContract[];
  /** Files that existed under.whyguard/decisions but failed schema validation. */
  invalid: { file: string; error: string }[];
};

/**
 * Reads every `*.yml`/`*.yaml` file under `<repoRoot>/.whyguard/decisions/` and
 * validates it against the RationaleContract schema. Missing directory is not an
 * error — it simply means no decisions have been recorded yet.
 */
export function loadRationaleContracts(repoRoot: string): LoadRationaleContractsResult {
  const dirPath = join(repoRoot, DECISIONS_DIR);
  const contracts: RationaleContract[] = [];
  const invalid: { file: string; error: string }[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return { contracts, invalid };
  }

  for (const entry of entries) {
    if (!/\.(ya?ml)$/i.test(entry)) continue;
    const filePath = join(dirPath, entry);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed: unknown = parseYaml(raw);
      contracts.push(parseRationaleContract(parsed));
    } catch (error) {
      invalid.push({ file: filePath, error: describeContractError(error) });
    }
  }

  return { contracts, invalid };
}

/**
 * Turns a schema or YAML failure into one line a human can act on.
 *
 * A `ZodError`'s `message` is a JSON dump of every issue, so anything that shows only its
 * first line prints `[`. Naming the field and the problem is the difference between "your
 * decision file is broken" and "line 9 of must_preserve is a map, not a string".
 */
function describeContractError(error: unknown): string {
  const issues = (error as { issues?: { path?: (string | number)[]; message?: string }[] }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const described = issues
      .slice(0, 3)
      .map((issue) => {
        const path = (issue.path ?? []).join(".");
        return path ? `${path}: ${issue.message ?? "invalid"}` : (issue.message ?? "invalid");
      })
      .join("; ");
    const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
    return `${described}${more}`;
  }
  return error instanceof Error ? error.message.split("\n")[0] || error.name : String(error);
}

/**
 * Normalizes a file path to forward slashes for cross-platform scope matching.
 * Exported so other application use cases (e.g. `list-protected-properties.ts`)
 * that match findings against a `filePath` can reuse the same normalization rule
 * instead of duplicating it.
 */
export function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/").replace(/^\.\//, "");
}

/**
 * Finds the rationale contract (if any) whose scope covers the given file and,
 * when the contract declares symbols, the given symbol. Only `active` contracts are
 * considered a confirmed match — `draft`, `replaced`, and `expired` contracts are
 * returned separately so callers can decide how to treat them (e.g. surface a
 * warning that the property was replaced/expired).
 */
export function findMatchingContract(
  contracts: RationaleContract[],
  filePath: string,
  symbol: string | undefined,
): RationaleContract | undefined {
  const normalizedTarget = normalizePath(filePath);

  return contracts.find((contract) => {
    const scopeMatches = contract.scope.files.some((scopedFile) => {
      const normalizedScoped = normalizePath(scopedFile);
      return (
        normalizedTarget === normalizedScoped || normalizedTarget.endsWith(`/${normalizedScoped}`)
      );
    });
    if (!scopeMatches) return false;

    if (contract.scope.symbols && contract.scope.symbols.length > 0) {
      return symbol !== undefined && contract.scope.symbols.includes(symbol);
    }
    return true;
  });
}

/** Resolves the absolute path to a repository's decisions directory (for tooling/docs). */
export function decisionsDirFor(repoRoot: string): string {
  return resolve(repoRoot, DECISIONS_DIR);
}

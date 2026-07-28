import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseRationaleContract, type RationaleContract } from "@whyguard/contracts";
import { decisionsDirFor } from "./rationale-contracts.js";

/**
 * `whyguard.register_decision` use case.
 *
 * This is the one MCP/application tool in the whole document explicitly marked as
 * requiring human confirmation before it runs ("`register_decision` requires
 * confirmation"; "Never auto-approve tools that register
 * decisions" — same section). Two independent safeguards enforce that here, not
 * just at the MCP transport layer, so any future caller (CLI, another adapter)
 * inherits the same guarantee instead of having to re-implement it:
 *
 * 1. `confirmed` must be passed as literally `true`. There is no default.
 * 2. An existing decision file is never silently overwritten.
 */
export class ConfirmationRequiredError extends Error {
  constructor() {
    super(
      'registerDecision requires an explicit human confirmation ("confirmed: true"); ' +
        "it must never be called from an auto-approved tool path.",
    );
    this.name = "ConfirmationRequiredError";
  }
}

export class DecisionAlreadyExistsError extends Error {
  constructor(filePath: string) {
    super(
      `A decision file already exists at "${filePath}". Pass allowOverwrite: true only if ` +
        "a human explicitly intends to replace it (e.g. bumping its version).",
    );
    this.name = "DecisionAlreadyExistsError";
  }
}

export type RegisterDecisionInput = {
  repoRoot: string;
  /** Must be a valid RationaleContract shape; re-validated here regardless of caller. */
  contract: unknown;
  /** Must be exactly `true`. There is no default — see ConfirmationRequiredError. */
  confirmed: boolean;
  /** Allows replacing an existing decision file with the same id. Defaults to false. */
  allowOverwrite?: boolean;
};

export type RegisterDecisionResult = {
  filePath: string;
  contract: RationaleContract;
};

/**
 * Validates and persists a rationale contract to `.whyguard/decisions/<id>.yml`.
 * Throws `ConfirmationRequiredError` if `confirmed` is not `true`, and throws
 * `DecisionAlreadyExistsError` if a file for the same id already exists and
 * `allowOverwrite` was not set. Never invents or mutates contract fields — it
 * writes exactly what schema validation accepts.
 */
export function registerDecision(input: RegisterDecisionInput): RegisterDecisionResult {
  if (input.confirmed !== true) {
    throw new ConfirmationRequiredError();
  }

  const contract = parseRationaleContract(input.contract);
  const dirPath = decisionsDirFor(input.repoRoot);
  const filePath = join(dirPath, `${contract.id}.yml`);

  if (existsSync(filePath) && input.allowOverwrite !== true) {
    throw new DecisionAlreadyExistsError(filePath);
  }

  mkdirSync(dirPath, { recursive: true });
  writeFileSync(filePath, stringifyYaml(contract), "utf-8");

  return { filePath, contract };
}

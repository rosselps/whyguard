#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getFinding,
  listProtectedProperties,
  proposeRegressionTest,
  recordFinding,
  registerDecision,
  scanDiff,
  traceSymbol,
} from "@whyguard/application";
import {
  getPersistedFinding,
  openDatabase,
  resolveDatabasePath,
  type WhyGuardDatabase,
} from "@whyguard/persistence-adapter";

/**
 * WhyGuard MCP server.
 *
 * Exposes the full MVP tool table: five read-only tools
 * (`scan_diff`, `trace_symbol`, `get_finding`, `list_protected_properties`,
 * `propose_regression_test`) plus one write tool (`register_decision`) that is
 * intentionally the only one gated behind an explicit `confirm: true` input —: "register_decision requires confirmation" and "Never
 * auto-approve tools that register decisions". This server never marks that tool
 * `autoApprove`d, and the tool itself refuses to run without `confirm: true`
 * (see `registerDecision` in `packages/application`), so a client-side
 * misconfiguration cannot silently bypass the safeguard.
 *
 * Deterministic only: this process never calls an LLM or makes network requests.
 * Repository root defaults to `WHYGUARD_REPO_ROOT` if set's env vars.
 *
 * `get_finding` and `propose_regression_test` resolve a finding in two steps: the
 * in-process store first (findings this server just computed via `scan_diff`), then
 * the persisted database. The second step is what lets Kiro open a finding that was
 * produced somewhere else entirely — a GitHub Pull Request analysis by `apps/api`, or
 * an earlier `whyguard scan` — which is Use case C ("a reviewer opens an
 * analysis from the GitHub Check"). Without it, every finding id coming from a Check
 * Run or the dashboard would be unresolvable here.
 */

function defaultRepoRoot(): string {
  return process.env.WHYGUARD_REPO_ROOT ?? process.cwd();
}

/**
 * Opens the persisted database if one is configured, or returns `undefined` to run
 * in memory-only mode.
 *
 * Deliberately non-fatal: the MCP server's deterministic analysis tools
 * (`scan_diff`, `trace_symbol`, `list_protected_properties`) work with no database at
 * all, so a missing or unreadable database must degrade `get_finding` rather than
 * prevent Kiro from using WhyGuard entirely.
 */
function openOptionalDatabase(): WhyGuardDatabase | undefined {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return undefined;

  try {
    return openDatabase(resolveDatabasePath(databaseUrl));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `WhyGuard MCP server: could not open the database (${message}). ` +
        "get_finding will only resolve findings computed in this session.",
    );
    return undefined;
  }
}

function createServer(db?: WhyGuardDatabase): McpServer {
  const server = new McpServer({ name: "whyguard", version: "0.1.0" });

  /**
   * Resolves a finding id from this session's in-memory store, falling back to the
   * persisted database. On a database hit the finding is also recorded in memory so
   * `propose_regression_test` (which reads the same store) can act on it without a
   * second lookup.
   */
  const resolveFinding = (findingId: string) => {
    const inMemory = getFinding(findingId);
    if (inMemory) return inMemory;
    if (!db) return undefined;

    const persisted = getPersistedFinding(db, findingId);
    if (persisted) recordFinding(persisted);
    return persisted;
  };

  server.registerTool(
    "whyguard.scan_diff",
    {
      title: "Scan a Git diff for sensitive historical-decision changes",
      description:
        "Analyzes a Git commit range for changes that may remove or weaken a " +
        "historically protected behavior (guard clauses, validation, boundaries). " +
        "Returns risk/confidence-scored findings with evidence. Read-only, no writes.",
      inputSchema: {
        repoRoot: z
          .string()
          .optional()
          .describe("Repository root. Defaults to WHYGUARD_REPO_ROOT or the server's cwd."),
        base: z.string().min(1).describe("Base Git ref (e.g. a commit SHA or branch name)."),
        head: z.string().min(1).describe("Head Git ref to compare against base."),
      },
    },
    ({ repoRoot, base, head }) => {
      try {
        const report = scanDiff({
          repoRoot: repoRoot ?? defaultRepoRoot(),
          base,
          head,
          source: "kiro",
        });
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `whyguard.scan_diff failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "whyguard.trace_symbol",
    {
      title: "Trace why a symbol looks the way it does",
      description:
        "Reconstructs what is known about a file/symbol right now: any confirmed " +
        "rationale contract, evidence derived from commit history, and the recent " +
        "commit history itself. Use before removing or simplifying suspicious code. " +
        "Read-only, no writes.",
      inputSchema: {
        repoRoot: z
          .string()
          .optional()
          .describe("Repository root. Defaults to WHYGUARD_REPO_ROOT or the server's cwd."),
        filePath: z.string().min(1).describe("Path to the file, relative to repoRoot."),
        symbol: z.string().optional().describe("Symbol name within the file, if known."),
        ref: z.string().optional().describe("Git ref to read history from. Defaults to HEAD."),
      },
    },
    ({ repoRoot, filePath, symbol, ref }) => {
      try {
        const result = traceSymbol({
          repoRoot: repoRoot ?? defaultRepoRoot(),
          filePath,
          symbol,
          ref,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `whyguard.trace_symbol failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "whyguard.get_finding",
    {
      title: "Retrieve a previously computed finding",
      description:
        "Returns the complete Finding for a given finding ID — either one produced by a " +
        "whyguard.scan_diff call in this session, or one persisted earlier by a GitHub " +
        "Pull Request analysis or CLI scan. Read-only, no writes.",
      inputSchema: {
        findingId: z
          .string()
          .min(1)
          .describe("A finding ID from whyguard.scan_diff, a GitHub Check, or the dashboard."),
      },
    },
    ({ findingId }) => {
      const finding = resolveFinding(findingId);
      if (!finding) {
        return {
          content: [
            {
              type: "text",
              text:
                `No finding found for id "${findingId}". ` +
                (db
                  ? "It is not in this session and not in the WhyGuard database."
                  : "No database is configured (set DATABASE_URL), so only findings computed " +
                    "in this session can be resolved. Run whyguard.scan_diff first."),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(finding, null, 2) }] };
    },
  );

  server.registerTool(
    "whyguard.list_protected_properties",
    {
      title: "List protected properties known for a file/symbol",
      description:
        "Returns every ProtectedProperty known for a file (and optionally a symbol): " +
        "confirmed properties from active rationale contracts in .whyguard/decisions/, " +
        "plus proposed properties from any finding recorded so far this session. " +
        "Read-only, no writes.",
      inputSchema: {
        repoRoot: z
          .string()
          .optional()
          .describe("Repository root. Defaults to WHYGUARD_REPO_ROOT or the server's cwd."),
        filePath: z.string().min(1).describe("Path to the file, relative to repoRoot."),
        symbol: z.string().optional().describe("Symbol name within the file, if known."),
      },
    },
    ({ repoRoot, filePath, symbol }) => {
      try {
        const properties = listProtectedProperties({
          repoRoot: repoRoot ?? defaultRepoRoot(),
          filePath,
          symbol,
        });
        return { content: [{ type: "text", text: JSON.stringify(properties, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text", text: `whyguard.list_protected_properties failed: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "whyguard.propose_regression_test",
    {
      title: "Propose a deterministic regression-test skeleton for a finding",
      description:
        "Builds a deterministic regression-test skeleton (not a working test) naming the " +
        "finding's protected property and evidence, using the deterministic-fallback " +
        "policy. This tool never writes the file to disk and never executes anything — a " +
        "human must review and complete the skeleton before it is used. WhyGuard " +
        "rule 9 ('never auto-execute generated tests').",
      inputSchema: {
        findingId: z.string().min(1).describe("The finding ID returned by whyguard.scan_diff."),
        framework: z
          .string()
          .optional()
          .describe('Test framework name, e.g. "vitest" or "jest". Defaults to "vitest".'),
      },
    },
    ({ findingId, framework }) => {
      try {
        // Pull a persisted finding into the in-process store first, so a finding id
        // that came from a GitHub Check or the dashboard also works here.
        resolveFinding(findingId);
        const proposal = proposeRegressionTest({ findingId, framework });
        return { content: [{ type: "text", text: JSON.stringify(proposal, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `whyguard.propose_regression_test failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "whyguard.register_decision",
    {
      title: "Register a confirmed rationale contract (requires human confirmation)",
      description:
        "Persists a validated rationale contract to .whyguard/decisions/<id>.yml. This is " +
        "the one write tool WhyGuard exposes over MCP, and it MUST require " +
        "confirmation — do not add this tool to any client's autoApprove list. The `confirm` " +
        "input must be exactly `true`, or the call is rejected. An existing decision file " +
        "with the same id is never overwritten unless `allowOverwrite` is also explicitly " +
        "set to `true` by a human.",
      inputSchema: {
        repoRoot: z
          .string()
          .optional()
          .describe("Repository root. Defaults to WHYGUARD_REPO_ROOT or the server's cwd."),
        contract: z
          .record(z.string(), z.unknown())
          .describe("A RationaleContract object matching the schema in @whyguard/contracts."),
        confirm: z
          .literal(true)
          .describe("Must be exactly true. A human must have explicitly confirmed this decision."),
        allowOverwrite: z
          .boolean()
          .optional()
          .describe("Set to true only to intentionally replace an existing decision file."),
      },
    },
    ({ repoRoot, contract, confirm, allowOverwrite }) => {
      try {
        const result = registerDecision({
          repoRoot: repoRoot ?? defaultRepoRoot(),
          contract,
          confirmed: confirm,
          allowOverwrite,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { filePath: result.filePath, contract: result.contract },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `whyguard.register_decision failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const db = openOptionalDatabase();
  const server = createServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel for stdio transport; log startup to stderr only.
  console.error(
    `WhyGuard MCP server running on stdio (finding lookup: ${db ? "session + database" : "session only"})`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`WhyGuard MCP server failed to start: ${message}`);
  process.exitCode = 1;
});

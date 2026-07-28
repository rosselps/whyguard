import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { scanPullRequest } from "./scan-pull-request.js";
import { PR_WORKSPACE_PREFIX, sweepStaleWorkspaces } from "./workspace-cleanup.js";

/**
 * Tests for the two host-protection behaviors around `scanPullRequest`. Both exist
 * because WhyGuard deliberately clones full repository history (its evidence engine
 * needs it), which makes disk the resource most likely to run out on a small instance.
 */

const tmpBase = join(process.cwd(), ".tmp", "whyguard-pr-guard-test");

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

/**
 * Minimal Octokit stand-in: only the two calls `scanPullRequest` makes before it would
 * clone anything. If the size guard ever stops short-circuiting, `pulls.get` succeeds
 * but the clone attempt fails loudly instead of silently passing.
 */
function fakeClient(sizeKb: number) {
  // Typed with an explicit parameter so the assertions below can read back what
  // `publishCheckRun` actually sent.
  const checksCreate = vi.fn((_input: unknown) =>
    Promise.resolve({ data: { id: 99, html_url: "https://github.test/check/99" } }),
  );
  const client = {
    rest: {
      pulls: {
        get: vi.fn(() =>
          Promise.resolve({
            data: {
              base: { sha: "a".repeat(40), ref: "main", repo: { size: sizeKb } },
              head: { sha: "b".repeat(40), ref: "feature" },
              title: "Simplify createOrder",
              html_url: "https://github.test/pr/1",
            },
          }),
        ),
      },
      checks: { create: checksCreate, update: vi.fn(() => Promise.resolve({ data: {} })) },
    },
  };
  return { client: client as unknown as Octokit, checksCreate };
}

describe("scanPullRequest repository size guard", () => {
  it("refuses to clone a repository above the limit and says so on the Check Run", async () => {
    const { client, checksCreate } = fakeClient(5 * 1024 * 1024); // ~5 GB

    const result = await scanPullRequest({
      client,
      owner: "acme",
      repo: "monorepo",
      pullNumber: 1,
      cloneUrl: "https://x-access-token:secret@github.test/acme/monorepo.git",
      tempRoot: tmpBase,
      maxRepositorySizeKb: 2 * 1024 * 1024, // ~2 GB
    });

    expect(result.report.findings).toEqual([]);
    // `failed`, not `completed`: a scan that never read the code must not be
    // indistinguishable from one that found nothing wrong.
    expect(result.report.run.status).toBe("failed");
    expect(result.decisions).toEqual([]);

    const checkArgs = checksCreate.mock.calls[0]?.[0] as
      { output?: { summary?: string } } | undefined;
    expect(checkArgs?.output?.summary).toContain("did not analyze");
    expect(checkArgs?.output?.summary).toContain("5120 MB");

    // Nothing was written to disk.
    expect(existsSync(tmpBase) ? readdirSync(tmpBase) : []).toEqual([]);
  });

  it("does not skip a repository within the limit", async () => {
    const { client } = fakeClient(50 * 1024); // ~50 MB

    // The clone will fail (the URL is not a real remote), which is the proof the guard
    // let it through rather than short-circuiting.
    await expect(
      scanPullRequest({
        client,
        owner: "acme",
        repo: "small",
        pullNumber: 1,
        cloneUrl: "https://x-access-token:secret@github.test/acme/small.git",
        tempRoot: tmpBase,
        maxRepositorySizeKb: 2 * 1024 * 1024,
      }),
    ).rejects.toThrow(/git clone/);
  });

  it("never leaks the clone URL's credential into the thrown error", async () => {
    const { client } = fakeClient(1024);

    let message: string;
    try {
      await scanPullRequest({
        client,
        owner: "acme",
        repo: "small",
        pullNumber: 1,
        cloneUrl: "https://x-access-token:super-secret-token@github.test/acme/small.git",
        tempRoot: tmpBase,
      });
      throw new Error("expected the clone to fail");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("git clone");
    expect(message).not.toContain("super-secret-token");
    expect(message).toContain("***@");
  });
});

describe("sweepStaleWorkspaces", () => {
  function makeWorkspace(name: string, ageMs: number): string {
    const path = join(tmpBase, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "file.txt"), "x");
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    return path;
  }

  it("removes abandoned workspaces older than the max age", () => {
    const stale = makeWorkspace(`${PR_WORKSPACE_PREFIX}old`, 3 * 60 * 60 * 1000);

    const result = sweepStaleWorkspaces(tmpBase);

    expect(result.removed).toContain(stale);
    expect(existsSync(stale)).toBe(false);
  });

  it("leaves a workspace that may still be in use by a running scan", () => {
    const fresh = makeWorkspace(`${PR_WORKSPACE_PREFIX}fresh`, 60 * 1000);

    const result = sweepStaleWorkspaces(tmpBase);

    expect(result.removed).not.toContain(fresh);
    expect(existsSync(fresh)).toBe(true);
  });

  /**
   * The sweep runs against a *shared* temp root, so anything it deletes that it did not
   * create is somebody else's data. This is the test that keeps a future "simplify the
   * prefix check" refactor from turning startup into `rm -rf /tmp/*`.
   */
  it("never touches directories it did not create, however old", () => {
    const foreign = makeWorkspace("someone-elses-build-cache", 30 * 24 * 60 * 60 * 1000);

    const result = sweepStaleWorkspaces(tmpBase);

    expect(result.removed).toEqual([]);
    expect(existsSync(foreign)).toBe(true);
  });

  it("returns an empty result when the temp root does not exist yet", () => {
    expect(sweepStaleWorkspaces(join(tmpBase, "never-created"))).toEqual({
      removed: [],
      failed: [],
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  deriveEvidenceFromCommitHistory,
  deriveEvidenceFromCommitMessage,
  extractIssueReferences,
} from "./commit-message-evidence.js";
import type { CommitInfo } from "@whyguard/git-adapter";

function makeCommit(overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: "a1b2c3d4e5f60000000000000000000000000000",
    authorName: "Someone",
    authorEmail: "someone@example.com",
    date: "2024-01-01T00:00:00Z",
    subject: "Fix bug",
    body: "",
    ...overrides,
  };
}

describe("extractIssueReferences", () => {
  it("extracts a bare #number reference", () => {
    const commit = makeCommit({ subject: "See #481 for context" });
    expect(extractIssueReferences(commit)).toEqual([{ number: "481", isClosingReference: false }]);
  });

  it("marks a closing-keyword reference (fixes/closes/resolves)", () => {
    const commit = makeCommit({
      subject: "Enforce idempotency key on createOrder (fixes #481)",
      body: "Closes #481. See PR #493.",
    });
    const refs = extractIssueReferences(commit);
    expect(refs).toEqual(
      expect.arrayContaining([
        { number: "481", isClosingReference: true },
        { number: "493", isClosingReference: false },
      ]),
    );
    expect(refs).toHaveLength(2);
  });

  it("de-duplicates repeated references", () => {
    const commit = makeCommit({ subject: "Fixes #481", body: "Also relates to #481" });
    expect(extractIssueReferences(commit)).toEqual([{ number: "481", isClosingReference: true }]);
  });

  it("returns an empty array when there is no reference", () => {
    const commit = makeCommit({ subject: "Refactor internal helper", body: "" });
    expect(extractIssueReferences(commit)).toEqual([]);
  });
});

describe("deriveEvidenceFromCommitMessage", () => {
  it("produces medium-strength evidence for a closing reference", () => {
    const commit = makeCommit({ subject: "Fixes #481" });
    const evidence = deriveEvidenceFromCommitMessage(commit);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.strength).toBe("medium");
    expect(evidence[0]?.type).toBe("issue");
  });

  it("produces weak-strength evidence for a non-closing reference", () => {
    const commit = makeCommit({ subject: "See #481 for background" });
    const evidence = deriveEvidenceFromCommitMessage(commit);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.strength).toBe("weak");
  });

  it("never claims strong evidence purely from a commit message", () => {
    const commit = makeCommit({ subject: "Fixes #481, closes #482, resolves #483" });
    const evidence = deriveEvidenceFromCommitMessage(commit);
    expect(evidence.every((item) => item.strength !== "strong")).toBe(true);
  });
});

/**
 * Found by running `whyguard trace` against axios: nearly every commit subject in a
 * GitHub repository ends in the pull request it was squash-merged through, so harvesting
 * those produced 50+ meaningless `weak` items and inflated the repeated-incident risk
 * factor with dependency bumps.
 */
describe("squash-merge pull request suffix", () => {
  it("ignores a trailing (#number) added by a squash merge", () => {
    const commit = makeCommit({
      subject: "chore(deps-dev): bump postcss from 8.5.10 to 8.5.23 (#11099)",
    });
    expect(extractIssueReferences(commit)).toEqual([]);
    expect(deriveEvidenceFromCommitMessage(commit)).toEqual([]);
  });

  it("keeps a closing reference that happens to sit in parentheses at the end", () => {
    const commit = makeCommit({ subject: "Enforce the response size limit (fixes #7011)" });
    expect(extractIssueReferences(commit)).toEqual([{ number: "7011", isClosingReference: true }]);
  });

  it("keeps references in the body even when the subject ends in a merge suffix", () => {
    const commit = makeCommit({
      subject: "fix(node): enforce maxContentLength for data: URLs (#7011)",
      body: "Closes #6989.",
    });
    expect(extractIssueReferences(commit)).toEqual([{ number: "6989", isClosingReference: true }]);
  });

  it("keeps a mid-subject reference, which is not a merge artifact", () => {
    const commit = makeCommit({ subject: "Revert #4102 because it broke streaming" });
    expect(extractIssueReferences(commit)).toEqual([{ number: "4102", isClosingReference: false }]);
  });
});

describe("deriveEvidenceFromCommitHistory", () => {
  it("reports each issue once, keeping its strongest mention", () => {
    const evidence = deriveEvidenceFromCommitHistory([
      makeCommit({ sha: "c".repeat(40), subject: "More work on #77" }),
      makeCommit({ sha: "b".repeat(40), subject: "Partial revert, see #77" }),
      makeCommit({ sha: "a".repeat(40), subject: "Add the guard", body: "Fixes #77." }),
    ]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.strength).toBe("medium");
  });

  it("orders stronger evidence first", () => {
    const evidence = deriveEvidenceFromCommitHistory([
      makeCommit({ sha: "d".repeat(40), subject: "Mentions #10" }),
      makeCommit({ sha: "e".repeat(40), subject: "Closes #20" }),
    ]);

    expect(evidence.map((item) => item.strength)).toEqual(["medium", "weak"]);
  });
});

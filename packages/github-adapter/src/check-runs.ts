import type { Octokit } from "@octokit/rest";

/**
 * Check Run publication. Requires the
 * `checks: write` permission — the only write permission this App
 * needs for the MVP.
 */

export type CheckRunConclusion =
  "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required";

export type CheckRunAnnotation = {
  path: string;
  startLine: number;
  endLine: number;
  annotationLevel: "notice" | "warning" | "failure";
  message: string;
  title?: string;
};

export type PublishCheckRunInput = {
  owner: string;
  repo: string;
  /** The commit SHA the check applies to (the PR head SHA). */
  headSha: string;
  conclusion: CheckRunConclusion;
  title: string;
  /** Markdown summary shown at the top of the Check Run. */
  summary: string;
  /** Markdown details shown below the summary (collapsed by default in the UI). */
  text?: string;
  annotations?: CheckRunAnnotation[];
};

const CHECK_RUN_NAME = "WhyGuard / Historical Decision Check";

/**
 * Creates a completed Check Run in one call. WhyGuard's analysis is synchronous
 * enough (deterministic core, no LLM) that a single create-with-conclusion call is
 * sufficient — there is no need to create an in_progress run first and update it
 * later, unlike long-running CI checks.
 */
export async function publishCheckRun(
  client: Octokit,
  input: PublishCheckRunInput,
): Promise<{ id: number; htmlUrl: string | null }> {
  // GitHub allows at most 50 annotations per request; batch the rest with update
  // calls if a finding set ever exceeds that (uncommon for the demo/MVP scope).
  const firstBatch = (input.annotations ?? []).slice(0, 50);

  const { data } = await client.rest.checks.create({
    owner: input.owner,
    repo: input.repo,
    name: CHECK_RUN_NAME,
    head_sha: input.headSha,
    status: "completed",
    conclusion: input.conclusion,
    output: {
      title: input.title,
      summary: input.summary,
      text: input.text,
      annotations: firstBatch.map((annotation) => ({
        path: annotation.path,
        start_line: annotation.startLine,
        end_line: annotation.endLine,
        annotation_level: annotation.annotationLevel,
        message: annotation.message,
        title: annotation.title,
      })),
    },
  });

  const remaining = (input.annotations ?? []).slice(50);
  if (remaining.length > 0) {
    await client.rest.checks.update({
      owner: input.owner,
      repo: input.repo,
      check_run_id: data.id,
      output: {
        title: input.title,
        summary: input.summary,
        annotations: remaining.slice(0, 50).map((annotation) => ({
          path: annotation.path,
          start_line: annotation.startLine,
          end_line: annotation.endLine,
          annotation_level: annotation.annotationLevel,
          message: annotation.message,
          title: annotation.title,
        })),
      },
    });
  }

  return { id: data.id, htmlUrl: data.html_url };
}

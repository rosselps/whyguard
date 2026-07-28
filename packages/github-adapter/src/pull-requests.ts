import type { Octokit } from "@octokit/rest";

/**
 * Minimal Pull Request read operations. No write access
 * to repository contents — Contents permission is Read-only for the MVP.
 */

export type PullRequestRef = {
  owner: string;
  repo: string;
  number: number;
};

export type PullRequestRefs = {
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  title: string;
  htmlUrl: string;
  /**
   * Size of the base repository in kilobytes, as reported by GitHub. Comes free with
   * this same `pulls.get` response — no extra API call — and lets a caller decide
   * whether cloning is affordable *before* it starts writing to disk. WhyGuard clones
   * full history by design (see `cloneRepository`), so on a small instance this is the
   * only cheap signal available about how much disk a scan is about to consume.
   *
   * `0` when GitHub omits it, which callers must treat as "unknown", not "empty".
   */
  baseRepoSizeKb: number;
};

/** Fetches the base/head SHAs and refs for a Pull Request. */
export async function getPullRequestRefs(
  client: Octokit,
  ref: PullRequestRef,
): Promise<PullRequestRefs> {
  const { data } = await client.rest.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.number,
  });

  return {
    baseSha: data.base.sha,
    headSha: data.head.sha,
    baseRef: data.base.ref,
    headRef: data.head.ref,
    title: data.title,
    htmlUrl: data.html_url,
    baseRepoSizeKb: data.base.repo.size ?? 0,
  };
}

export type IssueRef = {
  owner: string;
  repo: string;
  number: number;
};

export type IssueMetadata = {
  title: string;
  body: string | null;
  htmlUrl: string;
  state: string;
};

/** Fetches minimal metadata for an issue or PR, used to enrich evidence with a real title/body. */
export async function getIssueMetadata(client: Octokit, ref: IssueRef): Promise<IssueMetadata> {
  const { data } = await client.rest.issues.get({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.number,
  });

  return {
    title: data.title,
    body: data.body ?? null,
    htmlUrl: data.html_url,
    state: data.state,
  };
}

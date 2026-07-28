---
inclusion: always
---

# WhyGuard — Security and privacy

- Spawn Git with argument arrays, never concatenation. Validate that paths resolve inside
  the target workspace.
- Capture Git's stderr rather than inheriting it: inherited stderr printed handled failures
  to the user's terminal and leaked a clone URL's token past the redaction applied to
  thrown errors.
- Never log source files, tokens, or secrets. `.env` is never committed; `.env.example`
  carries empty values.
- Never execute a generated regression test.
- Verify webhook signatures with HMAC-SHA256 and a constant-time comparison; deduplicate by
  `X-GitHub-Delivery`.
- Installation tokens are per-installation and never persisted. A clone URL embedding one is
  redacted before it can reach an error message.
- Clone into a unique `mkdtempSync` workspace and delete it in `finally`. A startup sweep
  reclaims workspaces orphaned by a process that died mid-scan.
- Check a repository's size before cloning. Clones carry full history, so disk usage follows
  the repository rather than the pull request.
- Acknowledge a webhook (202) before scanning, so a slow analysis never triggers a retry.
- The read API fails closed: loopback only with no token, and a public deployment must name
  the repositories it exposes. Answer 404 rather than 403 for a repository outside that
  list — 403 confirms the id exists and turns the endpoint into an enumeration oracle.
- Persist repository identity as `owner/repo`, never a server path.

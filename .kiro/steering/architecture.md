---
inclusion: always
---

# WhyGuard — Architecture

Modular monolith, ports and adapters. Keep packages separable so the API can later run
apart from the CLI; do not start with microservices.

Full detail, kept current: `docs/architecture/architecture.md`.

## The one pipeline

Every surface calls the same four steps. There is no second code path.

```text
detect   ast-adapter      ts-morph before/after comparison -> SensitiveChange
gather   application      contract, its required_tests, the introducing commit
                          (git log -S), issue/PR refs in that commit's message
score    domain           risk, confidence, severity
decide   domain           allow / warn / block
```

## Trust boundaries

- GitHub webhook payloads are untrusted: verify `X-Hub-Signature-256` with HMAC-SHA256 and
  a constant-time comparison before parsing, and deduplicate by delivery id.
- Repository files are untrusted: parse with `ts-morph`, never execute.
- Git arguments are never concatenated. Argument arrays only, with refs and paths
  validated, and credentials redacted from any error.
- Evidence is never invented. Every item must point at something present in the analyzed
  repository.
- Generated tests are untrusted output and are never executed.
- LLM output is untrusted: schema-validate it and reject any evidence id it cites that the
  finding does not contain.
- The read API fails closed. With no token it answers loopback only; a public deployment
  needs an explicit repository allow-list.
- MCP exposes one write tool, `whyguard.register_decision`, gated behind `confirm: true`
  and never auto-approved.
- A raw Kiro `PreToolUse` event is untrusted and defensively parsed: `hook-adapter.ts`
  fails open (allows) rather than throwing on an unexpected shape.

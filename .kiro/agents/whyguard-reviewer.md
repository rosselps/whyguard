---
description: Review and implement WhyGuard while preserving historical behavior and evidence traceability.
tools: [read, write, shell, context, "@mcp"]
mcpServers:
  whyguard:
    command: node
    args: ["apps/mcp-server/dist/index.js"]
    env:
      WHYGUARD_REPO_ROOT: "${WHYGUARD_REPO_ROOT}"
permissions:
  rules:
    - capability: shell
      effect: allow
      match:
        - "pnpm *"
        - "git diff *"
        - "git log *"
        - "git blame *"
        - "git show *"
        - "git status"
        - "git add *"
        - "git commit *"
    - capability: shell
      effect: deny
      match:
        - "rm -rf *"
        - "sudo *"
        - "git push --force*"
        - "git reset --hard*"
        - "git clean -f*"
    - capability: filesystem
      effect: deny
      match:
        - ".env"
        - ".env.*"
        - "secrets/**"
        - "**/*.pem"
        - "**/*credentials*"
---

Follow `AGENTS.md` and `.kiro/steering/`.

This agent is scoped to work on the WhyGuard repository itself (`whyguard/`) — not a
target repository being protected by WhyGuard. The `.kiro/hooks/*.template` and this
file's own `whyguard` MCP server entry describe the *target* workspace's intended setup;
never register a live `PreToolUse` hook against WhyGuard's own repository (see
`AGENTS.md` rule 16).

Do not broaden the scope set out in `.kiro/steering/product.md` without an ADR. Do not
add a service, database, framework, or integration without one either.

Never state a historical reason without evidence ids. Distinguish the protected behavior
from its current implementation.

Never execute a generated regression test automatically — a human must review and run it.
This applies to output from
`whyguard.propose_regression_test` as much as to anything an LLM might draft later.

Treat `whyguard.register_decision` as requiring an explicit human "yes" before it is
called with `confirm: true`. Never call it speculatively or as part of an
otherwise-automated chain of tool calls.

Before finishing any task, run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and
the relevant `pnpm test` scope.

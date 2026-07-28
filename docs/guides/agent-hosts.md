# Wiring WhyGuard into an agent host

WhyGuard is not built for one editor. Three of its four surfaces have no editor in them at
all, and the fourth — intercepting a write before it lands — is host-specific by nature,
because there is no cross-editor API for "a tool is about to write this file".

This document is the contract for that fourth surface, and the state of each host.

## What is already host-agnostic

| Surface | Depends on | Works in |
| --- | --- | --- |
| Git pre-commit hook | Git | Every editor, every OS, and no editor at all |
| GitHub Check Run | A signed webhook | Server-side; the editor is irrelevant |
| MCP server | `@modelcontextprotocol/sdk` over stdio | Any MCP client |
| Pre-write interception | The host's own hook API | One thin adapter per host |

The MCP server is worth stating plainly because it is the part people assume is
Kiro-specific and is not: it speaks the standard protocol over stdio, so any MCP-capable
client can call `whyguard.trace_symbol`, `whyguard.scan_diff`,
`whyguard.list_protected_properties`, `whyguard.propose_regression_test`,
`whyguard.get_finding` and `whyguard.register_decision` today, with no change to WhyGuard.
Point the client at `whyguard-mcp-server` and set `WHYGUARD_REPO_ROOT`.

## The integration contract

`whyguard guard --stdin` is the neutral entry point. It reads a `GuardRequest`
(`packages/contracts/src/schemas.ts`) as JSON on STDIN:

```json
{
  "repoRoot": "/abs/path/to/repo",
  "filePath": "src/payments/create-order.ts",
  "afterContent": "<the content the agent is about to write>",
  "beforeContent": "<optional; read from disk when omitted>"
}
```

It exits `0` on allow and warn, and `2` on block with the reason on STDERR.

That shape is WhyGuard's own, deliberately, and not any host's event payload. A host adapter
has exactly one job: map the host's event onto those three or four fields. Everything after
that — detection, evidence, scoring, the block rule — is the same code the Git hook and the
GitHub App run, which is what makes a verdict identical across surfaces.

`whyguard hook` is that adapter for Kiro, and the only one that ships today. It exists as a
separate command rather than as documentation because Kiro's payload uses `snake_case` field
names that nothing else uses, and because the response has to be Kiro's
`permissionDecision` JSON rather than an exit code.

## Mapping per host

All three hosts below follow the same pattern — JSON on stdin, a decision on stdout or via
the exit code — so each adapter is a field rename, not a redesign.

| Host | Event | Where the path is | Where the new content is | How to answer |
| --- | --- | --- | --- | --- |
| **Kiro** | `PreToolUse`, matcher `fs_write\|str_replace` | `tool_input.path` (absolute) | `tool_input.text` | `{"hookSpecificOutput":{"permissionDecision":"ask", ...}}` on STDOUT, exit 0 |
| **Claude Code** | `PreToolUse`, matcher `Edit\|Write` | `tool_input.file_path` | `tool_input.content` | Blocking exit status; stderr is fed back to the model |
| **Cursor** | `preToolUse` / `afterFileEdit` | event payload | event payload | JSON on stdout with the decision |

Two details decide whether any of this actually holds, and both were learned the hard way:

**Prefer a permission prompt over an exit code where the host offers one.** A plain exit `2`
tells the agent it failed; it does not stop the agent from trying again with a different
tool. We measured this: two models applied the edit anyway. Kiro's `permissionDecision:
"ask"` routes the decision to the human, and an agent cannot answer a dialog on the user's
behalf. Use the strongest control the host exposes, not the most convenient one.

**Always pair the pre-write hook with a post-turn check.** `whyguard verify --scope
working-tree` inspects the result instead of asking permission, so it still catches a
removal that slipped through — a tool the matcher missed, a host without a pre-write hook, an
edit applied outside the agent. In Kiro that is the `Stop` hook; in Claude Code, `Stop`;
elsewhere, a file watcher, an editor task, or `lint-staged`.

## Hosts with no pre-write hook

Some editors and agents expose nothing before a write. That removes one layer and none of the
others, and the remaining ones are the stronger two anyway:

1. **MCP**, so the agent can ask *before* editing rather than being stopped after deciding.
   `whyguard.trace_symbol` on a file and symbol returns the confirmed decision, the protected
   properties and the evidence. An agent that reads that does not need to be blocked.
2. **`whyguard verify --scope working-tree`** after the fact, wired to whatever the host does
   offer — a task, a watcher, a save hook.
3. **The commit gate.** It is the layer nobody can ignore by accident, editor or no editor,
   and it is the one that does not depend on the agent cooperating at all.

The pre-write prompt is the nicest of the four to demo. It is not the one carrying the
guarantee.

## Not built yet

Stated plainly rather than implied:

- Adapters for Claude Code and Cursor. The mapping table above is derived from each host's
  documented hook payloads, not from a shipped adapter we have run in anger.
- `whyguard init --host <name>` writing the right hook file per host. Today `init` writes
  Kiro's.
- A VS Code extension. Worth saying that an extension is a *worse* fit than it sounds: the
  thing worth intercepting is an agent's write, and in VS Code that write comes from
  whichever agent extension the user installed, which a second extension cannot see. The
  leverage is in the agent host, not in the editor.

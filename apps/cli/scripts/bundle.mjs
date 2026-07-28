import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the single-file `whyguard` CLI that gets published to npm.
 *
 * Why bundle instead of publishing the workspace: the CLI depends on eight
 * `@whyguard/*` workspace packages. Publishing them all would mean eight releases
 * kept in lockstep for every change, and consumers downloading internal packages
 * they never import directly. Inlining them produces one artifact whose version is
 * the only thing a user ever sees.
 *
 * Third-party dependencies are deliberately NOT inlined. They stay `external` and are
 * declared as real dependencies, so npm resolves and dedupes them normally. Bundling
 * them would break the ones that resolve files at runtime, hide their licenses from
 * dependency tooling, and make the tarball large for no benefit.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const outfile = join(packageRoot, "dist-bundle", "whyguard.js");

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));

/**
 * Everything npm will install for the user. Derived from the manifest rather than
 * hardcoded, so adding a dependency can never silently start getting inlined (which
 * would ship a stale copy alongside the installed one).
 */
const external = [
  ...Object.keys(manifest.dependencies ?? {}),
  // Optional peers must stay external too: the AWS SDK is loaded through a dynamic
  // import only when Bedrock is explicitly enabled, and it is deliberately not
  // installed by default. Inlining it would defeat that and pull megabytes into a
  // bundle most users never execute.
  ...Object.keys(manifest.peerDependencies ?? {}),
];

await build({
  entryPoints: [join(packageRoot, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Keeps the published artifact debuggable: a stack trace from a user's machine maps
  // back to real source positions instead of one giant generated line.
  sourcemap: true,
  // `node:` builtins are external automatically on the node platform; this covers the
  // installed packages.
  external,
  // No `banner` shebang here: esbuild already carries over the one from src/index.ts.
  // Adding another produced two shebang lines, and a `#!` on line 2 is a syntax error,
  // so the published binary failed on every invocation. Caught by installing the packed
  // tarball rather than by any unit test.
  logLevel: "info",
});

// npm preserves the executable bit from the tarball; set it so a POSIX install can run
// `whyguard` without an explicit `node` prefix. No-op on filesystems without it.
try {
  chmodSync(outfile, 0o755);
} catch {
  // Windows filesystems reject chmod; npm sets the bit at install time from the
  // tarball metadata, so this is not fatal for the published package.
}

// This is a build script, not application code: its output is meant for the terminal.
// `process.stdout` rather than `console` keeps it within the repo's lint rules.
process.stdout.write(`\nBundled ${outfile}\n`);
process.stdout.write(`External (installed by npm): ${external.join(", ")}\n`);

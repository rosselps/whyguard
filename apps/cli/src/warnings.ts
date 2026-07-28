/**
 * Silences Node's `ExperimentalWarning` for `node:sqlite`, which the persistence adapter
 * imports.
 *
 * Without this, two lines of Node internals prefixed every single command's output —
 * including `--format json` on stderr — telling the user about an implementation detail
 * they did not choose and cannot act on. Every other warning is still printed.
 *
 * Must be imported before anything that reaches `node:sqlite`, since the warning is
 * emitted while that module is being evaluated. ES module imports run in source order, so
 * this file is the first import in the entrypoint.
 */
const defaultListeners = process.listeners("warning");
process.removeAllListeners("warning");

process.on("warning", (warning) => {
  const isSqliteExperiment =
    warning.name === "ExperimentalWarning" && warning.message.includes("SQLite");
  if (isSqliteExperiment) return;
  for (const listener of defaultListeners) listener(warning);
});

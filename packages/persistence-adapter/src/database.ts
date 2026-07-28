import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// `node:sqlite` ships with Node itself (stable enough for this MVP since Node
// 22.5; still flagged "experimental" by Node's own docs as of this writing — see
// tech.md). Chosen over `better-sqlite3` specifically to avoid a native-module
// build step (node-gyp + a C++ toolchain) that isn't available on every
// contributor's machine out of the box.
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { migrate } from "./schema.js";

export type WhyGuardDatabase = DatabaseSync;

/**
 * `node:sqlite` is loaded on first use rather than at import time.
 *
 * Importing it statically makes Node emit its ExperimentalWarning while the module graph
 * is being instantiated — before any application code runs, so it cannot be filtered.
 * That put two lines of Node internals in front of every CLI command, including ones that
 * never open a database. Loading it here keeps the type import (erased at compile time)
 * and defers the value until something actually needs a connection.
 */
let databaseSyncCtor: typeof DatabaseSync | undefined;

function loadDatabaseSync(): typeof DatabaseSync {
  if (!databaseSyncCtor) {
    const nodeRequire = createRequire(import.meta.url);
    databaseSyncCtor = (nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync })
      .DatabaseSync;
  }
  return databaseSyncCtor;
}

/**
 * Opens (creating if necessary) the WhyGuard SQLite database and applies the
 * schema. `location` should be a filesystem path (e.g. the value of
 * `DATABASE_URL=file:./data/whyguard.db` with the `file:` prefix stripped) or
 * `:memory:` for tests.
 */
export function openDatabase(location: string): WhyGuardDatabase {
  if (location !== ":memory:") {
    mkdirSync(dirname(location), { recursive: true });
  }
  const DatabaseSyncCtor = loadDatabaseSync();
  const db = new DatabaseSyncCtor(location);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(
    (sql) => db.exec(sql),
    (table, column) => hasColumn(db, table, column),
  );
  return db;
}

/** Checks whether `table` currently has `column`, via SQLite's `pragma_table_info`. */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
  return rows.some((row) => row.name === column);
}

/**
 * Resolves a `DATABASE_URL`-style value (e.g. `file:./data/whyguard.db`) to a
 * plain filesystem path `node:sqlite` accepts. Passing `:memory:` through
 * unchanged supports in-memory test databases.
 */
export function resolveDatabasePath(databaseUrl: string): string {
  if (databaseUrl === ":memory:") return databaseUrl;
  return databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl;
}

/** Closes a database handle. Safe to call multiple times. */
export function closeDatabase(db: WhyGuardDatabase): void {
  db.close();
}

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, resolveDatabasePath } from "./database.js";

describe("resolveDatabasePath", () => {
  it("strips the file: prefix from a DATABASE_URL-style value", () => {
    expect(resolveDatabasePath("file:./data/whyguard.db")).toBe("./data/whyguard.db");
  });

  it("passes :memory: through unchanged", () => {
    expect(resolveDatabasePath(":memory:")).toBe(":memory:");
  });

  it("passes a bare path through unchanged", () => {
    expect(resolveDatabasePath("./data/whyguard.db")).toBe("./data/whyguard.db");
  });
});

describe("openDatabase", () => {
  it("opens an in-memory database and applies the schema", () => {
    const db = openDatabase(":memory:");
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["repositories", "analysis_runs", "findings", "decisions"]),
    );
    closeDatabase(db);
  });

  it("creates the parent directory for a file-backed database", () => {
    const dbPath = join(process.cwd(), ".tmp", "persistence-adapter-test", "test.db");
    rmSync(join(process.cwd(), ".tmp", "persistence-adapter-test"), {
      recursive: true,
      force: true,
    });

    const db = openDatabase(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    closeDatabase(db);
  });

  it("is idempotent — opening the same schema twice does not throw", () => {
    const db1 = openDatabase(":memory:");
    closeDatabase(db1);
    const db2 = openDatabase(":memory:");
    closeDatabase(db2);
  });

  it("adds llm_explanation_json to an existing findings table missing that column", () => {
    const dbPath = join(process.cwd(), ".tmp", "persistence-adapter-migration-test", "old.db");
    rmSync(join(process.cwd(), ".tmp", "persistence-adapter-migration-test"), {
      recursive: true,
      force: true,
    });

    // Simulate a database created before this column existed: build the
    // `findings` table by hand, without llm_explanation_json, bypassing
    // migrate() entirely.
    const preMigration = openDatabase(dbPath);
    preMigration.exec("DROP TABLE findings;");
    preMigration.exec(`
      CREATE TABLE findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        symbol TEXT,
        change_kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        risk_score INTEGER NOT NULL,
        confidence_score INTEGER NOT NULL,
        reason_status TEXT NOT NULL,
        explanation TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        matching_decision_id TEXT,
        regression_test_status TEXT NOT NULL DEFAULT 'missing',
        evidence_json TEXT NOT NULL,
        protected_properties_json TEXT NOT NULL,
        change_json TEXT NOT NULL
      );
    `);
    closeDatabase(preMigration);

    // Re-opening (the same code path every real process uses) must add the
    // missing column without dropping existing data.
    const reopened = openDatabase(dbPath);
    const columns = reopened.prepare(`SELECT name FROM pragma_table_info('findings')`).all() as {
      name: string;
    }[];
    expect(columns.map((c) => c.name)).toContain("llm_explanation_json");
    closeDatabase(reopened);
  });

  afterEach(() => {
    rmSync(join(process.cwd(), ".tmp", "persistence-adapter-test"), {
      recursive: true,
      force: true,
    });
    rmSync(join(process.cwd(), ".tmp", "persistence-adapter-migration-test"), {
      recursive: true,
      force: true,
    });
  });
});

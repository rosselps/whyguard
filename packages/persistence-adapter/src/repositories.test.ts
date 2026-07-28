import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type WhyGuardDatabase } from "./database.js";
import { listRepositories, repositoryId, upsertRepository } from "./repositories.js";

describe("repositoryId", () => {
  it("is stable across calls for the same repository ref", () => {
    const ref = { provider: "github" as const, owner: "acme", name: "widgets" };
    expect(repositoryId(ref)).toBe(repositoryId(ref));
  });

  it("differs for repositories with different owners", () => {
    const a = repositoryId({ provider: "github", owner: "acme", name: "widgets" });
    const b = repositoryId({ provider: "github", owner: "other", name: "widgets" });
    expect(a).not.toBe(b);
  });

  it("handles a missing owner (local provider) without throwing", () => {
    expect(() => repositoryId({ provider: "local", name: "my-repo" })).not.toThrow();
  });
});

describe("upsertRepository / listRepositories", () => {
  let db: WhyGuardDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it("inserts a new repository and returns its id", () => {
    const id = upsertRepository(db, { provider: "github", owner: "acme", name: "widgets" });
    const repos = listRepositories(db);
    expect(repos).toHaveLength(1);
    expect(repos[0]?.id).toBe(id);
    expect(repos[0]?.name).toBe("widgets");
  });

  it("does not duplicate a repository on repeated upsert", () => {
    upsertRepository(db, { provider: "github", owner: "acme", name: "widgets" });
    upsertRepository(db, { provider: "github", owner: "acme", name: "widgets" });
    expect(listRepositories(db)).toHaveLength(1);
  });

  it("updates the root on conflict", () => {
    upsertRepository(db, { provider: "local", name: "my-repo", root: "/tmp/a" });
    upsertRepository(db, { provider: "local", name: "my-repo", root: "/tmp/b" });
    const repos = listRepositories(db);
    expect(repos).toHaveLength(1);
    expect(repos[0]?.root).toBe("/tmp/b");
  });
});

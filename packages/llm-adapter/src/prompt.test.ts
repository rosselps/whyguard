import { describe, expect, it } from "vitest";
import { buildExplanationPrompt } from "./prompt.js";
import { buildTestFinding } from "./test-helpers.js";

describe("buildExplanationPrompt", () => {
  it("includes the finding's file path, symbol, and evidence IDs", () => {
    const prompt = buildExplanationPrompt(buildTestFinding());
    expect(prompt).toContain("src/payments/create-order.ts");
    expect(prompt).toContain("createOrder");
    expect(prompt).toContain("ev_issue_481");
  });

  it("instructs the model to only use listed evidence IDs", () => {
    const prompt = buildExplanationPrompt(buildTestFinding());
    expect(prompt).toContain("Only use the evidence IDs listed below");
  });

  it("renders a placeholder when there is no evidence", () => {
    const prompt = buildExplanationPrompt(buildTestFinding({ evidence: [] }));
    expect(prompt).toContain("(none)");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { detectSensitiveChanges, resetChangeIdCounterForTests } from "./detector.js";

describe("detectSensitiveChanges", () => {
  beforeEach(() => {
    resetChangeIdCounterForTests();
  });

  it("detects removal of an early-return guard clause (condition_removed)", () => {
    const before = `
      function createOrder(key: string) {
        const existing = lookup(key);
        if (existing) {
          return existing;
        }
        return build(key);
      }
    `;
    const after = `
      function createOrder(key: string) {
        return build(key);
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/payments/create-order.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("condition_removed");
    expect(changes[0]?.symbol).toBe("createOrder");
  });

  it("detects removal of a validation call (validation_removed)", () => {
    const before = `
      function process(amount: number) {
        validateAmount(amount);
        return amount * 2;
      }
    `;
    const after = `
      function process(amount: number) {
        return amount * 2;
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/billing/process.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("validation_removed");
  });

  it("detects a boundary/operator change on a matching comparison (boundary_changed)", () => {
    const before = `
      function isExpired(age: number) {
        return age > 30;
      }
    `;
    const after = `
      function isExpired(age: number) {
        return age >= 30;
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/policy/is-expired.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("boundary_changed");
    expect(changes[0]?.before).toContain(">");
    expect(changes[0]?.after).toContain(">=");
  });

  it("does not cross-match unrelated comparisons that share operand text (false-positive control)", () => {
    // Regression test for a real false positive found during manual end-to-end
    // verification against an external repository: a function with two
    // *different*, unrelated comparisons that happen to share the same left
    // operand (`humidity`) against different literals must not be reported as
    // a boundary change when neither comparison actually changed.
    const source = `
      function classify(humidity: number) {
        let status = "";
        if (humidity > 80) {
          status = "too high";
        }
        if (humidity <= 80) {
          status = "ok";
        }
        return status;
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/climate/classify.ts",
      beforeContent: source,
      afterContent: source,
    });

    expect(changes).toHaveLength(0);
  });

  it("still detects a real boundary change alongside an unrelated, unchanged comparison", () => {
    const before = `
      function classify(humidity: number, ppm: number) {
        let status = "";
        if (humidity > 80) {
          status = "too high";
        }
        if (ppm <= 3000) {
          status = "ok";
        }
        return status;
      }
    `;
    const after = `
      function classify(humidity: number, ppm: number) {
        let status = "";
        if (humidity >= 80) {
          status = "too high";
        }
        if (ppm <= 3000) {
          status = "ok";
        }
        return status;
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/climate/classify.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("boundary_changed");
    expect(changes[0]?.before).toBe("humidity > 80");
    expect(changes[0]?.after).toBe("humidity >= 80");
  });

  it("ignores formatting-only changes (false-positive control)", () => {
    const before = `
      function add(a: number, b: number) {
        if (a < 0) {
          return b;
        }
        return a + b;
      }
    `;
    const after = `
      function add(a: number, b: number) {

        if (a < 0) {
          return b;
        }

        return a + b;
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/math/add.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(0);
  });

  it("ignores a guard clause that is only cosmetically renamed (false-positive control)", () => {
    // Regression test for a real false positive found during manual end-to-end
    // verification of the Kiro PreToolUse hook: renaming `existing` to
    // `priorOrder` (identical behavior) was reported as `condition_removed`
    // because the guard comparison matched on raw condition text.
    const before = `
      function createOrder(key: string) {
        const existing = lookup(key);
        if (existing) {
          return existing;
        }
        return build(key);
      }
    `;
    const after = `
      function createOrder(key: string) {
        const priorOrder = lookup(key);
        if (priorOrder) {
          return priorOrder;
        }
        return build(key);
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/payments/create-order.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(0);
  });

  it("still detects a guard removal disguised as a rename (same shape, different identifier count)", () => {
    // The identifier-normalization fix must not make the detector blind to a
    // guard that was actually weakened while looking cosmetically similar:
    // comparing two different variables (`a === b`) is not the same shape as
    // comparing a variable to itself (`a === a`) once each distinct identifier
    // is deduplicated to its own placeholder.
    const before = `
      function isSameUser(a: string, b: string) {
        if (a === a) {
          return true;
        }
        return a === b;
      }
    `;
    const after = `
      function isSameUser(a: string, b: string) {
        if (a === b) {
          return true;
        }
        return a === b;
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/auth/is-same-user.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("condition_removed");
  });

  it("does not ignore a guard that changes which property is checked (rename-blind spot control)", () => {
    // Property names are not normalized (only local identifiers are), so
    // checking a different field entirely must still be detected.
    const before = `
      function createOrder(order: Order) {
        if (order.amount) {
          return order;
        }
        return build(order);
      }
    `;
    const after = `
      function createOrder(order: Order) {
        if (order.total) {
          return order;
        }
        return build(order);
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/payments/create-order.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("condition_removed");
  });

  it("ignores redundant grouping parens added around a guard condition (false-positive control)", () => {
    // Found during a systematic false-positive/negative sweep after the
    // rename fix above: `(existing)` produces a `ParenthesizedExpression` node
    // that normalizeIdentifiers previously treated as literal `(`/`)` text,
    // breaking the signature match against the unparenthesized original even
    // though the condition is behaviorally identical.
    const before = `
      function createOrder(key: string) {
        const existing = lookup(key);
        if (existing) {
          return existing;
        }
        return build(key);
      }
    `;
    const after = `
      function createOrder(key: string) {
        const existing = lookup(key);
        if ((existing)) {
          return existing;
        }
        return build(key);
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/payments/create-order.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(0);
  });

  it("ignores added/reformatted arguments on a validation call that is otherwise unchanged (false-positive control)", () => {
    // Found during the same sweep: matching validation calls by full call text
    // (including arguments) meant strengthening a call with an extra argument
    // — not removing it — read as `validation_removed`.
    const before = `
      function process(amount: number) {
        validateAmount(amount);
        return amount * 2;
      }
    `;
    const after = `
      function process(amount: number) {
        validateAmount(amount, { strict: true });
        return amount * 2;
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/billing/process.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(0);
  });

  it("still detects validation removal when the callee is swapped for a differently-named one (documented trade-off)", () => {
    // WhyGuard intentionally does NOT treat a renamed validation callee as
    // "the same validation preserved" — unlike a local guard variable rename,
    // there is no safe way to confirm a differently-named function performs
    // an equivalent check without risking a false negative on a real,
    // quietly-weakened validation. This is documented in
    // `extractValidationCalls`, not an oversight; this test locks the
    // behavior in so it isn't accidentally "fixed" away later.
    const before = `
      function process(amount: number) {
        validateAmount(amount);
        return amount * 2;
      }
    `;
    const after = `
      function process(amount: number) {
        checkAmount(amount);
        return amount * 2;
      }
    `;

    const changes = detectSensitiveChanges({
      filePath: "src/billing/process.ts",
      beforeContent: before,
      afterContent: after,
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("validation_removed");
  });

  describe("timeout_changed", () => {
    it("detects a shortened timeout constant", () => {
      const before = `
        function fetchOrder(id: string) {
          const REQUEST_TIMEOUT_MS = 30000;
          return request(id, REQUEST_TIMEOUT_MS);
        }
      `;
      const after = `
        function fetchOrder(id: string) {
          const REQUEST_TIMEOUT_MS = 500;
          return request(id, REQUEST_TIMEOUT_MS);
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/orders/fetch-order.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("timeout_changed");
      expect(changes[0]?.before).toBe("REQUEST_TIMEOUT_MS = 30000");
      expect(changes[0]?.after).toBe("REQUEST_TIMEOUT_MS = 500");
    });

    it("detects a lowered duration declared at module scope", () => {
      // Where a backoff actually lives in real code: one exported constant, read by
      // every call site. The per-function walk cannot see it.
      const before = `
        export const RETRY_BACKOFF_MS = 2000;
        export async function capture(send: () => Promise<void>) {
          await send();
        }
      `;
      const after = `
        export const RETRY_BACKOFF_MS = 250;
        export async function capture(send: () => Promise<void>) {
          await send();
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/payments.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("timeout_changed");
      // The constant is its own symbol: there is no enclosing function to attribute it
      // to, and a contract matches on symbol names.
      expect(changes[0]?.symbol).toBe("RETRY_BACKOFF_MS");
      expect(changes[0]?.before).toBe("RETRY_BACKOFF_MS = 2000");
    });

    it("ignores a module-scope constant whose name carries no duration meaning", () => {
      const before = `export const MAX_ITEMS_PER_PAGE = 20;`;
      const after = `export const MAX_ITEMS_PER_PAGE = 50;`;

      expect(
        detectSensitiveChanges({
          filePath: "src/paging.ts",
          beforeContent: before,
          afterContent: after,
        }),
      ).toEqual([]);
    });

    it("does not report a module-scope duration twice when a function also reads it", () => {
      const before = `
        export const POLL_INTERVAL_MS = 5000;
        function start() {
          return setInterval(tick, POLL_INTERVAL_MS);
        }
      `;
      const after = `
        export const POLL_INTERVAL_MS = 100;
        function start() {
          return setInterval(tick, POLL_INTERVAL_MS);
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/poll.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.symbol).toBe("POLL_INTERVAL_MS");
    });

    it("detects a lengthened timeout too (no safe direction for durations)", () => {
      // Unlike a retry count, neither direction is inherently safe: a longer timeout
      // can restore the exact hang the original value was chosen to avoid.
      const before = `
        function poll() {
          return client.fetch({ timeout: 1000 });
        }
      `;
      const after = `
        function poll() {
          return client.fetch({ timeout: 60000 });
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/poll.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("timeout_changed");
    });

    it("detects a changed setTimeout delay argument", () => {
      const before = `
        function scheduleReconcile(run: () => void) {
          setTimeout(run, 5000);
        }
      `;
      const after = `
        function scheduleReconcile(run: () => void) {
          setTimeout(run, 0);
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/reconcile.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("timeout_changed");
    });

    it("ignores an unrelated numeric constant (false-positive control)", () => {
      // Only duration/retry-named settings are in the allowlist — an arbitrary
      // numeric change must not be reported's strict-allowlist rule.
      const before = `
        function priceWithTax(amount: number) {
          const TAX_RATE_PERCENT = 18;
          return amount * (1 + TAX_RATE_PERCENT / 100);
        }
      `;
      const after = `
        function priceWithTax(amount: number) {
          const TAX_RATE_PERCENT = 21;
          return amount * (1 + TAX_RATE_PERCENT / 100);
        }
      `;

      expect(
        detectSensitiveChanges({
          filePath: "src/pricing.ts",
          beforeContent: before,
          afterContent: after,
        }),
      ).toHaveLength(0);
    });

    it("ignores a duration that did not actually change (false-positive control)", () => {
      const source = `
        function poll() {
          const POLL_INTERVAL_MS = 2000;
          return schedule(POLL_INTERVAL_MS);
        }
      `;

      expect(
        detectSensitiveChanges({
          filePath: "src/poll.ts",
          beforeContent: source,
          afterContent: source,
        }),
      ).toHaveLength(0);
    });

    it("classifies a retry *delay* as a duration change, not a retry count change", () => {
      // `retryDelayMs` matches both name patterns; duration wins, otherwise the
      // retry-count direction rule would be applied to a value where it makes no sense.
      const before = `
        function send() {
          return post({ retryDelayMs: 1000 });
        }
      `;
      const after = `
        function send() {
          return post({ retryDelayMs: 5000 });
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/send.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("timeout_changed");
    });
  });

  describe("retry_removed", () => {
    it("detects a lowered retry count", () => {
      const before = `
        function chargeCard(token: string) {
          const maxRetries = 3;
          return attemptCharge(token, maxRetries);
        }
      `;
      const after = `
        function chargeCard(token: string) {
          const maxRetries = 1;
          return attemptCharge(token, maxRetries);
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/payments/charge-card.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes.some((change) => change.kind === "retry_removed")).toBe(true);
    });

    it("ignores a raised retry count (strengthening, not weakening)", () => {
      const before = `
        function chargeCard(token: string) {
          const maxRetries = 3;
          return charge(token, maxRetries);
        }
      `;
      const after = `
        function chargeCard(token: string) {
          const maxRetries = 5;
          return charge(token, maxRetries);
        }
      `;

      expect(
        detectSensitiveChanges({
          filePath: "src/payments/charge-card.ts",
          beforeContent: before,
          afterContent: after,
        }),
      ).toHaveLength(0);
    });

    it("detects removal of a retry wrapper call", () => {
      const before = `
        function syncInventory(sku: string) {
          return withRetry(() => pushInventory(sku));
        }
      `;
      const after = `
        function syncInventory(sku: string) {
          return pushInventory(sku);
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/inventory/sync.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("retry_removed");
      expect(changes[0]?.before).toBe("withRetry(...)");
    });

    it("ignores a retry wrapper that is still present (false-positive control)", () => {
      const source = `
        function syncInventory(sku: string) {
          return withRetry(() => pushInventory(sku));
        }
      `;

      expect(
        detectSensitiveChanges({
          filePath: "src/inventory/sync.ts",
          beforeContent: source,
          afterContent: source,
        }),
      ).toHaveLength(0);
    });
  });

  describe("function-like coverage beyond plain declarations", () => {
    it("detects a guard removed from an arrow function assigned to a const", () => {
      // Real false negative found while testing against sindresorhus/got: the
      // detector only collected FunctionDeclaration and MethodDeclaration, so an
      // arrow-function module (the dominant style in modern TS/JS) was never
      // analyzed at all and removing a guard produced zero findings.
      const before = `
        const calculateRetryDelay = ({ statusCode, attempt }) => {
          if (statusCode === 413) {
            return 0;
          }
          return attempt * 1000;
        };
      `;
      const after = `
        const calculateRetryDelay = ({ statusCode, attempt }) => {
          return attempt * 1000;
        };
      `;

      const changes = detectSensitiveChanges({
        filePath: "source/core/calculate-retry-delay.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.kind).toBe("condition_removed");
      expect(changes[0]?.symbol).toBe("calculateRetryDelay");
    });

    it("detects a guard removed from a class property arrow function", () => {
      const before = `
        class Uploader {
          upload = (file: File) => {
            if (file.size > 0) {
              return send(file);
            }
            return null;
          };
        }
      `;
      const after = `
        class Uploader {
          upload = (file: File) => {
            return send(file);
          };
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/upload.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.symbol).toBe("upload");
    });

    it("attributes a removal to the nested function that owned it, exactly once", () => {
      // Collecting arrow functions as their own declarations means a node inside a
      // nested callback could be attributed to both the outer and inner function,
      // double-reporting the same removal. Each node belongs only to its nearest
      // enclosing function.
      const before = `
        function processAll(items) {
          return items.map(function mapItem(item) {
            if (!item.id) {
              return null;
            }
            return transform(item);
          });
        }
      `;
      const after = `
        function processAll(items) {
          return items.map(function mapItem(item) {
            return transform(item);
          });
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/process.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.symbol).toBe("mapItem");
    });

    it("ignores an anonymous inline callback (no stable identity to match)", () => {
      // An unnamed callback has no name to match across before/after; matching it by
      // position would invent findings whenever a callback moved.
      const before = `
        function activeOnly(items) {
          return items.filter(item => {
            if (!item.active) {
              return false;
            }
            return true;
          });
        }
      `;
      const after = `
        function activeOnly(items) {
          return items.filter(item => Boolean(item.active));
        }
      `;

      expect(
        detectSensitiveChanges({
          filePath: "src/filter.ts",
          beforeContent: before,
          afterContent: after,
        }),
      ).toHaveLength(0);
    });

    it("detects a guard removed from a class method (still works)", () => {
      const before = `
        class OrderService {
          create(key: string) {
            if (this.seen.has(key)) {
              return this.seen.get(key);
            }
            return this.build(key);
          }
        }
      `;
      const after = `
        class OrderService {
          create(key: string) {
            return this.build(key);
          }
        }
      `;

      const changes = detectSensitiveChanges({
        filePath: "src/orders/service.ts",
        beforeContent: before,
        afterContent: after,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]?.symbol).toBe("create");
    });
  });

  it("returns no changes when before or after content is unavailable", () => {
    expect(
      detectSensitiveChanges({ filePath: "x.ts", beforeContent: null, afterContent: "code" }),
    ).toHaveLength(0);
    expect(
      detectSensitiveChanges({ filePath: "x.ts", beforeContent: "code", afterContent: null }),
    ).toHaveLength(0);
  });
});

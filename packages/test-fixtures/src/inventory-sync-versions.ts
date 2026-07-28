/**
 * The two versions of the warehouse inventory module used by the "timeouts" scenario,
 * which shows the outcome the payments scenario cannot: a change WhyGuard detects and
 * explains but does not block, because nobody wrote the decision down. Only a confirmed
 * contract produces `strong` evidence, and only strong evidence can block.
 *
 * SAFE retries a flaky provider and waits 30s. UNSAFE is the plausible "make it faster"
 * edit — shorter timeout, fewer retries, retry wrapper gone — which reintroduces silently
 * dropped batches.
 */

export const SAFE_SYNC_INVENTORY = `export type InventoryBatch = {
  sku: string;
  quantity: number;
};

/**
 * Pushes an inventory batch to the warehouse provider.
 */
export async function syncInventory(batch: InventoryBatch[]): Promise<void> {
  const REQUEST_TIMEOUT_MS = 30000;
  const maxRetries = 3;

  await withRetry(() => postBatch(batch, REQUEST_TIMEOUT_MS), maxRetries);
}

async function postBatch(batch: InventoryBatch[], timeoutMs: number): Promise<void> {
  await fetch("https://warehouse.example/inventory", {
    method: "POST",
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function withRetry(operation: () => Promise<void>, attempts: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

export const UNSAFE_SYNC_INVENTORY = `export type InventoryBatch = {
  sku: string;
  quantity: number;
};

/**
 * Pushes an inventory batch to the warehouse provider.
 */
export async function syncInventory(batch: InventoryBatch[]): Promise<void> {
  const REQUEST_TIMEOUT_MS = 3000;
  const maxRetries = 1;

  await postBatch(batch, REQUEST_TIMEOUT_MS);
}

async function postBatch(batch: InventoryBatch[], timeoutMs: number): Promise<void> {
  await fetch("https://warehouse.example/inventory", {
    method: "POST",
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function withRetry(operation: () => Promise<void>, attempts: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

/**
 * The contract for this decision, deliberately **not** committed by the fixture builder.
 * The demo writes it partway through so the same unchanged code visibly goes from warned
 * to blocked purely because a human recorded why the behavior exists.
 */
export const INVENTORY_SYNC_DECISION = `id: inventory-sync-resilience
version: 1
status: active
scope:
  files:
    - src/logistics/sync-inventory.ts
  symbols:
    - syncInventory
reason: >
  The warehouse provider returns 504 under load. Without retries and a generous
  timeout, inventory batches are silently dropped and stock counts drift until
  someone notices oversold items.
must_preserve:
  - Inventory batches are retried at least 3 times before being reported as failed.
  - The request timeout stays at or above 30 seconds.
evidence:
  - type: issue
    id: "212"
  - type: pull_request
    id: "219"
required_tests:
  - tests/logistics/sync-inventory.test.ts
expires_when:
  - The warehouse provider publishes an SLA that rules out 504 responses under load.
owners:
  - logistics-team
`;

/**
 * The two versions of the payment module used by the demo fixture repository.
 *
 * SAFE_CREATE_ORDER contains the idempotency guard introduced by PR #493 to fix
 * Issue #481 (duplicate orders on client retry after a gateway timeout).
 *
 * UNSAFE_CREATE_ORDER is what an "obvious simplification" looks like: the guard
 * clause is removed because it looks redundant, silently reintroducing the
 * duplicate-order bug.
 */

export const SAFE_CREATE_ORDER = `export type Order = {
  id: string;
  idempotencyKey: string;
  amount: number;
};

const existingOrders = new Map<string, Order>();

/**
 * Creates an order for the given idempotency key.
 *
 * Historical context (Issue #481 / PR #493): clients retry checkout requests when
 * a payment gateway call times out, even though the server already completed the
 * operation. Without the guard below, a retry creates a second order and charges
 * the customer twice.
 */
export function createOrder(idempotencyKey: string, amount: number): Order {
  const existing = existingOrders.get(idempotencyKey);
  if (existing) {
    return existing;
  }

  validateAmount(amount);

  const order: Order = {
    id: generateOrderId(),
    idempotencyKey,
    amount,
  };
  existingOrders.set(idempotencyKey, order);
  return order;
}

function validateAmount(amount: number): void {
  if (amount <= 0) {
    throw new Error("Amount must be positive");
  }
}

function generateOrderId(): string {
  return \`ord_\${Math.random().toString(36).slice(2, 10)}\`;
}
`;

export const UNSAFE_CREATE_ORDER = `export type Order = {
  id: string;
  idempotencyKey: string;
  amount: number;
};

const existingOrders = new Map<string, Order>();

/**
 * Creates an order for the given idempotency key.
 */
export function createOrder(idempotencyKey: string, amount: number): Order {
  validateAmount(amount);

  const order: Order = {
    id: generateOrderId(),
    idempotencyKey,
    amount,
  };
  existingOrders.set(idempotencyKey, order);
  return order;
}

function validateAmount(amount: number): void {
  if (amount <= 0) {
    throw new Error("Amount must be positive");
  }
}

function generateOrderId(): string {
  return \`ord_\${Math.random().toString(36).slice(2, 10)}\`;
}
`;

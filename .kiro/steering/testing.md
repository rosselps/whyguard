---
inclusion: always
---

# WhyGuard — Testing

- Every new detector pattern or risk rule needs a unit test.
- Use cases touching multiple adapters need an integration test against a real fixture
  repository (`packages/test-fixtures`), not mocks of the adapters they integrate.
- No reliance on wall-clock time, network, or hidden global state. Inject `now()` or fixed
  ids where determinism matters.
- A test that pins a *reason* is worth more than one that pins a number. When a score
  changes, the test should say why the old value was wrong.
- Before finishing: `pnpm typecheck`, `pnpm lint`, and the relevant tests.
- Behavior only reachable after bundling (a published CLI) needs a real `npm pack` plus
  install check — three release bugs got through unit tests and were caught that way.

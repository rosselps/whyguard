import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { accessModeOf, apiTokenGuard, rateLimit, securityHeaders } from "./security.js";

/**
 * Tests for the API's access control and abuse limits.
 *
 * The behavior under test is what stands between a public deployment and every
 * repository's analysis history: file paths, changed code fragments, protected
 * properties and evidence. "Fails closed" is the property that matters most here, so
 * the no-token/remote-client case is asserted explicitly.
 */
function makeRequest(overrides: {
  remoteAddress?: string;
  headers?: Record<string, string>;
}): Request {
  const headers = overrides.headers ?? {};
  return {
    socket: { remoteAddress: overrides.remoteAddress ?? "127.0.0.1" },
    header: (name: string) => headers[name],
  } as unknown as Request;
}

function makeResponse() {
  const state = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const res = {
    // Express always provides this; the guard records the granted access mode on it so
    // the read routes can decide what to serve.
    locals: {} as Record<string, unknown>,
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
    },
  } as unknown as Response;
  return { res, state };
}

describe("apiTokenGuard", () => {
  /**
   * The public allow-list is the only way to serve a caller with no credential, so the
   * cases below are about what it must NOT do: expose anything beyond the names an
   * operator typed, and never turn a wrong token into a quiet downgrade.
   */
  describe("public allow-list", () => {
    it("grants public access to a remote client when repositories are named", () => {
      const guard = apiTokenGuard({ publicRepositories: ["acme/demo"] });
      const next = vi.fn();
      const { res, state } = makeResponse();

      guard(makeRequest({ remoteAddress: "203.0.113.7" }), res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(state.statusCode).toBe(0);
      expect(accessModeOf(res)).toBe("public");
    });

    it("still fails closed when the list is empty", () => {
      const guard = apiTokenGuard({ publicRepositories: [] });
      const next = vi.fn();
      const { res, state } = makeResponse();

      guard(makeRequest({ remoteAddress: "203.0.113.7" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
    });

    it("gives a loopback client full access rather than the public subset", () => {
      const guard = apiTokenGuard({ publicRepositories: ["acme/demo"] });
      const next = vi.fn();
      const { res } = makeResponse();

      guard(makeRequest({ remoteAddress: "127.0.0.1" }), res, next);

      expect(accessModeOf(res)).toBe("loopback");
    });

    it("rejects a wrong token instead of downgrading it to public access", () => {
      // A typo in a deployment's token must look broken, not look like it worked while
      // quietly serving a different, smaller dataset.
      const guard = apiTokenGuard({ token: "right", publicRepositories: ["acme/demo"] });
      const next = vi.fn();
      const { res, state } = makeResponse();

      guard(
        makeRequest({ remoteAddress: "203.0.113.7", headers: { Authorization: "Bearer wrong" } }),
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
    });
  });

  describe("no token configured (local development)", () => {
    it("allows a loopback client", () => {
      const guard = apiTokenGuard({});
      const next = vi.fn();
      const { res, state } = makeResponse();

      guard(makeRequest({ remoteAddress: "127.0.0.1" }), res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(state.statusCode).toBe(0);
    });

    it("allows an IPv4-mapped IPv6 loopback client", () => {
      // Node reports this form when a client connects to a dual-stack listener; a
      // guard that only matched "127.0.0.1" would lock out local development.
      const guard = apiTokenGuard({});
      const next = vi.fn();
      const { res } = makeResponse();

      guard(makeRequest({ remoteAddress: "::ffff:127.0.0.1" }), res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it("fails closed for a remote client instead of exposing analyses", () => {
      // The whole point: a deployment that forgot to set a token must not serve every
      // repository's history to anyone who finds the URL.
      const guard = apiTokenGuard({});
      const next = vi.fn();
      const { res, state } = makeResponse();

      guard(makeRequest({ remoteAddress: "203.0.113.7" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
      expect(JSON.stringify(state.body)).toContain("WHYGUARD_API_TOKEN");
    });
  });

  describe("token configured", () => {
    const guard = apiTokenGuard({ token: "s3cret-token" });

    it("allows a request presenting the correct bearer token", () => {
      const next = vi.fn();
      const { res } = makeResponse();

      guard(
        makeRequest({
          remoteAddress: "203.0.113.7",
          headers: { Authorization: "Bearer s3cret-token" },
        }),
        res,
        next,
      );

      expect(next).toHaveBeenCalledOnce();
    });

    it("rejects a wrong token", () => {
      const next = vi.fn();
      const { res, state } = makeResponse();

      guard(
        makeRequest({
          remoteAddress: "203.0.113.7",
          headers: { Authorization: "Bearer wrong-token" },
        }),
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
    });

    it("rejects a missing Authorization header", () => {
      const next = vi.fn();
      const { res, state } = makeResponse();

      guard(makeRequest({ remoteAddress: "203.0.113.7" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
    });

    it("rejects a token of a different length without throwing", () => {
      // timingSafeEqual throws on length mismatch; the guard must handle that rather
      // than crash the request (a crash is also an oracle for token length).
      const next = vi.fn();
      const { res, state } = makeResponse();

      expect(() =>
        guard(
          makeRequest({
            remoteAddress: "203.0.113.7",
            headers: { Authorization: "Bearer short" },
          }),
          res,
          next,
        ),
      ).not.toThrow();
      expect(state.statusCode).toBe(401);
    });

    it("still requires the token from a loopback client once one is configured", () => {
      // Otherwise anything able to reach the loopback interface (another process on a
      // shared host, a misconfigured proxy) would bypass the token entirely.
      const next = vi.fn();
      const { res, state } = makeResponse();

      guard(makeRequest({ remoteAddress: "127.0.0.1" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(401);
    });
  });
});

describe("rateLimit", () => {
  it("allows requests up to the configured maximum", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    const next = vi.fn();

    for (let i = 0; i < 3; i += 1) {
      const { res } = makeResponse();
      limiter(makeRequest({ remoteAddress: "203.0.113.7" }), res, next);
    }

    expect(next).toHaveBeenCalledTimes(3);
  });

  it("rejects the request that exceeds the maximum, with Retry-After", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 2 });
    const next = vi.fn();

    for (let i = 0; i < 2; i += 1) {
      const { res } = makeResponse();
      limiter(makeRequest({ remoteAddress: "203.0.113.7" }), res, next);
    }
    const { res, state } = makeResponse();
    limiter(makeRequest({ remoteAddress: "203.0.113.7" }), res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(state.statusCode).toBe(429);
    expect(Number(state.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("counts each client address independently", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    const first = makeResponse();
    limiter(makeRequest({ remoteAddress: "203.0.113.7" }), first.res, next);
    const second = makeResponse();
    limiter(makeRequest({ remoteAddress: "203.0.113.8" }), second.res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(second.state.statusCode).toBe(0);
  });

  it("starts a fresh window after the previous one expires", () => {
    vi.useFakeTimers();
    try {
      const limiter = rateLimit({ windowMs: 1_000, max: 1 });
      const next = vi.fn();

      limiter(makeRequest({}), makeResponse().res, next);
      const blocked = makeResponse();
      limiter(makeRequest({}), blocked.res, next);
      expect(blocked.state.statusCode).toBe(429);

      vi.advanceTimersByTime(1_500);
      const afterWindow = makeResponse();
      limiter(makeRequest({}), afterWindow.res, next);

      expect(afterWindow.state.statusCode).toBe(0);
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("securityHeaders", () => {
  it("sets nosniff, frame denial and a stripped referrer", () => {
    const middleware = securityHeaders();
    const next = vi.fn();
    const { res, state } = makeResponse();

    middleware(makeRequest({}), res, next);

    expect(state.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(state.headers["X-Frame-Options"]).toBe("DENY");
    expect(state.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(next).toHaveBeenCalledOnce();
  });
});

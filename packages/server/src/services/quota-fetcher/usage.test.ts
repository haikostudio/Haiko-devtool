import { describe, expect, it, vi } from "vitest";
import {
  balanceToneFromRemaining,
  fetchProviderApi,
  friendlyProviderErrorMessage,
  ProviderRateLimitError,
  retryAfterMsFrom,
  toneFromUsedPct,
  usedPctOf,
} from "./usage.js";

describe("toneFromUsedPct", () => {
  // Thresholds must match deriveTone in the app's provider-usage/tone.ts, which is what
  // the client applies when a window arrives without a tone.
  it.each([
    [0, "ok"],
    [69.9, "ok"],
    [70, "warning"],
    [90, "warning"],
    [90.1, "danger"],
    [100, "danger"],
    [150, "danger"],
  ])("%s%% used is %s", (usedPct, expected) => {
    expect(toneFromUsedPct(usedPct)).toBe(expected);
  });

  it("is neutral when the percentage is unknown", () => {
    expect(toneFromUsedPct(null)).toBe("default");
    expect(toneFromUsedPct(undefined)).toBe("default");
  });
});

describe("usedPctOf", () => {
  it("computes a percentage of the limit", () => {
    expect(usedPctOf(15.79, 42.5)).toBeCloseTo(37.15, 2);
  });

  it("is unknown when either side is missing", () => {
    expect(usedPctOf(null, 100)).toBeNull();
    expect(usedPctOf(50, null)).toBeNull();
  });

  // A zero limit would divide to Infinity and render as a full red bar.
  it("is unknown when the limit is zero or negative", () => {
    expect(usedPctOf(50, 0)).toBeNull();
    expect(usedPctOf(50, -1)).toBeNull();
  });
});

describe("fetchProviderApi rate limiting", () => {
  const noWait = vi.fn(async () => {});

  function respondWith(statuses: number[], headers: Record<string, string> = {}) {
    let call = 0;
    return vi.fn(async () => {
      const status = statuses[Math.min(call, statuses.length - 1)];
      call += 1;
      return new Response(status === 200 ? "{}" : "", { status, headers });
    }) as unknown as typeof fetch;
  }

  it("retries a 429 with an increasing delay and returns the eventual success", async () => {
    const fetchApi = respondWith([429, 429, 200]);
    const sleep = vi.fn(async () => {});

    const res = await fetchProviderApi(fetchApi, "https://example.test/usage", {}, { sleep });

    expect(res.status).toBe(200);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
  });

  it("waits exactly as long as Retry-After asks", async () => {
    const fetchApi = respondWith([429, 200], { "retry-after": "2" });
    const sleep = vi.fn(async () => {});

    await fetchProviderApi(fetchApi, "https://example.test/usage", {}, { sleep });

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  // Anthropic's usage endpoint answers a sustained block with `retry-after: 0`. Taken
  // literally that means "retry now", which turned one refusal into three back-to-back
  // ones and kept the block alive. Retry-After is a floor, never a licence to hammer.
  it("still backs off on its own schedule when Retry-After asks for no wait at all", async () => {
    const fetchApi = respondWith([429, 429, 200], { "retry-after": "0" });
    const sleep = vi.fn(async () => {});

    await fetchProviderApi(fetchApi, "https://example.test/usage", {}, { sleep });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
  });

  // Ten providers refresh in one batch with a client waiting on all of them: a long
  // Retry-After is honoured by backing off entirely, not by holding the request open.
  it("gives up immediately when Retry-After is longer than the inline budget", async () => {
    const fetchApi = respondWith([429], { "retry-after": "120" });
    const sleep = vi.fn(async () => {});

    await expect(
      fetchProviderApi(fetchApi, "https://example.test/usage", {}, { sleep }),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws a typed rate-limit error rather than a 429 response", async () => {
    const fetchApi = respondWith([429]);

    const error = await fetchProviderApi(
      fetchApi,
      "https://example.test/usage",
      {},
      { sleep: noWait },
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect((error as ProviderRateLimitError).retryAfterMs).toBeNull();
  });

  it("reads Retry-After in either legal form", () => {
    const nowMs = Date.parse("2026-07-28T10:00:00.000Z");
    expect(retryAfterMsFrom(new Headers({ "retry-after": "30" }), nowMs)).toBe(30_000);
    expect(
      retryAfterMsFrom(new Headers({ "retry-after": "Tue, 28 Jul 2026 10:00:45 GMT" }), nowMs),
    ).toBe(45_000);
    expect(retryAfterMsFrom(new Headers(), nowMs)).toBeNull();
  });
});

describe("friendlyProviderErrorMessage", () => {
  // The whole point of the fix: no card ever reads "Claude usage API returned 429".
  it("never echoes the transport status back to the user", () => {
    for (const raw of [
      new ProviderRateLimitError(null),
      new Error("Claude usage API returned 429"),
      new Error("Codex usage API returned 500"),
      new Error("The operation was aborted due to timeout"),
    ]) {
      const message = friendlyProviderErrorMessage(raw);
      expect(message).not.toMatch(/\d{3}/);
      expect(message).not.toMatch(/API/);
    }
  });

  it("says a rate limit is a busy service, and a timeout a slow one", () => {
    expect(friendlyProviderErrorMessage(new Error("429 Too Many Requests"))).toMatch(/busy/i);
    expect(friendlyProviderErrorMessage(new Error("fetch timed out"))).toMatch(/in time/i);
  });
});

describe("balanceToneFromRemaining", () => {
  // Kept for balances with no limit, where no percentage can be computed. It only
  // escalates at exhaustion, which is why anything with a limit should use
  // toneFromUsedPct instead.
  it("stays ok until nothing is left", () => {
    expect(balanceToneFromRemaining(0.01)).toBe("ok");
    expect(balanceToneFromRemaining(0)).toBe("danger");
    expect(balanceToneFromRemaining(null)).toBe("default");
  });
});

import { describe, expect, it } from "vitest";

import {
  formatBytesShort,
  getDiskSpaceInfo,
  isDiskFullErrorMessage,
  resolveWorktreeMinFreeBytes,
  WORKTREE_MIN_FREE_BYTES_DEFAULT,
} from "./disk-space.js";

describe("isDiskFullErrorMessage", () => {
  it("matches the out-of-space error family regardless of case", () => {
    expect(isDiskFullErrorMessage("ENOSPC: no space left on device")).toBe(true);
    expect(isDiskFullErrorMessage("fatal: unable to write file")).toBe(true);
    expect(isDiskFullErrorMessage("Disk quota exceeded")).toBe(true);
    expect(isDiskFullErrorMessage("Not enough space on the volume")).toBe(true);
  });

  it("does not match unrelated git errors", () => {
    expect(isDiskFullErrorMessage("fatal: branch already checked out")).toBe(false);
    expect(isDiskFullErrorMessage("unknown revision")).toBe(false);
  });
});

describe("resolveWorktreeMinFreeBytes", () => {
  it("defaults to the built-in floor", () => {
    expect(resolveWorktreeMinFreeBytes({})).toBe(WORKTREE_MIN_FREE_BYTES_DEFAULT);
  });

  it("honours PASEO_WORKTREE_MIN_FREE_MB", () => {
    expect(resolveWorktreeMinFreeBytes({ PASEO_WORKTREE_MIN_FREE_MB: "512" })).toBe(
      512 * 1024 * 1024,
    );
  });

  it("ignores invalid overrides", () => {
    expect(resolveWorktreeMinFreeBytes({ PASEO_WORKTREE_MIN_FREE_MB: "nope" })).toBe(
      WORKTREE_MIN_FREE_BYTES_DEFAULT,
    );
    expect(resolveWorktreeMinFreeBytes({ PASEO_WORKTREE_MIN_FREE_MB: "-5" })).toBe(
      WORKTREE_MIN_FREE_BYTES_DEFAULT,
    );
  });
});

describe("formatBytesShort", () => {
  it("renders human-friendly sizes", () => {
    expect(formatBytesShort(0)).toBe("0 B");
    expect(formatBytesShort(1024)).toBe("1 KB");
    expect(formatBytesShort(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytesShort(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });

  it("never renders negative sizes", () => {
    expect(formatBytesShort(-100)).toBe("0 B");
  });
});

describe("getDiskSpaceInfo", () => {
  it("reports positive totals for a real path", async () => {
    const info = await getDiskSpaceInfo(process.cwd());
    expect(info.totalBytes).toBeGreaterThan(0);
    expect(info.freeBytes).toBeGreaterThanOrEqual(0);
    expect(info.availablePercent).toBeGreaterThanOrEqual(0);
    expect(info.availablePercent).toBeLessThanOrEqual(100);
  });
});

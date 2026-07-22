import { describe, expect, it } from "vitest";

import { toWorktreeWireError } from "./worktree-errors.js";
import { DiskFullError } from "../utils/worktree.js";

describe("toWorktreeWireError", () => {
  it("maps DiskFullError to the disk_full wire code", () => {
    const error = new DiskFullError({
      freeBytes: 100 * 1024 * 1024,
      requiredBytes: 2 * 1024 * 1024 * 1024,
      path: "/home/paseo/.paseo/worktrees",
    });
    const wire = toWorktreeWireError(error);
    expect(wire.code).toBe("disk_full");
    expect(wire.message).toContain("free");
  });

  it("falls back to unknown for generic errors", () => {
    expect(toWorktreeWireError(new Error("boom")).code).toBe("unknown");
    expect(toWorktreeWireError("boom").code).toBe("unknown");
  });
});

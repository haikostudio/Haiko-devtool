import { statfs } from "node:fs/promises";

export interface DiskSpaceInfo {
  freeBytes: number;
  totalBytes: number;
  availablePercent: number;
}

/**
 * Best-effort free-space probe for the filesystem backing `path`.
 * Uses the POSIX `statfs` "available to unprivileged users" count so it matches
 * what a non-root process can actually write.
 */
export async function getDiskSpaceInfo(path: string): Promise<DiskSpaceInfo> {
  const stats = await statfs(path);
  const freeBytes = stats.bavail * stats.bsize;
  const totalBytes = stats.blocks * stats.bsize;
  const availablePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 100;
  return { freeBytes, totalBytes, availablePercent };
}

// Floor below which we refuse to carve out a new worktree. Creating one still
// runs dependency setup, so we need real headroom, not the last few megabytes.
export const WORKTREE_MIN_FREE_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * Resolve the minimum free-space floor, honouring `PASEO_WORKTREE_MIN_FREE_MB`
 * so operators on tight VPS volumes can tune it without a rebuild.
 */
export function resolveWorktreeMinFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PASEO_WORKTREE_MIN_FREE_MB;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed * 1024 * 1024);
    }
  }
  return WORKTREE_MIN_FREE_BYTES_DEFAULT;
}

const DISK_FULL_PATTERNS = [
  "enospc",
  "no space left on device",
  "unable to write file",
  "disk quota exceeded",
  "not enough space",
];

/** Detect the "out of disk" family of errors in a raw git/OS message. */
export function isDiskFullErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return DISK_FULL_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function formatBytesShort(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 100 || unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

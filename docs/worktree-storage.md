# Worktree storage — sharing deps, disk guardrails, post-deploy cleanup

Task worktrees (the isolated checkout each task board atelier runs in) live under
`$PASEO_HOME/worktrees/<project-hash>/<slug>`. On a small VPS the dominant cost is
**not** the source tree (git shares that) but the per-worktree `node_modules` — a
full monorepo install is ~1.9 GB. A handful of ateliers saturates the disk and
every new `git worktree add` fails with a raw `unable to write file`.

## 1. Shared dependency store (`scripts/setup-worktree-deps.mjs`)

The worktree `setup` in `paseo.json` runs `node ./scripts/setup-worktree-deps.mjs`
instead of `npm ci`. It keeps ONE canonical install per lockfile in a shared store
and hard-links each worktree's `node_modules` to it:

- Store location: `$PASEO_HOME/worktrees/.deps-store/<lockfile-hash>` (hidden sibling
  of the per-project worktree dirs, so it is on the **same filesystem** — a hard-link
  requirement). Override with `PASEO_WORKTREE_DEPS_STORE`.
- First worktree on a given lockfile does a real `npm ci`, then seeds the store from
  the fresh install (`cp -al`, hard-links share the content).
- Later worktrees `cp -al` the store into place: file **content** is shared (≈0 bytes),
  each worktree still gets its own directory tree so the relative workspace symlinks
  (`node_modules/@getpaseo/x -> ../packages/x`) resolve to that worktree's sources.
- Keyed by `sha256(package-lock.json)`: a branch that changes dependencies gets its own
  store entry and a real install, so stale modules are never served.
- Any failure falls back to a plain `npm ci`. Correctness first, savings second.

Per-worktree footprint drops from gigabytes to directory-entry metadata (tens of MB).

**Why hard-links, not a single shared symlinked `node_modules`?** A symlinked tree makes
workspace packages resolve to the _store's_ sources, not the branch's — the worktree's
edits would be ignored. Hard-links keep per-worktree trees while sharing file content.
The VPS volume is ext4 (no reflink), so hard-links are the tool.

## 2. Disk guardrails (`packages/server/src/utils/disk-space.ts`)

`createWorktree` calls `assertWorktreeDiskSpace` before `git worktree add`. Below the
free-space floor (`PASEO_WORKTREE_MIN_FREE_MB`, default 2 GiB) it throws the typed
`DiskFullError`; a mid-checkout `ENOSPC` from git is also translated to `DiskFullError`
(`isDiskFullErrorMessage`). It maps to the `disk_full` wire code, and the app shows the
localized `workspaceSetup.errors.hostDiskFull` ("Host disk is full …") instead of the raw
git error. `errorCode` is a free-form string on the wire, so no protocol change.

## 3. Post-deploy cleanup safety

`archiveByScope` / `archiveCommand` accept `requireCleanWorktree`. When set (by
post-deployment cleanup), `maybeRemoveDirectory` refuses to delete a worktree that still
has uncommitted changes (`worktreeHasUncommittedChanges`) and logs a warning, so a
crashed or forgotten change is never silently discarded. The default (force removal)
preserves the existing explicit user-initiated archive behaviour.

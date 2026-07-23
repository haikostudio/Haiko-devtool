#!/usr/bin/env node
// Share node_modules across worktrees instead of a full install per worktree.
//
// Every task worktree used to run a plain `npm ci`, materialising ~1.9 GB of
// node_modules each. On a small VPS a handful of ateliers saturate the disk and
// every `git worktree add` then fails with "unable to write file".
//
// This script keeps ONE canonical install per lockfile in a shared store that
// lives on the same filesystem as the worktrees, then hard-links each worktree's
// node_modules to it. Hard-links share the file *content* (0 extra bytes) while
// giving each worktree its own directory tree, so relative workspace symlinks
// (e.g. node_modules/@getpaseo/x -> ../packages/x) resolve to THIS worktree's
// sources — the branch's edits are honoured. Per-worktree footprint drops from
// gigabytes to directory-entry metadata (tens of MB at most).
//
// The store is keyed by a hash of package-lock.json: a branch that changes
// dependencies gets its own store entry and a real `npm ci`, so we never serve
// stale modules. Any failure falls back to a plain `npm ci` — correctness first.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const worktreeDir = process.cwd();
const COMPLETE_MARKER = ".complete";

function log(message) {
  process.stdout.write(`[setup-worktree-deps] ${message}\n`);
}

function runNpmCi() {
  const result = spawnSync("npm", ["ci"], { cwd: worktreeDir, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Hard-link clone `src` into `dest` (dest must not exist). `cp -al` preserves
// symlinks as symlinks (-a) and hard-links regular files (-l).
function cloneTree(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const result = spawnSync("cp", ["-al", src, dest], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`cp -al failed: ${src} -> ${dest}`);
  }
}

// Relative locations where npm may place a node_modules directory: the repo root
// plus every workspace package under packages/*.
function nodeModulesTargets() {
  const targets = ["node_modules"];
  const packagesDir = join(worktreeDir, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        targets.push(join("packages", entry.name, "node_modules"));
      }
    }
  }
  return targets;
}

function resolveStoreDir(lockHash) {
  const override = process.env.PASEO_WORKTREE_DEPS_STORE;
  // Default: a hidden sibling of the per-project worktree dir, guaranteeing the
  // store sits on the same filesystem (a hard-link requirement).
  const base = override ?? join(dirname(dirname(worktreeDir)), ".deps-store");
  return join(base, lockHash);
}

function main() {
  const lockfilePath = join(worktreeDir, "package-lock.json");
  if (!existsSync(lockfilePath)) {
    log("no package-lock.json; running plain npm ci");
    runNpmCi();
    return;
  }

  const lockHash = createHash("sha256")
    .update(readFileSync(lockfilePath))
    .digest("hex")
    .slice(0, 16);
  const storeDir = resolveStoreDir(lockHash);

  // Fast path: a complete store already exists for this lockfile — clone it.
  if (existsSync(join(storeDir, COMPLETE_MARKER))) {
    try {
      for (const target of nodeModulesTargets()) {
        const src = join(storeDir, target);
        if (existsSync(src)) {
          cloneTree(src, join(worktreeDir, target));
        }
      }
      log(`linked node_modules from shared store (${lockHash})`);
      return;
    } catch (error) {
      log(`shared store clone failed (${error.message}); falling back to npm ci`);
      for (const target of nodeModulesTargets()) {
        rmSync(join(worktreeDir, target), { recursive: true, force: true });
      }
      runNpmCi();
      return;
    }
  }

  // Slow path: first worktree on this lockfile. Do a real install, then seed the
  // shared store from it so later worktrees are cheap.
  runNpmCi();
  try {
    const tmpStore = `${storeDir}.partial-${process.pid}`;
    rmSync(tmpStore, { recursive: true, force: true });
    for (const target of nodeModulesTargets()) {
      const src = join(worktreeDir, target);
      if (existsSync(src)) {
        cloneTree(src, join(tmpStore, target));
      }
    }
    writeFileSync(join(tmpStore, COMPLETE_MARKER), lockHash);
    mkdirSync(dirname(storeDir), { recursive: true });
    if (existsSync(storeDir)) {
      // Another worktree won the race; keep theirs and drop ours.
      rmSync(tmpStore, { recursive: true, force: true });
    } else {
      renameSync(tmpStore, storeDir);
    }
    log(`seeded shared store (${lockHash})`);
  } catch (error) {
    // Seeding is an optimisation; the worktree already has a valid install.
    log(`could not seed shared store (${error.message}); continuing`);
  }
}

main();

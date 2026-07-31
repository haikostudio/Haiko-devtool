import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ARCHIVE_EMPTY_MESSAGE,
  ARCHIVE_OUTSIDE_PROJECT_MESSAGE,
  ARCHIVE_TOO_LARGE_MESSAGE,
  DownloadArchiveStore,
} from "./archive-store.js";

const logger = pino({ level: "silent" });

describe("DownloadArchiveStore", () => {
  let paseoHome: string;
  let projectRoot: string;

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), "paseo-archive-"));
    paseoHome = path.join(base, "home");
    projectRoot = path.join(base, "project");
    await mkdir(paseoHome, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(path.dirname(paseoHome), { recursive: true, force: true });
  });

  test("zips selected files with project-relative entry names", async () => {
    await mkdir(path.join(projectRoot, "cal"), { recursive: true });
    await writeFile(path.join(projectRoot, "cal", "a.txt"), "alpha");
    await writeFile(path.join(projectRoot, "cal", "b.txt"), "beta");

    const store = new DownloadArchiveStore({ paseoHome, logger });
    const created = await store.createArchive({ projectRoot, paths: ["cal"] });

    expect(created.fileName).toBe("cal.zip");
    const resolved = await store.resolveArchive(created.archiveId);
    expect(resolved).not.toBeNull();
    const zip = await JSZip.loadAsync(await readFile(resolved!.absolutePath));
    const fileEntries = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort();
    expect(fileEntries).toEqual(["cal/a.txt", "cal/b.txt"]);
    expect(await zip.file("cal/a.txt")!.async("string")).toBe("alpha");
  });

  test("uses a readable name derived from the request", async () => {
    await writeFile(path.join(projectRoot, "x.txt"), "x");
    const store = new DownloadArchiveStore({ paseoHome, logger });
    const created = await store.createArchive({
      projectRoot,
      paths: ["x.txt"],
      archiveName: "Étalonnage 2026",
    });
    expect(created.fileName).toBe("Étalonnage 2026.zip");
  });

  test("rejects paths outside the project", async () => {
    await writeFile(path.join(path.dirname(projectRoot), "secret.txt"), "nope");
    const store = new DownloadArchiveStore({ paseoHome, logger });
    await expect(store.createArchive({ projectRoot, paths: ["../secret.txt"] })).rejects.toThrow(
      ARCHIVE_OUTSIDE_PROJECT_MESSAGE,
    );
  });

  test("rejects a selection that resolves to no files", async () => {
    await mkdir(path.join(projectRoot, "empty"), { recursive: true });
    const store = new DownloadArchiveStore({ paseoHome, logger });
    await expect(store.createArchive({ projectRoot, paths: ["empty"] })).rejects.toThrow(
      ARCHIVE_EMPTY_MESSAGE,
    );
  });

  test("enforces the size cap", async () => {
    await writeFile(path.join(projectRoot, "big.bin"), Buffer.alloc(4096, 1));
    const store = new DownloadArchiveStore({ paseoHome, logger, maxBytes: 1024 });
    await expect(store.createArchive({ projectRoot, paths: ["big.bin"] })).rejects.toThrow(
      ARCHIVE_TOO_LARGE_MESSAGE,
    );
  });

  test("resolveArchive returns null and reaps once past the TTL", async () => {
    await writeFile(path.join(projectRoot, "x.txt"), "x");
    let clock = 1_000;
    const store = new DownloadArchiveStore({
      paseoHome,
      logger,
      ttlMs: 100,
      now: () => clock,
    });
    const created = await store.createArchive({ projectRoot, paths: ["x.txt"] });
    expect(await store.resolveArchive(created.archiveId)).not.toBeNull();

    clock += 200;
    expect(await store.resolveArchive(created.archiveId)).toBeNull();
    await expect(
      stat(path.join(paseoHome, "download-archives", created.archiveId)),
    ).rejects.toThrow();
  });

  test("sweepExpired removes only archives past the TTL", async () => {
    await writeFile(path.join(projectRoot, "x.txt"), "x");
    let clock = 1_000;
    const store = new DownloadArchiveStore({
      paseoHome,
      logger,
      ttlMs: 100,
      now: () => clock,
    });
    const old = await store.createArchive({ projectRoot, paths: ["x.txt"] });
    clock += 50;
    const fresh = await store.createArchive({ projectRoot, paths: ["x.txt"] });

    clock += 60; // old is now 110ms (expired), fresh is 60ms (alive)
    const removed = await store.sweepExpired();
    expect(removed).toBe(1);
    expect(await store.resolveArchive(old.archiveId)).toBeNull();
    expect(await store.resolveArchive(fresh.archiveId)).not.toBeNull();
  });
});

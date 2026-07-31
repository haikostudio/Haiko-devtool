import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { Logger } from "pino";

/**
 * Temporary zip archives built on demand by the conductor's `create_project_archive`
 * tool and offered to the user as a download button in the chat.
 *
 * Design mirrors the existing single-file download path (see
 * `file-download/token-store.ts` + `/api/files/download` in bootstrap.ts): the
 * archive lives on disk under the daemon home, and a fresh short-lived download
 * token is minted per click. The zip itself is kept for 24h, then swept — both on
 * a schedule (see `download-archive-cleaner.ts`) and once at daemon boot, so a
 * crash mid-run never leaves archives accumulating on disk.
 */

/** Thrown when a requested path escapes the project root. */
export const ARCHIVE_OUTSIDE_PROJECT_MESSAGE = "Archive paths must stay inside the project";
/** Thrown when the selected files exceed the size cap. */
export const ARCHIVE_TOO_LARGE_MESSAGE = "The requested files are too large to archive";
/** Thrown when the selection resolves to no files. */
export const ARCHIVE_EMPTY_MESSAGE = "No files matched the requested paths";

const DIRECTORY_NAME = "download-archives";
const META_FILE = "meta.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;
const ARCHIVE_MIME_TYPE = "application/zip";

interface ArchiveMeta {
  fileName: string;
  size: number;
  createdAt: number;
}

export interface CreateArchiveInput {
  /** Absolute path of the project the archive is scoped to. */
  projectRoot: string;
  /** Project-relative file/directory paths to include. */
  paths: string[];
  /** Optional human-readable base name for the archive (`.zip` is enforced). */
  archiveName?: string;
  /** Overrides the default uncompressed size cap. */
  maxBytes?: number;
}

export interface CreatedArchive {
  archiveId: string;
  fileName: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

export interface ResolvedArchive {
  archiveId: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}

interface CollectedFile {
  absolutePath: string;
  entryName: string;
  size: number;
}

interface DownloadArchiveStoreOptions {
  paseoHome: string;
  logger: Logger;
  ttlMs?: number;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => number;
}

export class DownloadArchiveStore {
  private readonly rootDir: string;
  private readonly logger: Logger;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => number;

  constructor(options: DownloadArchiveStoreOptions) {
    this.rootDir = path.join(options.paseoHome, DIRECTORY_NAME);
    this.logger = options.logger.child({ module: "download-archive-store" });
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.now = options.now ?? (() => Date.now());
  }

  async createArchive(input: CreateArchiveInput): Promise<CreatedArchive> {
    const projectRoot = await realpath(input.projectRoot);
    const maxBytes = input.maxBytes ?? this.maxBytes;

    const collected: CollectedFile[] = [];
    let totalBytes = 0;
    const seen = new Set<string>();

    for (const requested of input.paths) {
      const resolved = await this.resolveInsideProject(projectRoot, requested);
      const entries = await this.collectFiles(projectRoot, resolved);
      for (const entry of entries) {
        if (seen.has(entry.absolutePath)) {
          continue;
        }
        seen.add(entry.absolutePath);
        collected.push(entry);
        totalBytes += entry.size;
        if (collected.length > this.maxFiles || totalBytes > maxBytes) {
          throw new Error(ARCHIVE_TOO_LARGE_MESSAGE);
        }
      }
    }

    if (collected.length === 0) {
      throw new Error(ARCHIVE_EMPTY_MESSAGE);
    }

    const zip = new JSZip();
    for (const entry of collected) {
      zip.file(entry.entryName, await readFile(entry.absolutePath));
    }
    const content = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const createdAt = this.now();
    const archiveId = randomUUID();
    const fileName = this.resolveFileName(input.archiveName, input.paths, createdAt);
    const archiveDir = path.join(this.rootDir, archiveId);
    await mkdir(archiveDir, { recursive: true });
    await writeFile(path.join(archiveDir, fileName), content);
    const meta: ArchiveMeta = { fileName, size: content.byteLength, createdAt };
    await writeFile(path.join(archiveDir, META_FILE), JSON.stringify(meta), "utf8");

    return {
      archiveId,
      fileName,
      size: content.byteLength,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
  }

  async resolveArchive(archiveId: string): Promise<ResolvedArchive | null> {
    if (!/^[0-9a-f-]{36}$/i.test(archiveId)) {
      return null;
    }
    const archiveDir = path.join(this.rootDir, archiveId);
    const meta = await this.readMeta(archiveDir);
    if (!meta) {
      return null;
    }
    if (meta.createdAt + this.ttlMs <= this.now()) {
      await this.removeArchiveDir(archiveDir);
      return null;
    }
    return {
      archiveId,
      absolutePath: path.join(archiveDir, meta.fileName),
      fileName: meta.fileName,
      mimeType: ARCHIVE_MIME_TYPE,
      size: meta.size,
    };
  }

  /** Deletes every archive older than the TTL. Returns the count removed. */
  async sweepExpired(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }

    const now = this.now();
    let removed = 0;
    for (const entry of entries) {
      const archiveDir = path.join(this.rootDir, entry);
      const meta = await this.readMeta(archiveDir);
      // A directory with no readable meta is stale/partial — reap it too.
      const expired = !meta || meta.createdAt + this.ttlMs <= now;
      if (expired) {
        await this.removeArchiveDir(archiveDir);
        removed += 1;
      }
    }
    return removed;
  }

  private async resolveInsideProject(projectRoot: string, relativePath: string): Promise<string> {
    const cleaned = relativePath.trim().replace(/^[/\\]+/, "");
    const requested = path.resolve(projectRoot, cleaned);
    const relative = path.relative(projectRoot, requested);
    if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
      throw new Error(ARCHIVE_OUTSIDE_PROJECT_MESSAGE);
    }
    const real = await realpath(requested);
    const realRelative = path.relative(projectRoot, real);
    if (realRelative !== "" && (realRelative.startsWith("..") || path.isAbsolute(realRelative))) {
      throw new Error(ARCHIVE_OUTSIDE_PROJECT_MESSAGE);
    }
    return real;
  }

  private async collectFiles(projectRoot: string, absolutePath: string): Promise<CollectedFile[]> {
    const stats = await stat(absolutePath);
    if (stats.isFile()) {
      return [
        {
          absolutePath,
          entryName: this.toEntryName(projectRoot, absolutePath),
          size: stats.size,
        },
      ];
    }
    if (!stats.isDirectory()) {
      return [];
    }

    const files: CollectedFile[] = [];
    const dirEntries = await readdir(absolutePath, { withFileTypes: true });
    for (const dirEntry of dirEntries) {
      const childPath = path.join(absolutePath, dirEntry.name);
      // Re-scope through realpath so a symlink cannot walk us out of the project.
      let real: string;
      try {
        real = await this.resolveInsideProject(projectRoot, path.relative(projectRoot, childPath));
      } catch {
        continue;
      }
      files.push(...(await this.collectFiles(projectRoot, real)));
    }
    return files;
  }

  private toEntryName(projectRoot: string, absolutePath: string): string {
    return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
  }

  private resolveFileName(
    requestedName: string | undefined,
    requestedPaths: string[],
    createdAt: number,
  ): string {
    const cleaned = this.sanitizeBaseName(requestedName ?? "");
    if (cleaned) {
      return `${cleaned}.zip`;
    }
    // No explicit name: derive from the single requested path (file or folder).
    if (requestedPaths.length === 1) {
      const only = this.sanitizeBaseName(
        path.basename(requestedPaths[0].trim()).replace(/\.[^.]+$/, ""),
      );
      if (only) {
        return `${only}.zip`;
      }
    }
    return `archive-${createdAt}.zip`;
  }

  private sanitizeBaseName(value: string): string {
    return value
      .trim()
      .replace(/\.zip$/i, "")
      .replace(/[/\\]/g, "-")
      .replace(/[^\p{L}\p{N}._ -]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  }

  private async readMeta(archiveDir: string): Promise<ArchiveMeta | null> {
    try {
      const raw = await readFile(path.join(archiveDir, META_FILE), "utf8");
      const parsed = JSON.parse(raw) as Partial<ArchiveMeta>;
      if (
        typeof parsed.fileName === "string" &&
        typeof parsed.size === "number" &&
        typeof parsed.createdAt === "number"
      ) {
        return { fileName: parsed.fileName, size: parsed.size, createdAt: parsed.createdAt };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async removeArchiveDir(archiveDir: string): Promise<void> {
    try {
      await rm(archiveDir, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn({ err: error, archiveDir }, "Failed to remove download archive");
    }
  }
}

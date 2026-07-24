import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { AttachmentLibraryEntry } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import { z } from "zod";

import { writeFileAtomic, writeJsonFileAtomic } from "./atomic-file.js";

// Persisted record. Extends the wire entry with the internal on-disk location of
// the bytes (an upload file, or a materialized image blob) and a dedup key, so
// the same file re-sent many times is only listed once.
const StoredAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  addedAt: z.number(),
  kind: z.enum(["image", "file"]),
  agentId: z.string().optional(),
  agentTitle: z.string().optional(),
  /** Absolute path to the bytes on disk (upload path or blob), when we hold them. */
  diskPath: z.string().optional(),
  /** Stable key used to avoid listing the same attachment twice. */
  dedupKey: z.string(),
});
type StoredAttachment = z.infer<typeof StoredAttachmentSchema>;

const WorkspaceLibrarySchema = z.object({
  version: z.literal(1),
  /** True once the one-time historical-image backfill has run for this workspace. */
  backfilled: z.boolean(),
  entries: z.array(StoredAttachmentSchema),
});
type WorkspaceLibrary = z.infer<typeof WorkspaceLibrarySchema>;

function emptyLibrary(): WorkspaceLibrary {
  return { version: 1, backfilled: false, entries: [] };
}

/** A file (upload) or an image (raw base64 bytes) to record in the library. */
export type NewAttachmentInput =
  | {
      kind: "image";
      /** Base64 bytes, without the `data:` prefix. */
      data: string;
      mimeType: string;
      fileName?: string;
      agentId?: string;
      agentTitle?: string;
      addedAt?: number;
    }
  | {
      kind: "file";
      id: string;
      fileName: string;
      mimeType: string;
      size: number;
      path: string;
      agentId?: string;
      agentTitle?: string;
      addedAt?: number;
    };

// Workspace ids are daemon-generated, but sanitize anyway so a hostile id can
// never escape the store directory.
function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
  if (subtype === "jpeg") return "jpg";
  if (/^[a-z0-9]+$/.test(subtype)) return subtype;
  return "img";
}

function fallbackImageName(hash: string, mimeType: string): string {
  return `image-${hash.slice(0, 8)}.${imageExtension(mimeType)}`;
}

/**
 * Per-workspace library of files and images that have transited the chat of the
 * workspace's agents. One JSON index per workspace under
 * `$PASEO_HOME/attachment-library/{workspaceId}.json`, plus a `blobs/` folder
 * holding materialized image bytes (uploads keep living in `$PASEO_HOME/uploads`).
 *
 * The index is fed at send time (see Session), and lazily backfilled from agent
 * timelines the first time a workspace's library is listed. Writes are serialized
 * per workspace so concurrent turns can't clobber the file.
 */
export class AttachmentLibraryStore {
  private readonly dir: string;
  private readonly logger: Logger;
  // Per-workspace write chain: read-modify-write must not interleave.
  private readonly locks = new Map<string, Promise<void>>();

  constructor(dir: string, logger: Logger) {
    this.dir = dir;
    this.logger = logger.child({ module: "attachment-library-store" });
  }

  private indexPath(workspaceId: string): string {
    return join(this.dir, `${safeSegment(workspaceId)}.json`);
  }

  private blobDir(workspaceId: string): string {
    return join(this.dir, safeSegment(workspaceId), "blobs");
  }

  private async read(workspaceId: string): Promise<WorkspaceLibrary> {
    try {
      const raw = await fs.readFile(this.indexPath(workspaceId), "utf8");
      return WorkspaceLibrarySchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, workspaceId }, "Failed to read attachment library");
      }
      return emptyLibrary();
    }
  }

  private async write(workspaceId: string, library: WorkspaceLibrary): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await writeJsonFileAtomic(this.indexPath(workspaceId), library);
  }

  // Serialize a mutation against a workspace's index behind any in-flight one.
  private withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workspaceId) ?? Promise.resolve();
    const run = previous.then(() => fn());
    // Next caller waits on this one settling (success or failure), never rejects.
    this.locks.set(
      workspaceId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async materializeImage(
    workspaceId: string,
    id: string,
    data: string,
  ): Promise<string | undefined> {
    try {
      const dir = this.blobDir(workspaceId);
      await fs.mkdir(dir, { recursive: true });
      const blobPath = join(dir, id);
      await writeFileAtomic(blobPath, Buffer.from(data, "base64"));
      return blobPath;
    } catch (error) {
      this.logger.error({ err: error, workspaceId, id }, "Failed to write image blob");
      return undefined;
    }
  }

  /**
   * Add a batch of attachments to a workspace's library. Deduplicates against the
   * existing index (upload id for files, content hash for images) so re-sends and
   * the backfill can't create duplicates. Best-effort: never throws.
   */
  async add(workspaceId: string, inputs: NewAttachmentInput[]): Promise<void> {
    if (!workspaceId || inputs.length === 0) {
      return;
    }
    await this.withLock(workspaceId, async () => {
      const library = await this.read(workspaceId);
      const seen = new Set(library.entries.map((entry) => entry.dedupKey));
      let changed = false;
      for (const input of inputs) {
        const record = await this.toRecord(workspaceId, input, seen);
        if (!record) {
          continue;
        }
        seen.add(record.dedupKey);
        library.entries.push(record);
        changed = true;
      }
      if (changed) {
        await this.write(workspaceId, library);
      }
    }).catch((error) => {
      this.logger.error({ err: error, workspaceId }, "Failed to add attachments to library");
    });
  }

  private async toRecord(
    workspaceId: string,
    input: NewAttachmentInput,
    seen: Set<string>,
  ): Promise<StoredAttachment | null> {
    const addedAt = input.addedAt ?? Date.now();
    if (input.kind === "file") {
      const dedupKey = `file:${input.id}`;
      if (seen.has(dedupKey)) {
        return null;
      }
      return {
        id: input.id,
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: input.size,
        addedAt,
        kind: "file",
        agentId: input.agentId,
        agentTitle: input.agentTitle,
        diskPath: input.path,
        dedupKey,
      };
    }
    const hash = createHash("sha256").update(input.data, "base64").digest("hex");
    const dedupKey = `image:${hash.slice(0, 16)}`;
    if (seen.has(dedupKey)) {
      return null;
    }
    const id = `img_${hash.slice(0, 16)}`;
    const diskPath = await this.materializeImage(workspaceId, id, input.data);
    return {
      id,
      fileName: input.fileName?.trim() || fallbackImageName(hash, input.mimeType),
      mimeType: input.mimeType,
      size: Buffer.byteLength(input.data, "base64"),
      addedAt,
      kind: "image",
      agentId: input.agentId,
      agentTitle: input.agentTitle,
      diskPath,
      dedupKey,
    };
  }

  async isBackfilled(workspaceId: string): Promise<boolean> {
    const library = await this.read(workspaceId);
    return library.backfilled;
  }

  async markBackfilled(workspaceId: string): Promise<void> {
    await this.withLock(workspaceId, async () => {
      const library = await this.read(workspaceId);
      if (library.backfilled) {
        return;
      }
      library.backfilled = true;
      await this.write(workspaceId, library);
    }).catch((error) => {
      this.logger.error({ err: error, workspaceId }, "Failed to mark library backfilled");
    });
  }

  /**
   * Wire entries for a workspace, newest first. Entries whose bytes have
   * disappeared from disk (deleted uploads / cleared blobs) are dropped so the
   * drawer never lists a file that can no longer be opened.
   */
  async list(workspaceId: string): Promise<AttachmentLibraryEntry[]> {
    const library = await this.read(workspaceId);
    const entries: AttachmentLibraryEntry[] = [];
    for (const record of library.entries) {
      const hasPreview = record.diskPath ? await fileExists(record.diskPath) : false;
      if (record.diskPath && !hasPreview) {
        // Bytes are gone — skip so we don't offer a broken preview/download.
        continue;
      }
      entries.push({
        id: record.id,
        fileName: record.fileName,
        mimeType: record.mimeType,
        size: record.size,
        addedAt: record.addedAt,
        kind: record.kind,
        agentId: record.agentId,
        agentTitle: record.agentTitle,
        hasPreview,
      });
    }
    entries.sort((a, b) => b.addedAt - a.addedAt);
    return entries;
  }

  /** Resolve an entry's on-disk bytes for download/preview, or null if missing. */
  async resolve(
    workspaceId: string,
    entryId: string,
  ): Promise<{ absolutePath: string; fileName: string; mimeType: string; size: number } | null> {
    const library = await this.read(workspaceId);
    const record = library.entries.find((entry) => entry.id === entryId);
    if (!record?.diskPath || !(await fileExists(record.diskPath))) {
      return null;
    }
    return {
      absolutePath: record.diskPath,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.size,
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

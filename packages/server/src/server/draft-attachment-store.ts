import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "./atomic-file.js";

const DraftAttachmentRecordSchema = z.object({
  id: z.string(),
  mimeType: z.string(),
  fileName: z.string().nullable().optional(),
  dataBase64: z.string(),
});
export type DraftAttachmentRecord = z.infer<typeof DraftAttachmentRecordSchema>;

// Attachment ids are app-generated (`att_<hex>` / uuids), but sanitize anyway so
// a hostile id can never escape the store directory.
function safeFileName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
}

/**
 * Daemon-persisted bytes for draft image attachments, keyed by attachment id.
 * The device that pasted an image uploads its bytes here; other devices download
 * them to materialize the image locally. One JSON file per attachment under
 * `$PASEO_HOME/draft-attachments/`, base64-encoded (draft images are small).
 */
export class DraftAttachmentStore {
  private readonly dir: string;
  private readonly logger: Logger;
  private ensuredDir = false;

  constructor(dir: string, logger: Logger) {
    this.dir = dir;
    this.logger = logger.child({ module: "draft-attachment-store" });
  }

  async put(record: DraftAttachmentRecord): Promise<void> {
    const parsed = DraftAttachmentRecordSchema.parse(record);
    await this.ensureDir();
    await writeJsonFileAtomic(join(this.dir, safeFileName(parsed.id)), parsed);
  }

  async get(id: string): Promise<DraftAttachmentRecord | null> {
    try {
      const raw = await fs.readFile(join(this.dir, safeFileName(id)), "utf8");
      return DraftAttachmentRecordSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, id }, "Failed to read draft attachment");
      }
      return null;
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.ensuredDir) {
      return;
    }
    await fs.mkdir(this.dir, { recursive: true });
    this.ensuredDir = true;
  }
}

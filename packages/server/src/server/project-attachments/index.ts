import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonFileAtomic } from "../atomic-file.js";

// A per-project library of every file that has transited through an agent in
// that project (uploaded documents and pasted images). Persisted as one JSON
// file per project under `$PASEO_HOME/projects/attachments/{projectId}.json`.
//
// Records are append-only and deduplicated by `id`. Writes are serialized per
// project through an in-memory promise queue so concurrent sessions cannot lose
// entries during a read-modify-write.
export interface ProjectAttachmentRecord {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  addedAt: string;
  // "upload" for files uploaded via the composer, "image" for pasted/attached
  // images that were inlined into the prompt.
  source: string;
  // Best-effort link back to the conversation the file was sent from.
  agentId: string | null;
  agentTitle: string | null;
  workspaceId: string | null;
}

interface RecordInput {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  addedAt: string;
  source: string;
  agentId?: string | null;
  agentTitle?: string | null;
  workspaceId?: string | null;
}

export class ProjectAttachmentLibrary {
  private readonly paseoHome: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(paseoHome: string) {
    this.paseoHome = paseoHome;
  }

  private filePathForProject(projectId: string): string {
    const safeId = projectId.replace(/[^a-zA-Z0-9._-]/g, "_") || "project";
    return join(this.paseoHome, "projects", "attachments", `${safeId}.json`);
  }

  async list(projectId: string): Promise<ProjectAttachmentRecord[]> {
    const records = await this.read(projectId);
    // Most recent first so the library opens on the newest files.
    return records.slice().sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async record(projectId: string, input: RecordInput): Promise<void> {
    const next = this.writeQueue.then(
      () => this.appendRecord(projectId, input),
      () => this.appendRecord(projectId, input),
    );
    // Keep the queue alive even when a write rejects.
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async appendRecord(projectId: string, input: RecordInput): Promise<void> {
    const existing = await this.read(projectId);
    if (existing.some((entry) => entry.id === input.id)) {
      return;
    }
    const record: ProjectAttachmentRecord = {
      id: input.id,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
      addedAt: input.addedAt,
      source: input.source,
      agentId: input.agentId ?? null,
      agentTitle: input.agentTitle ?? null,
      workspaceId: input.workspaceId ?? null,
    };
    await writeJsonFileAtomic(this.filePathForProject(projectId), [...existing, record]);
  }

  private async read(projectId: string): Promise<ProjectAttachmentRecord[]> {
    try {
      const raw = await readFile(this.filePathForProject(projectId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isProjectAttachmentRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

function isProjectAttachmentRecord(value: unknown): value is ProjectAttachmentRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.fileName === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.addedAt === "string"
  );
}

// One instance per PASEO_HOME so all sessions share a single serialized writer.
const librariesByHome = new Map<string, ProjectAttachmentLibrary>();

export function getProjectAttachmentLibrary(paseoHome: string): ProjectAttachmentLibrary {
  let library = librariesByHome.get(paseoHome);
  if (!library) {
    library = new ProjectAttachmentLibrary(paseoHome);
    librariesByHome.set(paseoHome, library);
  }
  return library;
}

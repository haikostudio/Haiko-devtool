import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskBoardSchema, type TaskBoard } from "@getpaseo/protocol/tasks/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

export function generateTaskEntityId(): string {
  return randomBytes(4).toString("hex");
}

type BoardUpdater = (board: TaskBoard) => TaskBoard | Promise<TaskBoard>;

function emptyBoard(projectId: string): TaskBoard {
  return { version: 1, projectId, folders: [], tasks: [] };
}

function validateProjectId(projectId: string): string {
  const trimmed = projectId.trim();
  if (!trimmed) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
  return trimmed;
}

/**
 * Derive a filesystem-safe, collision-free file name from a project id.
 * Project ids are opaque logical keys — local ones are plain slugs, but remote
 * ones look like `remote:github.com/owner/repo`, full of `/` and `:` that must
 * never reach the path. base64url yields only `[A-Za-z0-9_-]`, so there is no
 * path separator or `..` to escape the tasks dir, and the mapping is a bijection
 * so two distinct project ids can never share a board file.
 */
function projectIdToFileName(projectId: string): string {
  return Buffer.from(validateProjectId(projectId), "utf-8").toString("base64url");
}

/**
 * Per-project kanban board persistence: one JSON file per project under
 * $PASEO_HOME/tasks/{projectId}.json, written atomically. Mutations are
 * serialized per project so a whole board move (column + order re-pack)
 * is one transactional write.
 */
export class TaskBoardStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private filePath(projectId: string): string {
    return join(this.dir, `${projectIdToFileName(projectId)}.json`);
  }

  async getBoard(projectId: string): Promise<TaskBoard> {
    try {
      const content = await readFile(this.filePath(projectId), "utf-8");
      return TaskBoardSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyBoard(projectId);
      }
      throw error;
    }
  }

  async mutate(projectId: string, updater: BoardUpdater): Promise<TaskBoard> {
    return this.serializeMutation(validateProjectId(projectId), async () => {
      const current = await this.getBoard(projectId);
      const next = TaskBoardSchema.parse(await updater(current));
      if (next.projectId !== current.projectId) {
        throw new Error(`Board mutation cannot change project id: ${projectId}`);
      }
      await mkdir(this.dir, { recursive: true });
      await writeJsonFileAtomic(this.filePath(projectId), next);
      return next;
    });
  }

  private async serializeMutation<T>(key: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(key, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(key) === next) {
        this.mutations.delete(key);
      }
    }
  }
}

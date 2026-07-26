import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "./atomic-file.js";
import type { PersistedProjectKind, PersistedWorkspaceKind } from "./workspace-registry-model.js";

const PersistedProjectRecordSchema = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.enum(["git", "non_git"]),
  displayName: z.string(),
  // User-set override layered over the derived displayName. Reconciliation
  // never touches this. Null means "use the derived name". Added for #987.
  customName: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

const PersistedWorkspaceRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  kind: z.enum(["local_checkout", "worktree", "directory"]),
  displayName: z.string(),
  // User-set title layered over the derived displayName. In Model B the title is
  // the workspace identity; branch/directory are backing metadata. Reconciliation
  // never touches this. Null means "use the derived displayName".
  title: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // The worktree's git branch. Decoupled from displayName/title by construction:
  // displayName holds the human name (title), branch holds the git branch. Only
  // worktree workspaces carry a branch; directory/local_checkout leave it null.
  branch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Restauré : racine exacte du checkout/worktree derrière cwd. Diffère de cwd
  // quand le projet sélectionné est un sous-dossier du dépôt. Persisté pour que
  // l'archivage et la récupération n'aient pas besoin que le dossier existe encore.
  worktreeRoot: z.string().nullable().default(null),
  // The base branch the worktree was created from (normalized like worktree.json's
  // baseRefName). Only worktree workspaces carry a base branch; checkout-branch
  // worktrees and directory/local_checkout workspaces leave it null.
  baseBranch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Restauré : vrai quand le worktree a été créé par Paseo (donc supprimable par
  // lui), et racine du dépôt principal auquel il se rattache.
  isPaseoOwnedWorktree: z.boolean().default(false),
  mainRepoRoot: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  pinnedAt: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // True once the user has renamed this workspace by hand. The per-turn auto-namer
  // (which re-derives the tab title from the agent's latest response) defers to it
  // and never clobbers a hand-picked title. Clearing the title (setting it back to
  // null via the title-set RPC) resets this so auto-naming resumes.
  titleLockedByUser: z
    .boolean()
    .optional()
    .transform((value) => value ?? false),
});

export type PersistedProjectRecord = z.infer<typeof PersistedProjectRecordSchema>;
export type PersistedWorkspaceRecord = z.infer<typeof PersistedWorkspaceRecordSchema>;

export interface ProjectRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedProjectRecord[]>;
  get(projectId: string): Promise<PersistedProjectRecord | null>;
  upsert(record: PersistedProjectRecord): Promise<void>;
  archive(projectId: string, archivedAt: string): Promise<void>;
  remove(projectId: string): Promise<void>;
}

export interface WorkspaceRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedWorkspaceRecord[]>;
  get(workspaceId: string): Promise<PersistedWorkspaceRecord | null>;
  update(
    workspaceId: string,
    updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord | null>;
  upsert(record: PersistedWorkspaceRecord): Promise<void>;
  archive(workspaceId: string, archivedAt: string): Promise<void>;
  remove(workspaceId: string): Promise<void>;
}

type RegistryRecord = PersistedProjectRecord | PersistedWorkspaceRecord;

class FileBackedRegistry<TRecord extends RegistryRecord> {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly schema: z.ZodType<TRecord, unknown>;
  private readonly getId: (record: TRecord) => string;
  private loaded = false;
  private readonly cache = new Map<string, TRecord>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    filePath: string;
    logger: Logger;
    schema: z.ZodType<TRecord, unknown>;
    getId: (record: TRecord) => string;
    component: string;
  }) {
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.getId = options.getId;
    this.logger = options.logger.child({
      module: "workspace-registry",
      component: options.component,
    });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async existsOnDisk(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<TRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(id: string): Promise<TRecord | null> {
    await this.load();
    return this.cache.get(id) ?? null;
  }

  async upsert(record: TRecord): Promise<void> {
    await this.load();
    const parsed = this.schema.parse(record);
    this.cache.set(this.getId(parsed), parsed);
    await this.enqueuePersist();
  }

  async update(id: string, updater: (record: TRecord) => TRecord): Promise<TRecord | null> {
    await this.load();
    const existing = this.cache.get(id);
    if (!existing) {
      return null;
    }
    const next = this.schema.parse(updater(existing));
    this.cache.set(id, next);
    await this.enqueuePersist();
    return next;
  }

  async archive(id: string, archivedAt: string): Promise<void> {
    await this.load();
    const existing = this.cache.get(id);
    if (!existing) {
      return;
    }
    const next = this.schema.parse({
      ...existing,
      updatedAt: archivedAt,
      archivedAt,
    });
    this.cache.set(id, next);
    await this.enqueuePersist();
  }

  async remove(id: string): Promise<void> {
    await this.load();
    if (!this.cache.delete(id)) {
      return;
    }
    await this.enqueuePersist();
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.cache.clear();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = z.array(this.schema).parse(JSON.parse(raw));
      for (const record of parsed) {
        this.cache.set(this.getId(record), record);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load registry file");
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const records = Array.from(this.cache.values());
    await writeJsonFileAtomic(this.filePath, records);
  }

  private async enqueuePersist(): Promise<void> {
    const nextPersist = this.persistQueue.then(() => this.persist());
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }
}

export class FileBackedProjectRegistry
  extends FileBackedRegistry<PersistedProjectRecord>
  implements ProjectRegistry
{
  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: PersistedProjectRecordSchema,
      getId: (record) => record.projectId,
      component: "projects",
    });
  }
}

const DIRECTORY_WORKSPACE_KINDS = new Set<PersistedWorkspaceKind>(["local_checkout", "directory"]);

export class FileBackedWorkspaceRegistry
  extends FileBackedRegistry<PersistedWorkspaceRecord>
  implements WorkspaceRegistry
{
  private readonly workspaceLogger: Logger;

  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: PersistedWorkspaceRecordSchema,
      getId: (record) => record.workspaceId,
      component: "workspaces",
    });
    this.workspaceLogger = logger.child({ module: "workspace-registry", component: "workspaces" });
  }

  // Hard invariant: at most ONE non-archived directory-backed workspace per cwd. Every
  // workspace persistence funnels through upsert(), so enforcing it here blocks duplicate
  // "phantom branch" rows regardless of which caller (agent create, import, provisioning,
  // bootstrap) tries to mint one — the earlier per-caller guards kept missing paths. Updates
  // to an existing record, archives, and deliberate worktrees are unaffected. The blocked
  // stack is logged so the leaking caller can be fixed at its source.
  override async upsert(record: PersistedWorkspaceRecord): Promise<void> {
    if (!record.archivedAt && DIRECTORY_WORKSPACE_KINDS.has(record.kind)) {
      const isNew = (await this.get(record.workspaceId)) === null;
      if (isNew) {
        const cwd = resolve(record.cwd);
        const existing = (await this.list()).find(
          (candidate) =>
            !candidate.archivedAt &&
            candidate.workspaceId !== record.workspaceId &&
            DIRECTORY_WORKSPACE_KINDS.has(candidate.kind) &&
            resolve(candidate.cwd) === cwd,
        );
        if (existing) {
          this.workspaceLogger.warn(
            {
              blockedWorkspaceId: record.workspaceId,
              existingWorkspaceId: existing.workspaceId,
              cwd: record.cwd,
              kind: record.kind,
              stack: new Error("duplicate-workspace-create").stack,
            },
            "Blocked duplicate workspace creation for directory (one-per-cwd invariant)",
          );
          return;
        }
      }
    }
    return super.upsert(record);
  }
}

export function createPersistedProjectRecord(input: {
  projectId: string;
  rootPath: string;
  kind: PersistedProjectKind;
  displayName: string;
  customName?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}): PersistedProjectRecord {
  return PersistedProjectRecordSchema.parse({
    ...input,
    customName: input.customName ?? null,
    archivedAt: input.archivedAt ?? null,
  });
}

export function resolveProjectDisplayName(record: PersistedProjectRecord): string {
  return record.customName ?? record.displayName;
}

export function createPersistedWorkspaceRecord(input: {
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: PersistedWorkspaceKind;
  displayName: string;
  title?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  pinnedAt?: string | null;
}): PersistedWorkspaceRecord {
  return PersistedWorkspaceRecordSchema.parse({
    ...input,
    title: input.title ?? null,
    branch: input.branch ?? null,
    baseBranch: input.baseBranch ?? null,
    archivedAt: input.archivedAt ?? null,
    pinnedAt: input.pinnedAt ?? null,
  });
}

// The single workspace-name rule: the title always wins; otherwise fall back to
// the freshest available derived display name (a live branch snapshot when the
// caller has one, the persisted displayName otherwise).
export function resolveWorkspaceName(input: {
  title: string | null;
  derivedDisplayName: string;
}): string {
  return input.title ?? input.derivedDisplayName;
}

export function resolveWorkspaceDisplayName(record: PersistedWorkspaceRecord): string {
  return resolveWorkspaceName({ title: record.title, derivedDisplayName: record.displayName });
}

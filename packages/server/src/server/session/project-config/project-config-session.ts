import { realpathSync } from "node:fs";
import { resolve, sep } from "path";
import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ProjectRegistry } from "../../workspace-registry.js";
import type { PersistedProjectRecord } from "../../workspace-registry.js";
import {
  readProjectPromptSyncStatus,
  type ProjectPromptSyncService,
} from "../../project-prompt-sync.js";
import {
  readPaseoConfigForEdit,
  writePaseoConfigForEdit,
  type ProjectConfigRpcError,
} from "../../../utils/paseo-config-file.js";

export interface ProjectConfigSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ProjectConfigSessionOptions {
  host: ProjectConfigSessionHost;
  projectRegistry: Pick<ProjectRegistry, "list">;
  projectPromptSync?: Pick<ProjectPromptSyncService, "syncNow">;
  paseoHome: string;
  logger: pino.Logger;
}

/**
 * A client's read/write surface for a project's on-disk paseo.json. Resolves the
 * request's repoRoot against the known (non-archived) project roots — accepting a
 * trailing slash or a symlink via realpath — then reads or writes the config
 * substrate and emits the matching response. Reaches no state beyond the injected
 * project registry and the outbound channel.
 */
export class ProjectConfigSession {
  private readonly host: ProjectConfigSessionHost;
  private readonly projectRegistry: Pick<ProjectRegistry, "list">;
  private readonly projectPromptSync: Pick<ProjectPromptSyncService, "syncNow"> | null;
  private readonly paseoHome: string;
  private readonly logger: pino.Logger;

  constructor(options: ProjectConfigSessionOptions) {
    this.host = options.host;
    this.projectRegistry = options.projectRegistry;
    this.projectPromptSync = options.projectPromptSync ?? null;
    this.paseoHome = options.paseoHome;
    this.logger = options.logger;
  }

  async handleReadProjectConfigRequest(
    msg: Extract<SessionInboundMessage, { type: "read_project_config_request" }>,
  ): Promise<void> {
    const project = await this.resolveKnownProject(msg.repoRoot);
    if (!project) {
      this.emitProjectConfigReadFailure(msg, { code: "project_not_found" });
      return;
    }
    const repoRoot = project.rootPath;

    const result = readPaseoConfigForEdit(repoRoot);
    if (!result.ok) {
      this.logger.warn(
        { repoRoot, requestId: msg.requestId, outcome: result.error.code },
        "Failed to read project config",
      );
      this.emitProjectConfigReadFailure(msg, result.error, repoRoot);
      return;
    }

    if (result.config === null) {
      this.logger.debug(
        { repoRoot, requestId: msg.requestId, outcome: "missing_project_config" },
        "Project config missing",
      );
    }

    this.host.emit({
      type: "read_project_config_response",
      payload: {
        requestId: msg.requestId,
        repoRoot,
        ok: true,
        config: result.config,
        revision: result.revision,
        projectPromptSync: readProjectPromptSyncStatus({
          paseoHome: this.paseoHome,
          project,
        }),
      },
    });
  }

  async handleWriteProjectConfigRequest(
    msg: Extract<SessionInboundMessage, { type: "write_project_config_request" }>,
  ): Promise<void> {
    const project = await this.resolveKnownProject(msg.repoRoot);
    if (!project) {
      this.emitProjectConfigWriteFailure(msg, { code: "project_not_found" });
      return;
    }
    const repoRoot = project.rootPath;

    this.logger.debug(
      { repoRoot, requestId: msg.requestId, outcome: "write_attempt" },
      "Writing project config",
    );
    const result = writePaseoConfigForEdit({
      repoRoot,
      config: msg.config,
      expectedRevision: msg.expectedRevision,
    });
    if (!result.ok) {
      this.logger.debug(
        { repoRoot, requestId: msg.requestId, outcome: result.error.code },
        "Project config write did not complete",
      );
      this.emitProjectConfigWriteFailure(msg, result.error, repoRoot);
      return;
    }

    this.logger.debug(
      { repoRoot, requestId: msg.requestId, outcome: "written" },
      "Project config written",
    );
    this.host.emit({
      type: "write_project_config_response",
      payload: {
        requestId: msg.requestId,
        repoRoot,
        ok: true,
        config: result.config,
        revision: result.revision,
        projectPromptSync: readProjectPromptSyncStatus({
          paseoHome: this.paseoHome,
          project,
        }),
      },
    });
  }

  async handleProjectPromptSyncRefreshRequest(
    msg: Extract<SessionInboundMessage, { type: "project.promptSync.refresh.request" }>,
  ): Promise<void> {
    const project = await this.resolveKnownProject(msg.repoRoot);
    if (!project) {
      this.emitProjectPromptSyncRefreshFailure(msg, "project_not_found");
      return;
    }
    if (!this.projectPromptSync) {
      this.emitProjectPromptSyncRefreshFailure(msg, "sync_failed", project.rootPath);
      return;
    }
    try {
      const projectPromptSync = await this.projectPromptSync.syncNow(project);
      this.host.emit({
        type: "project.promptSync.refresh.response",
        payload: {
          requestId: msg.requestId,
          repoRoot: project.rootPath,
          ok: true,
          projectPromptSync,
        },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, projectId: project.projectId, repoRoot: project.rootPath },
        "Failed to refresh project prompt sync",
      );
      this.emitProjectPromptSyncRefreshFailure(msg, "sync_failed", project.rootPath);
    }
  }

  private emitProjectConfigReadFailure(
    msg: Extract<SessionInboundMessage, { type: "read_project_config_request" }>,
    error: ProjectConfigRpcError,
    repoRoot = msg.repoRoot,
  ): void {
    this.host.emit({
      type: "read_project_config_response",
      payload: {
        requestId: msg.requestId,
        repoRoot,
        ok: false,
        error,
      },
    });
  }

  private emitProjectConfigWriteFailure(
    msg: Extract<SessionInboundMessage, { type: "write_project_config_request" }>,
    error: ProjectConfigRpcError,
    repoRoot = msg.repoRoot,
  ): void {
    this.host.emit({
      type: "write_project_config_response",
      payload: {
        requestId: msg.requestId,
        repoRoot,
        ok: false,
        error,
      },
    });
  }

  private emitProjectPromptSyncRefreshFailure(
    msg: Extract<SessionInboundMessage, { type: "project.promptSync.refresh.request" }>,
    error: "project_not_found" | "sync_failed",
    repoRoot = msg.repoRoot,
  ): void {
    this.host.emit({
      type: "project.promptSync.refresh.response",
      payload: {
        requestId: msg.requestId,
        repoRoot,
        ok: false,
        error,
      },
    });
  }

  private async resolveKnownProject(repoRoot: string): Promise<PersistedProjectRecord | null> {
    const requestedRoot = canonicalizeConfigRoot(repoRoot);
    const projects = await this.projectRegistry.list();
    for (const project of projects) {
      if (project.archivedAt !== null) {
        continue;
      }
      const projectRoot = canonicalizeConfigRoot(project.rootPath);
      if (requestedRoot === projectRoot) {
        return { ...project, rootPath: projectRoot };
      }
    }
    return null;
  }
}

function canonicalizeConfigRoot(repoRoot: string): string {
  const resolved = resolve(repoRoot);
  try {
    return stripTrailingPathSeparators(realpathSync(resolved));
  } catch {
    return stripTrailingPathSeparators(resolved);
  }
}

function stripTrailingPathSeparators(path: string): string {
  let normalized = path;
  while (normalized.length > 1 && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Compatibility entry point for the workspace tab model.
 *
 * Several modules import the tab types from `@/stores/workspace-tabs-store`,
 * which is where they lived before the model moved to `@/workspace-tabs/model`
 * and the store to `@/stores/workspace-layout-store`. Re-exporting from here
 * keeps those imports resolving instead of scattering the rename across the
 * call sites — the model is the single source of truth either way.
 */
export {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceDraftTabSetup,
  type WorkspaceTab,
  type WorkspaceTabTarget,
} from "@/workspace-tabs/model";

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import {
  createProjectBranchSelectionStore,
  PROJECT_BRANCH_SELECTION_STORAGE_KEY,
  type ProjectBranchSelection,
  type ProjectBranchSelectionStorage,
} from "@/stores/project-branch-selection";

export type { ProjectBranchSelection } from "@/stores/project-branch-selection";

const projectBranchSelectionStorage: ProjectBranchSelectionStorage = {
  read: () => AsyncStorage.getItem(PROJECT_BRANCH_SELECTION_STORAGE_KEY),
  write: (value) => AsyncStorage.setItem(PROJECT_BRANCH_SELECTION_STORAGE_KEY, value),
};

const projectBranchSelectionStore = createProjectBranchSelectionStore(
  projectBranchSelectionStorage,
);

export function hydrateProjectBranchSelection(): Promise<void> {
  return projectBranchSelectionStore.hydrate();
}

export function rememberProjectBranch(selection: ProjectBranchSelection): void {
  projectBranchSelectionStore.remember(selection);
}

export function forgetProjectBranch(serverId: string, projectId: string): void {
  projectBranchSelectionStore.forget(serverId, projectId);
}

export function getRememberedProjectBranch(
  serverId: string | null,
  projectId: string | null,
): string | null {
  return projectBranchSelectionStore.getBranch(serverId, projectId);
}

/**
 * The branch this project was last viewing, or null if none was remembered.
 * Re-renders when the remembered branch for this (serverId, projectId) changes.
 */
export function useRememberedProjectBranch(
  serverId: string | null,
  projectId: string | null,
): string | null {
  return useSyncExternalStore(
    projectBranchSelectionStore.subscribe,
    () => projectBranchSelectionStore.getBranch(serverId, projectId),
    () => projectBranchSelectionStore.getBranch(serverId, projectId),
  );
}

void hydrateProjectBranchSelection();

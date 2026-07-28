import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { TaskProposalCards } from "@/components/tasks/task-proposal-carousel";
import type { KanbanTask, TaskBoard, TaskBoardHandle } from "@/data/tasks";

// Throwaway visual demo of the in-chat task proposal carousel with 4 tasks.
// Not wired to a real host: it builds a fake, interactive board handle.

const NOW = "2026-07-18T12:00:00.000Z";

function makeTask(overrides: Partial<KanbanTask> & Pick<KanbanTask, "id" | "title">): KanbanTask {
  return {
    folderId: "inbox",
    tags: [],
    column: "scheduled",
    order: 0,
    origin: "agent_sync",
    normalizedTitle: overrides.title.toLowerCase(),
    approval: { state: "pending", requestedBy: "triage" },
    links: { agentIds: [] },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const INITIAL_TASKS: KanbanTask[] = [
  makeTask({
    id: "t-1",
    title: "Corriger le flux de connexion",
    description: "Le redirect après login boucle sur /auth. Rétablir la redirection vers /home.",
    tags: ["auth", "bug"],
    estimate: {
      tokens: 240_000,
      quotaPercent: 12,
      confidence: "medium",
      model: "claude/haiku",
      estimatedAt: NOW,
      estimatedMinutes: 35,
    },
  }),
  makeTask({
    id: "t-2",
    title: "Ajouter le mode sombre",
    description: "Basculer les tokens de thème et persister la préférence.",
    tags: ["ui"],
  }),
  makeTask({
    id: "t-3",
    title: "Écrire les tests du panier",
    tags: ["tests"],
    estimate: {
      tokens: 150_000,
      quotaPercent: 8,
      confidence: "high",
      model: "claude/haiku",
      estimatedAt: NOW,
      estimatedMinutes: 20,
    },
  }),
  makeTask({
    id: "t-4",
    title: "Migrer la base vers Postgres 16",
    tags: ["infra"],
    estimate: {
      tokens: 520_000,
      quotaPercent: 34,
      confidence: "low",
      model: "claude/haiku",
      estimatedAt: NOW,
      estimatedMinutes: 90,
    },
  }),
];

const PROPOSALS = INITIAL_TASKS.map((task) => ({ taskId: task.id, title: task.title }));

const ENTRIES: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    label: "Claude Code",
    models: [
      {
        provider: "claude",
        id: "claude-opus-4-8",
        label: "Opus 4.8",
        isDefault: true,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "max", label: "Max" },
        ],
      },
    ],
  },
];

const FOLDERS = [{ id: "inbox", name: "Boîte de réception", order: 0, createdAt: NOW }];

function noop(): Promise<void> {
  return Promise.resolve();
}

export default function CarouselDemoScreen() {
  const [tasks, setTasks] = useState<KanbanTask[]>(INITIAL_TASKS);

  const board = useMemo<TaskBoard>(
    () => ({ version: 1, projectId: "demo", folders: FOLDERS, tasks }),
    [tasks],
  );

  const updateTask = useCallback<TaskBoardHandle["updateTask"]>(async (input) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === input.taskId
          ? {
              ...task,
              title: input.title ?? task.title,
              description:
                input.description === null ? undefined : (input.description ?? task.description),
            }
          : task,
      ),
    );
  }, []);

  const approveTask = useCallback<TaskBoardHandle["approveTask"]>(async (taskId) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, approval: { state: "approved", approvedAt: NOW } } : task,
      ),
    );
  }, []);

  const deleteTask = useCallback<TaskBoardHandle["deleteTask"]>(async (taskId) => {
    setTasks((current) => current.filter((task) => task.id !== taskId));
  }, []);

  const handle = useMemo<TaskBoardHandle>(
    () => ({
      board,
      isLoading: false,
      error: null,
      createTask: noop,
      updateTask,
      moveTask: noop,
      markTaskViewed: noop,
      deleteTask,
      estimateTask: noop,
      runTaskNow: noop,
      approveTask,
      // The demo board never runs the real final check.
      retryTaskAnalysis: async () => {},
      validateTask: async () => ({ passed: false, task: null }),
      deployTask: async () => ({ dispatched: false, task: null }),
      archiveTask: noop,
    }),
    [board, updateTask, deleteTask, approveTask],
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Démo — carousel de tâches proposées (4)</Text>
      <View style={styles.chatColumn}>
        <TaskProposalCards board={handle} entries={ENTRIES} proposals={PROPOSALS} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  chatColumn: {
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
}));

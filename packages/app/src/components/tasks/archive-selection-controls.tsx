import { memo } from "react";
import { View } from "react-native";
import { Archive } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { TaskColumn } from "@/data/tasks";
import type { ArchiveSelectionColumnProps } from "./archive-selection";

/**
 * The bottom-of-column bulk-archive control, twin of the "Tout déployer" button
 * pinned at the head. At rest it is a single "Tout archiver" button; pressing it
 * turns the column into selection mode and the bar becomes a "Annuler" +
 * "Archiver la sélection (N)" pair. Confirming files the checked cards into
 * "Archivé" — a plain move, never a publication.
 *
 * Rendered only on the "À déployer" column, and (when idle) only while it holds
 * at least one card: an archive control over an empty queue has nothing to do.
 */
export const ArchiveSelectionControls = memo(function ArchiveSelectionControls({
  column,
  taskCount,
  selection,
}: {
  column: TaskColumn;
  taskCount: number;
  selection: ArchiveSelectionColumnProps | undefined;
}) {
  const { t } = useTranslation();
  if (column !== "deployed" || !selection) {
    return null;
  }
  if (!selection.active) {
    if (taskCount === 0) {
      return null;
    }
    return (
      <View style={styles.bar}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={Archive}
          onPress={selection.onStart}
          style={styles.fill}
          testID="tasks-archive-all"
        >
          {t("tasks.board.archiveAll")}
        </Button>
      </View>
    );
  }
  return (
    <View style={styles.bar}>
      <Button variant="ghost" size="sm" onPress={selection.onCancel} testID="tasks-archive-cancel">
        {t("tasks.board.archiveSelectionCancel")}
      </Button>
      <Button
        variant="default"
        size="sm"
        leftIcon={Archive}
        disabled={selection.selectedCount === 0}
        onPress={selection.onConfirm}
        style={styles.fill}
        testID="tasks-archive-confirm"
      >
        {t("tasks.board.archiveSelectionConfirm", { count: selection.selectedCount })}
      </Button>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  fill: {
    flex: 1,
  },
}));

import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { GripVertical } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { SortableInlineList } from "@/components/sortable-inline-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import type { Theme } from "@/styles/theme";
import { useComposerInsert, useDraftBullets } from "./insert-text-context";
import { findMovedBulletIndices } from "./insert-draft-text";

const ThemedGrip = withUnistyles(GripVertical);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/**
 * The chosen proposals, listed above the message field and draggable into the
 * order the user wants to ask for them.
 *
 * The strip reads the draft's bullets rather than keeping a list of its own, so
 * it shows exactly what the message holds — including bullets typed by hand.
 * Hidden below two bullets, where there is nothing to reorder.
 *
 * Dragging is web-only today: `SortableInlineList` has no native drag
 * implementation. On iOS/Android the strip still lists the points, in order.
 */
export function BulletReorderStrip() {
  const composerInsert = useComposerInsert();
  const bullets = useDraftBullets();
  const { t } = useTranslation();

  const handleDragEnd = useCallback(
    (next: string[]) => {
      const move = findMovedBulletIndices(bullets, next);
      if (move) {
        composerInsert?.reorderBullets(move.from, move.to);
      }
    },
    [bullets, composerInsert],
  );

  const keyExtractor = useCallback((bullet: string, index: number) => `${index}:${bullet}`, []);

  const renderItem = useCallback(
    ({ item }: DraggableRenderItemInfo<string>) => (
      <View style={styles.row}>
        <ThemedGrip size={13} uniProps={mutedColorMapping} />
        <Text style={styles.label} numberOfLines={1}>
          {item}
        </Text>
      </View>
    ),
    [],
  );

  if (!composerInsert || bullets.length < 2) {
    return null;
  }

  return (
    <View
      style={styles.strip}
      accessibilityLabel={t("tasks.panel.evolutionReorder")}
      testID="composer-bullet-strip"
    >
      <SortableInlineList
        data={bullets}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onDragEnd={handleDragEnd}
        axis="vertical"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  strip: {
    paddingBottom: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  label: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
  },
}));

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

// Accent palette for folder cards — mirrors the Paseo project-color range.
export const FOLDER_COLORS = [
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#ef4444", // red
] as const;

interface FolderCreateModalProps {
  visible: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; color: string }) => void;
}

/**
 * "New folder" dialog: a name plus an accent color picked from a fixed
 * palette. The created folder appears as a card in the folders rail via the
 * board subscription push.
 */
export function FolderCreateModal({ visible, onClose, onCreate }: FolderCreateModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(FOLDER_COLORS[0]);

  useEffect(() => {
    if (visible) {
      setName("");
      setColor(FOLDER_COLORS[0]);
    }
  }, [visible]);

  const handleCreate = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    onCreate({ name: trimmed, color });
    onClose();
  }, [name, color, onCreate, onClose]);

  const header = useMemo((): SheetHeader => ({ title: t("tasks.folderModal.title") }), [t]);

  const footer = useMemo(
    () => (
      <View style={styles.footerRow}>
        <View style={styles.footerSpacer} />
        <Button variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button onPress={handleCreate} testID="tasks-folder-modal-create">
          {t("tasks.folderModal.create")}
        </Button>
      </View>
    ),
    [onClose, handleCreate, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      desktopMaxWidth={420}
      testID="tasks-folder-modal"
    >
      <View style={styles.content}>
        <Text style={styles.fieldLabel}>{t("tasks.folderModal.nameField")}</Text>
        <AdaptiveTextInput
          value={name}
          onChangeText={setName}
          placeholder={t("tasks.newFolderPlaceholder")}
          onSubmitEditing={handleCreate}
          autoFocus
          testID="tasks-folder-modal-name"
        />
        <Text style={styles.fieldLabel}>{t("tasks.folderModal.colorField")}</Text>
        <View style={styles.swatchRow}>
          {FOLDER_COLORS.map((swatch) => (
            <ColorSwatch
              key={swatch}
              color={swatch}
              selected={swatch === color}
              onSelect={setColor}
            />
          ))}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const ColorSwatch = memo(function ColorSwatch({
  color,
  selected,
  onSelect,
}: {
  color: string;
  selected: boolean;
  onSelect: (color: string) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(color);
  }, [onSelect, color]);
  const swatchStyle = useMemo(
    () => [styles.swatch, { backgroundColor: color }, selected && styles.swatchSelected],
    [color, selected],
  );
  return (
    <Pressable
      onPress={handlePress}
      style={swatchStyle}
      accessibilityRole="button"
      accessibilityLabel={color}
      testID={`tasks-folder-color-${color.slice(1)}`}
    >
      {selected ? <Check size={14} color="#ffffff" /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[2],
  },
  swatchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  swatchSelected: {
    borderColor: theme.colors.foreground,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footerSpacer: {
    flex: 1,
  },
}));

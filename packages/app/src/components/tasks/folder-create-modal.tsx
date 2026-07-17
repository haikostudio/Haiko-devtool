import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";

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
  const isCompact = useIsCompactFormFactor();
  const controlSize = isCompact ? "md" : "sm";
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(FOLDER_COLORS[0]);
  // The name input is native-owned (see AdaptiveTextInput); bump the reset key
  // on every open so the field remounts empty instead of replaying old text.
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (visible) {
      setName("");
      setColor(FOLDER_COLORS[0]);
      setResetKey((key) => key + 1);
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
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          onPress={handleCreate}
          testID="tasks-folder-modal-create"
        >
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
      <Field label={t("tasks.folderModal.nameField")}>
        <FormTextInput
          size={controlSize}
          resetKey={resetKey}
          onChangeText={setName}
          placeholder={t("tasks.newFolderPlaceholder")}
          onSubmitEditing={handleCreate}
          // Desktop only: autofocusing inside the compact bottom sheet pops the
          // keyboard at mount and keyboardBehavior="extend" desyncs the sheet
          // from its footer on mobile web.
          autoFocus={!isCompact}
          testID="tasks-folder-modal-name"
        />
      </Field>
      <Field label={t("tasks.folderModal.colorField")}>
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
      </Field>
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
  swatchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
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
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
}));

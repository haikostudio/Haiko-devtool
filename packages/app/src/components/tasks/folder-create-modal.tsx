import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
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
  onCreate: (input: {
    name: string;
    color: string;
    requireValidation?: boolean;
    branch?: string;
  }) => void;
  /**
   * When provided the dialog opens in edit mode: fields prefill from this
   * folder, the title/submit labels switch, and onCreate carries the edits.
   */
  initialFolder?: { name: string; color?: string; requireValidation?: boolean; branch?: string };
  // The launch-policy toggle is shown only when the daemon supports it.
  showLaunchPolicy?: boolean;
}

/**
 * "New folder" / "Edit folder" dialog: a name plus an accent color picked from
 * a fixed palette. The created or edited folder appears as a card in the
 * folders rail via the board subscription push.
 */
export function FolderCreateModal({
  visible,
  onClose,
  onCreate,
  initialFolder,
  showLaunchPolicy,
}: FolderCreateModalProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const controlSize = isCompact ? "md" : "sm";
  const isEditing = initialFolder !== undefined;
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [color, setColor] = useState<string>(FOLDER_COLORS[0]);
  // Immediate start is the default; the user opts into holding tasks for review.
  const [requireValidation, setRequireValidation] = useState(false);
  // The name input is native-owned (see AdaptiveTextInput); bump the reset key
  // on every open so the field remounts empty instead of replaying old text.
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (visible) {
      setName(initialFolder?.name ?? "");
      setBranch(initialFolder?.branch ?? "");
      setColor(initialFolder?.color ?? FOLDER_COLORS[0]);
      setRequireValidation(initialFolder?.requireValidation ?? false);
      setResetKey((key) => key + 1);
    }
  }, [visible, initialFolder]);

  const handleCreate = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const trimmedBranch = branch.trim();
    onCreate({
      name: trimmed,
      color,
      ...(showLaunchPolicy ? { requireValidation } : {}),
      ...(trimmedBranch ? { branch: trimmedBranch } : {}),
    });
    onClose();
  }, [name, branch, color, requireValidation, showLaunchPolicy, onCreate, onClose]);

  const header = useMemo(
    (): SheetHeader => ({
      title: isEditing ? t("tasks.folderModal.editTitle") : t("tasks.folderModal.title"),
    }),
    [isEditing, t],
  );

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
          {isEditing ? t("tasks.folderModal.save") : t("tasks.folderModal.create")}
        </Button>
      </View>
    ),
    [onClose, handleCreate, isEditing, t],
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
          // Native-owned input: seed the current folder name so the field
          // remounts pre-filled when editing (empty when creating).
          initialValue={initialFolder?.name ?? ""}
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
      <Field label={t("tasks.folderModal.branchField")} hint={t("tasks.folderModal.branchHint")}>
        <FormTextInput
          size={controlSize}
          resetKey={resetKey}
          initialValue={initialFolder?.branch ?? ""}
          onChangeText={setBranch}
          placeholder={t("tasks.folderModal.branchPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          testID="tasks-folder-modal-branch"
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
      {showLaunchPolicy ? (
        <Field label={t("tasks.folderModal.requireValidationField")}>
          <View style={styles.autopilotRow}>
            <Text style={styles.autopilotHint}>{t("tasks.folderModal.requireValidationHint")}</Text>
            <Switch
              value={requireValidation}
              onValueChange={setRequireValidation}
              accessibilityLabel={t("tasks.folderModal.requireValidationField")}
              testID="tasks-folder-modal-require-validation"
            />
          </View>
        </Field>
      ) : null}
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
  autopilotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  autopilotHint: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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

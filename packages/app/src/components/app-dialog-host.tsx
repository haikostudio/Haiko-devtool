import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useAppDialogStore, type AppDialogAction } from "@/stores/app-dialog-store";

/**
 * Renders the queued app dialogs (alerts and confirmations) with the app's own
 * chrome. Mounted once at the root; every `alertDialog()` / `confirmDialog()`
 * call surfaces here instead of in a native OS alert.
 */
export function AppDialogHost() {
  const current = useAppDialogStore((state) => state.current);
  const resolve = useAppDialogStore((state) => state.resolve);

  const key = current?.key ?? null;
  const dismissActionId = current?.dismissActionId ?? null;

  const handleDismiss = useCallback(() => {
    if (!key) return;
    resolve(key, dismissActionId);
  }, [key, dismissActionId, resolve]);

  const header = useMemo<SheetHeader>(() => ({ title: current?.title ?? "" }), [current?.title]);

  return (
    <AdaptiveModalSheet
      visible={current !== null}
      onClose={handleDismiss}
      header={header}
      scrollable={false}
      dynamicSizing
      desktopMaxWidth={440}
      testID="app-dialog"
    >
      <View style={styles.body}>
        {current?.message ? (
          <Text style={styles.message} testID="app-dialog-message">
            {current.message}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {(current?.actions ?? []).map((action) => (
            <DialogActionButton key={action.id} action={action} dialogKey={key} />
          ))}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function DialogActionButton({
  action,
  dialogKey,
}: {
  action: AppDialogAction;
  dialogKey: string | null;
}) {
  const resolve = useAppDialogStore((state) => state.resolve);
  const handlePress = useCallback(() => {
    if (!dialogKey) return;
    resolve(dialogKey, action.id);
  }, [dialogKey, action.id, resolve]);

  return (
    <Button
      variant={action.variant ?? "default"}
      size="sm"
      style={styles.actionButton}
      testID={`app-dialog-action-${action.id}`}
      onPress={handlePress}
    >
      {action.label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));

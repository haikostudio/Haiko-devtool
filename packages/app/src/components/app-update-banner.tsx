import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { useAppUpdateAvailable } from "@/hooks/use-app-update";
import { SPACING } from "@/styles/theme";

/**
 * Web-only "new version available — reload" banner.
 *
 * Pinned to the top of the screen (below the status-bar safe area) when a newer
 * build has been deployed. Native never renders it — mobile updates come from
 * the app stores. See `useAppUpdateAvailable` for detection.
 */
export function AppUpdateBanner() {
  const updateAvailable = useAppUpdateAvailable();
  const [dismissed, setDismissed] = useState(false);
  const insets = useSafeAreaInsets();

  const handleReload = useCallback(() => {
    // Force a fresh load, defeating iOS PWA heuristic caching with a cache-buster.
    if (isWeb && typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.set("v", Date.now().toString());
      window.location.replace(u.toString());
    }
  }, []);

  const handleDismiss = useCallback(() => setDismissed(true), []);

  const containerStyle = useMemo(
    () => [styles.container, { paddingTop: insets.top + SPACING[2] }],
    [insets.top],
  );

  if (!updateAvailable || dismissed) return null;

  return (
    <View pointerEvents="box-none" style={containerStyle}>
      <View style={styles.banner}>
        <Text style={styles.label} numberOfLines={1}>
          Nouvelle version disponible
        </Text>
        <View style={styles.actions}>
          <Button variant="default" size="sm" onPress={handleReload} accessibilityLabel="Recharger">
            Recharger
          </Button>
          <Pressable
            onPress={handleDismiss}
            accessibilityRole="button"
            accessibilityLabel="Masquer"
            hitSlop={8}
            style={styles.dismissButton}
          >
            <Text style={styles.dismissText}>✕</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    zIndex: 1000,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    maxWidth: 520,
    width: "100%",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  label: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dismissButton: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
  },
  dismissText: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
}));

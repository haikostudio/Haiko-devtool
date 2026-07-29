import { memo } from "react";
import { View } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

const checkedForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const ThemedCheck = withUnistyles(Check);

/**
 * A small presentational checkbox: a rounded square that fills accent and shows a
 * check when `checked`. It owns no press behaviour of its own — the row or card
 * that hosts it captures the tap and toggles the value — so it stays a pure,
 * theme-aware glyph that reads in both light and dark.
 */
export const Checkbox = memo(function Checkbox({ checked }: { checked: boolean }) {
  return (
    <View style={[styles.box, checked && styles.boxChecked]}>
      {checked ? (
        <ThemedCheck size={12} strokeWidth={3} uniProps={checkedForegroundMapping} />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  box: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1.5,
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
}));

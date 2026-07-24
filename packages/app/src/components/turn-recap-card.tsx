import { memo, useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import {
  Sparkles,
  FilePlus2,
  FilePenLine,
  FileMinus2,
  ChevronRight,
  GitCompareArrows,
} from "lucide-react-native";
import type { ComponentType } from "react";
import { StyleSheet } from "react-native-unistyles";
import type { TurnRecapItem, TurnRecapFileOperation } from "@/types/stream";

const RECAP_ACCENT = "#818cf8";

/** Per-operation accent + icon. Hard-coded so it reads on every theme. */
const OPERATION_META: Record<
  TurnRecapFileOperation,
  { color: string; icon: ComponentType<{ size?: number; color?: string }> }
> = {
  created: { color: "#34d399", icon: FilePlus2 },
  edited: { color: "#f59e0b", icon: FilePenLine },
  deleted: { color: "#f87171", icon: FileMinus2 },
};

interface TurnRecapCardProps {
  item: TurnRecapItem;
  /** Open a single changed file (path as reported by the daemon). */
  onOpenFile: (path: string) => void;
  /** Open the workspace "changes" view. Omitted when unavailable. */
  onOpenChanges?: () => void;
}

/** Split a (possibly absolute) path into a workspace-relative name + dir. */
function formatFilePath(path: string, cwd?: string): { name: string; dir: string } {
  let relative = path;
  if (cwd && path.startsWith(cwd)) {
    relative = path.slice(cwd.length).replace(/^[/\\]+/, "");
  }
  const segments = relative.split(/[/\\]/).filter((segment) => segment.length > 0);
  const name = segments.pop() ?? relative;
  return { name, dir: segments.join("/") };
}

const recapStylesheet = StyleSheet.create((theme) => ({
  card: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  headerText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.3,
    color: RECAP_ACCENT,
  },
  body: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  summary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  highlights: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  highlightRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  highlightBullet: {
    color: RECAP_ACCENT,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  highlightText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  filesLabel: {
    marginTop: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  fileRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  fileTextContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[1],
    minWidth: 0,
  },
  fileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  fileDir: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  viewAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  viewAllButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  viewAllText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));

// Precomputed hover-style arrays (module scope) so the render path never builds
// a new array inline — keeps react-perf lint happy while staying theme-reactive.
const FILE_ROW_HOVERED_STYLE = [recapStylesheet.fileRow, recapStylesheet.fileRowHovered];
const VIEW_ALL_HOVERED_STYLE = [
  recapStylesheet.viewAllButton,
  recapStylesheet.viewAllButtonHovered,
];

interface TurnRecapFileRowProps {
  path: string;
  operation: TurnRecapFileOperation;
  cwd?: string;
  onOpenFile: (path: string) => void;
}

const TurnRecapFileRow = memo(function TurnRecapFileRow({
  path,
  operation,
  cwd,
  onOpenFile,
}: TurnRecapFileRowProps) {
  const meta = OPERATION_META[operation];
  const OperationIcon = meta.icon;
  const { name, dir } = formatFilePath(path, cwd);
  const handlePress = useCallback(() => onOpenFile(path), [onOpenFile, path]);
  return (
    <Pressable onPress={handlePress}>
      {({ hovered }) => (
        <View style={hovered ? FILE_ROW_HOVERED_STYLE : recapStylesheet.fileRow}>
          <OperationIcon size={15} color={meta.color} />
          <View style={recapStylesheet.fileTextContainer}>
            <Text style={recapStylesheet.fileName} numberOfLines={1}>
              {name}
            </Text>
            {dir ? (
              <Text style={recapStylesheet.fileDir} numberOfLines={1}>
                {dir}
              </Text>
            ) : null}
          </View>
          <ChevronRight size={14} color="#71717a" />
        </View>
      )}
    </Pressable>
  );
});

/**
 * Renders the daemon's end-of-turn recap: a plain-language summary of what the
 * agent accomplished plus the list of changed files, each tappable to open its
 * diff. Turns a wall of technical tool output into a scannable block a
 * non-technical reader can rely on. See docs and the server generator.
 */
export const TurnRecapCard = memo(function TurnRecapCard({
  item,
  onOpenFile,
  onOpenChanges,
}: TurnRecapCardProps) {
  const { t } = useTranslation();
  return (
    <View style={recapStylesheet.card}>
      <View style={recapStylesheet.header}>
        <Sparkles size={16} color={RECAP_ACCENT} />
        <Text style={recapStylesheet.headerText}>{t("turnRecap.title")}</Text>
      </View>
      <View style={recapStylesheet.body}>
        <Text style={recapStylesheet.summary} selectable>
          {item.summary}
        </Text>
        {item.highlights.length > 0 ? (
          <View style={recapStylesheet.highlights}>
            {item.highlights.map((highlight) => (
              <View key={`${item.id}:h:${highlight}`} style={recapStylesheet.highlightRow}>
                <Text style={recapStylesheet.highlightBullet}>•</Text>
                <Text style={recapStylesheet.highlightText} selectable>
                  {highlight}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {item.files.length > 0 ? (
          <>
            <Text style={recapStylesheet.filesLabel}>{t("turnRecap.filesChanged")}</Text>
            {item.files.map((file) => (
              <TurnRecapFileRow
                key={`${item.id}:f:${file.path}`}
                path={file.path}
                operation={file.operation}
                cwd={item.cwd}
                onOpenFile={onOpenFile}
              />
            ))}
          </>
        ) : null}
      </View>
      {onOpenChanges ? (
        <Pressable onPress={onOpenChanges} accessibilityRole="button">
          {({ hovered }) => (
            <View style={hovered ? VIEW_ALL_HOVERED_STYLE : recapStylesheet.viewAllButton}>
              <GitCompareArrows size={15} color="#71717a" />
              <Text style={recapStylesheet.viewAllText}>{t("turnRecap.viewAllChanges")}</Text>
            </View>
          )}
        </Pressable>
      ) : null}
    </View>
  );
});

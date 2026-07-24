import { useMemo, useState } from "react";
import { FlatList, type ListRenderItem, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { GitCommitHorizontal, Tag } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  type ChangelogCommit,
  CHANGELOG_COMMITS,
  CHANGELOG_RELEASES,
} from "@/generated/changelog-data";
import type { Theme } from "@/styles/theme";

type ChangelogTab = "releases" | "commits";

function formatDay(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

export function ChangelogScreen() {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <ChangelogScreenContent />;
}

function ChangelogScreenContent() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ChangelogTab>("releases");

  const tabOptions = useMemo<SegmentedControlOption<ChangelogTab>[]>(
    () => [
      {
        value: "releases",
        label: t("changelog.tabs.releases"),
        icon: ({ color, size }) => <Tag color={color} size={size} />,
        testID: "changelog-tab-releases",
      },
      {
        value: "commits",
        label: t("changelog.tabs.commits"),
        icon: ({ color, size }) => <GitCommitHorizontal color={color} size={size} />,
        testID: "changelog-tab-commits",
      },
    ],
    [t],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("changelog.title")} />
      <View style={styles.tabsRow}>
        <SegmentedControl
          options={tabOptions}
          value={tab}
          onValueChange={setTab}
          testID="changelog-tabs"
        />
      </View>
      {tab === "releases" ? <ReleasesTab /> : <CommitsTab />}
    </View>
  );
}

function ReleasesTab() {
  const { t } = useTranslation();

  if (CHANGELOG_RELEASES.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{t("changelog.empty.releases")}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.releasesContent} showsVerticalScrollIndicator={false}>
      {CHANGELOG_RELEASES.map((release) => (
        <View key={release.version} style={styles.release}>
          <Text style={styles.releaseDate}>{formatDay(release.date)}</Text>
          <Text style={styles.releaseTitle}>
            {release.version === "Unreleased"
              ? t("changelog.unreleased")
              : `Paseo ${release.version}`}
          </Text>
          <MarkdownRenderer text={release.markdown} />
        </View>
      ))}
    </ScrollView>
  );
}

function CommitRow({ commit }: { commit: ChangelogCommit }) {
  return (
    <View style={styles.commitRow}>
      <View style={styles.commitHeader}>
        <Text style={styles.commitHash}>{commit.shortHash}</Text>
        <Text style={styles.commitDate}>{formatTimestamp(commit.date)}</Text>
      </View>
      <Text style={styles.commitSubject}>{commit.subject}</Text>
      <Text style={styles.commitAuthor}>{commit.author}</Text>
    </View>
  );
}

const renderCommit: ListRenderItem<ChangelogCommit> = ({ item }) => <CommitRow commit={item} />;
const commitKey = (item: ChangelogCommit) => item.hash;

function CommitsTab() {
  const { t } = useTranslation();

  if (CHANGELOG_COMMITS.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>{t("changelog.empty.commits")}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={CHANGELOG_COMMITS}
      renderItem={renderCommit}
      keyExtractor={commitKey}
      contentContainerStyle={styles.commitsContent}
      showsVerticalScrollIndicator={false}
    />
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  tabsRow: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
  },
  releasesContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[8],
    gap: theme.spacing[6],
  },
  release: {
    gap: theme.spacing[1],
  },
  releaseDate: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  releaseTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[1],
  },
  commitsContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[8],
  },
  commitRow: {
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  commitHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  commitHash: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  commitDate: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  commitSubject: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  commitAuthor: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

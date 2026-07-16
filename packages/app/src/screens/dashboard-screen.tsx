import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AgentList } from "@/components/agent-list";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import type { Theme } from "@/styles/theme";
import { buildOpenProjectRoute } from "@/utils/host-routes";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const loadingSpinnerColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function DashboardScreen() {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <DashboardScreenContent />;
}

function DashboardScreenContent() {
  const { t } = useTranslation();
  const { agents, isInitialLoad, isRevalidating, refreshAll } = useAggregatedAgents();

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  // refreshAll() is fire-and-forget, so clear the pull-to-refresh spinner once
  // the runtime finishes revalidating (mirrors the sidebar's manual-refresh gate).
  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const handleBack = useCallback(() => {
    router.navigate(buildOpenProjectRoute());
  }, []);

  return (
    <View style={styles.container}>
      <MenuHeader title={t("dashboard.title")} />
      {isInitialLoad ? (
        <View style={styles.loadingContainer}>
          <ThemedLoadingSpinner size="large" uniProps={loadingSpinnerColorMapping} />
        </View>
      ) : null}
      {!isInitialLoad && agents.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>{t("dashboard.empty")}</Text>
          <Button variant="ghost" leftIcon={ChevronLeft} onPress={handleBack}>
            {t("common.actions.back")}
          </Button>
        </View>
      ) : null}
      {!isInitialLoad && agents.length > 0 ? (
        <AgentList
          agents={agents}
          groupBy="status"
          showCheckoutInfo={false}
          isRefreshing={isManualRefresh}
          onRefresh={handleRefresh}
          showAttentionIndicator
          showHostColumn
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[6],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
}));

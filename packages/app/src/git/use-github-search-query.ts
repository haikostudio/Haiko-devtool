import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  ForgeSearchItem,
  GitHubSearchRequest,
  GitHubSearchResponse,
} from "@getpaseo/protocol/messages";
import { GitHubSearchItemSchema } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";

export const GITHUB_SEARCH_STALE_TIME = 30_000;

export type GitHubSearchPayload = GitHubSearchResponse["payload"];

/**
 * What callers actually consume: results in the forge shape, whatever the host
 * answered with. A GitHub "pr" and a GitLab "merge request" are the same thing —
 * a change request — so the whole UI speaks that one vocabulary and stops
 * branching on which forge replied.
 */
export interface ForgeSearchResults {
  items: ForgeSearchItem[];
  featuresEnabled: boolean;
  error: string | null;
}

function toForgeSearchItems(payload: GitHubSearchPayload): ForgeSearchResults {
  // The wire types `items` loosely (hosts of different ages answer with slightly
  // different shapes), so each entry is validated here and anything unparseable
  // is dropped rather than crashing the picker.
  const items: ForgeSearchItem[] = [];
  for (const entry of payload.items) {
    const parsed = GitHubSearchItemSchema.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    const item = parsed.data;
    items.push({
      ...item,
      kind: item.kind === "pr" ? "change_request" : "issue",
    });
  }
  return {
    items,
    featuresEnabled: payload.githubFeaturesEnabled ?? payload.featuresEnabled ?? false,
    error: payload.error,
  };
}

export interface GitHubSearchClient {
  searchGitHub: (
    options: {
      cwd: string;
      query: string;
      limit?: number;
      kinds?: GitHubSearchRequest["kinds"];
    },
    requestId?: string,
  ) => Promise<GitHubSearchPayload>;
}

interface GitHubSearchQueryInput {
  client: GitHubSearchClient | null;
  serverId: string;
  cwd: string;
  query: string;
  kinds?: GitHubSearchRequest["kinds"];
  enabled: boolean;
  hostDisconnectedMessage?: string;
}

export function githubSearchQueryKey(
  serverId: string,
  cwd: string,
  query: string,
  kinds?: GitHubSearchRequest["kinds"],
) {
  const trimmedQuery = query.trim();
  if (!kinds) {
    return ["github-search", serverId, cwd, trimmedQuery] as const;
  }
  return ["github-search", serverId, cwd, trimmedQuery, [...kinds].sort().join(",")] as const;
}

export function buildGithubSearchQueryOptions(input: GitHubSearchQueryInput) {
  const query = input.query.trim();

  return {
    queryKey: githubSearchQueryKey(input.serverId, input.cwd, query, input.kinds),
    queryFn: async (): Promise<ForgeSearchResults> => {
      if (!input.client) {
        throw new Error(
          input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"),
        );
      }
      const request = { cwd: input.cwd, query, limit: 20 };
      const payload = input.kinds
        ? await input.client.searchGitHub({ ...request, kinds: input.kinds })
        : await input.client.searchGitHub(request);
      return toForgeSearchItems(payload);
    },
    enabled: input.enabled && Boolean(input.client),
    staleTime: GITHUB_SEARCH_STALE_TIME,
  };
}

export function useGithubSearchQuery(input: GitHubSearchQueryInput) {
  const { t } = useTranslation();
  return useQuery(
    buildGithubSearchQueryOptions({
      ...input,
      hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
    }),
  );
}

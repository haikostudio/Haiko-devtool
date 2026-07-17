import type {
  AgentTimelineItem,
  TurnRecapFileChange,
  TurnRecapFileOperation,
} from "@getpaseo/protocol/agent-types";

/**
 * Derive the list of files a turn changed, straight from its tool calls — no
 * model involved, so the "modifications" list is exact. Only completed
 * `edit`/`write` calls count; failed/canceled calls never touched the file.
 *
 * Classification, deduped by path in first-seen order:
 * - an `edit` marks the file "edited" (it already existed);
 * - a `write` marks it "created", unless the same file was also edited in the
 *   turn, in which case "edited" wins (a write never downgrades an edit).
 *
 * Deletions are intentionally not inferred here: they would require parsing
 * shell commands, which misfires (`npm rm`, `rm` inside a heredoc, …). Better a
 * missing delete than a wrong label. The `"deleted"` operation stays in the
 * protocol for a future, reliable source.
 */
export function extractTurnFileChanges(items: readonly AgentTimelineItem[]): TurnRecapFileChange[] {
  const operations = new Map<string, TurnRecapFileOperation>();
  const order: string[] = [];

  const note = (rawPath: string, operation: TurnRecapFileOperation): void => {
    const path = rawPath.trim();
    if (!path) {
      return;
    }
    if (!operations.has(path)) {
      order.push(path);
    }
    const current = operations.get(path);
    if (operation === "edited") {
      operations.set(path, "edited");
    } else if (current === undefined) {
      operations.set(path, operation);
    }
  };

  for (const item of items) {
    if (item.type !== "tool_call" || item.status !== "completed") {
      continue;
    }
    const { detail } = item;
    if (detail.type === "edit") {
      note(detail.filePath, "edited");
    } else if (detail.type === "write") {
      note(detail.filePath, "created");
    }
  }

  return order.map((path) => ({ path, operation: operations.get(path) ?? "edited" }));
}

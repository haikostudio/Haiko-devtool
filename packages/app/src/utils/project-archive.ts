import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

/**
 * A downloadable archive produced by the conductor's `create_project_archive`
 * tool. Parsed from the tool call's own output — deterministic and provider
 * independent, so the chat download button never depends on the model echoing
 * anything back in its prose.
 */
export interface ProjectArchiveDescriptor {
  archiveId: string;
  fileName: string;
  size: number;
}

const ARCHIVE_KIND = "project_archive";

/**
 * Extracts the archive descriptor from a completed `create_project_archive` tool
 * call, or null when the call is something else. Tolerant of the ways a tool
 * result reaches the client (raw JSON string, MCP content blocks, or a plain
 * object), since only the shape of the payload — not its wrapping — is stable.
 */
export function parseProjectArchiveToolCall(
  toolName: string,
  detail: ToolCallDetail | undefined,
): ProjectArchiveDescriptor | null {
  if (!toolName.endsWith("create_project_archive")) {
    return null;
  }
  if (!detail || detail.type !== "unknown") {
    return null;
  }
  const record = extractRecord(detail.output);
  if (!record || record.kind !== ARCHIVE_KIND) {
    return null;
  }
  const { archiveId, fileName, size } = record;
  if (typeof archiveId !== "string" || archiveId.length === 0) {
    return null;
  }
  if (typeof fileName !== "string" || fileName.length === 0) {
    return null;
  }
  return { archiveId, fileName, size: typeof size === "number" ? size : 0 };
}

function extractRecord(output: unknown): Record<string, unknown> | null {
  if (output == null) {
    return null;
  }
  if (typeof output === "string") {
    return parseJsonObject(output);
  }
  if (Array.isArray(output)) {
    // MCP content blocks: [{ type: "text", text: "{...}" }, ...]
    for (const block of output) {
      if (
        block &&
        typeof block === "object" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        const parsed = parseJsonObject((block as { text: string }).text);
        if (parsed) {
          return parsed;
        }
      }
    }
    return null;
  }
  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (record.kind === ARCHIVE_KIND) {
      return record;
    }
    // Some adapters wrap the payload under `content`/`structuredContent`.
    if (record.structuredContent && typeof record.structuredContent === "object") {
      return record.structuredContent as Record<string, unknown>;
    }
    if (Array.isArray(record.content)) {
      return extractRecord(record.content);
    }
    return null;
  }
  return null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

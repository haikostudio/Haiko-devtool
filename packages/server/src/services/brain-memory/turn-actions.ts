import type { AgentTimelineItem } from "../../server/agent/agent-sdk-types.js";

/**
 * Distill the DURABLE actions an agent took during a turn into a compact summary
 * the scribe can remember. The Cerveau otherwise only sees what was *said* (the
 * final assistant text), never what was *done* — so a turn that shipped a
 * feature ("commit + push + deploy") but answered "voilà, c'est en ligne" left
 * no durable trace. We surface only high-signal, outcome-marking shell commands
 * (commits, pushes, releases, deploys) — bare file edits are visible in the code
 * and would just be noise, so they are deliberately ignored.
 */

const MAX_ACTIONS = 12;
const MAX_SUMMARY_CHARS = 1_200;
const MAX_COMMAND_CHARS = 160;

// Outcome-marking commands: shipping (commit/push/merge/tag), releasing
// (npm publish/release, eas build, expo export) and deploying (systemctl,
// docker up/build, caddy, pm2, deploy scripts). Word-boundary anchored so
// "gitignore" or "released_at" don't false-positive.
const DURABLE_SHELL =
  /\b(git\s+(commit|push|merge|tag|revert)|npm\s+(run\s+)?(deploy|release)|npm\s+publish|yarn\s+(deploy|release)|pnpm\s+(deploy|release)|systemctl\s+(restart|start|reload)|docker(\s+compose)?\s+(up|build|push)|caddy|pm2\s+(restart|reload|start)|eas\s+build|expo\s+export|(^|[\s/])deploy(\.sh|\b))/i;

/** Pull the message out of a `git commit -m "…"` / `-m '…'` invocation. */
function extractCommitMessage(command: string): string | null {
  const match = command.match(/-m\s+"([^"]+)"|-m\s+'([^']+)'/);
  const message = match?.[1] ?? match?.[2] ?? null;
  return message ? message.trim() : null;
}

function firstLine(command: string): string {
  const line = command.split("\n", 1)[0]?.trim() ?? "";
  return line.length > MAX_COMMAND_CHARS ? `${line.slice(0, MAX_COMMAND_CHARS)}…` : line;
}

/**
 * Compact bullet summary of the durable actions in a turn's timeline slice, or
 * null when nothing notable happened. Callers pass ONLY the items appended
 * during the turn (the caller snapshots the timeline length before dispatch).
 */
export function summarizeTurnActions(items: AgentTimelineItem[]): string | null {
  const commits: string[] = [];
  const commands: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.type !== "tool_call") {
      continue;
    }
    const detail = item.detail;
    if (!detail || detail.type !== "shell") {
      continue;
    }
    const command = (detail.command ?? "").trim();
    if (!command || !DURABLE_SHELL.test(command)) {
      continue;
    }
    const message = extractCommitMessage(command);
    if (message) {
      if (!seen.has(message)) {
        seen.add(message);
        commits.push(`- commit : « ${message} »`);
      }
      continue;
    }
    const line = firstLine(command);
    if (line && !seen.has(line)) {
      seen.add(line);
      commands.push(`- ${line}`);
    }
  }
  const lines = [...commits, ...commands].slice(0, MAX_ACTIONS);
  if (lines.length === 0) {
    return null;
  }
  return lines.join("\n").slice(0, MAX_SUMMARY_CHARS);
}

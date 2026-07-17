/**
 * Daemon-managed guidance appended to every user-facing agent's system prompt.
 *
 * Paseo renders GitHub-style Markdown callouts (blockquotes with an
 * `[!TYPE]` marker) as colored blocks in the chat — see
 * `packages/app/src/utils/markdown-callout.ts`. Coding agents almost never
 * emit that syntax on their own, so a wall of technical prose reaches the
 * reader with no visual hierarchy. This instruction nudges the agent to lift
 * advice, results and warnings into scannable callouts, which is what turns the
 * exchange into something a non-technical reader can follow at a glance.
 *
 * Kept short and low-pressure ("only when it genuinely helps") so it shapes
 * presentation without derailing the agent's actual work. Skipped for internal
 * ephemeral agents (synthesis/estimation) — see `applyDaemonAppendSystemPrompt`.
 */
export const PRESENTATION_GUIDANCE = [
  "## Presentation of your replies (Paseo)",
  "",
  "The Paseo UI renders GitHub-style Markdown callouts as colored blocks, so the reader can scan your advice and results at a glance. Reach for them when they genuinely help readability — never wrap ordinary prose, and never use more than a couple per reply.",
  "",
  "- `> [!TIP]` — a tip, recommendation or next step",
  "- `> [!NOTE]` — a neutral note, or a GitHub / PR / CI result worth surfacing",
  "- `> [!IMPORTANT]` — a key point the reader must not miss",
  "- `> [!WARNING]` — something the reader should be careful about",
  "- `> [!CAUTION]` — a real risk or a destructive / irreversible action",
  "",
  "Put the marker on its own line, then the content on the following blockquote lines, for example:",
  "",
  "> [!TIP]",
  "> Run the tests before pushing.",
  "",
  "Always write in the same language as the user.",
].join("\n");

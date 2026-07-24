#!/usr/bin/env node
// Generates src/generated/changelog-data.ts from the repo's CHANGELOG.md and
// `git log`. Runs at build time (see the app's build:web script) so the static
// web bundle ships a snapshot of "everything we've shipped". The app is a pure
// client — it can't read the repo at runtime — so we bake the data in here.
//
// Deterministic on purpose: no wall-clock timestamp (that would churn the
// committed file on every run). The "as of" marker is the newest commit date.
//
// Regenerate manually with: npm run generate:changelog --workspace=@getpaseo/app

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UNRELEASED_FR } from "./changelog-unreleased-fr.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// packages/app/scripts -> repo root
const repoRoot = resolve(scriptDir, "..", "..", "..");
const changelogPath = join(repoRoot, "CHANGELOG.md");
const outputPath = join(scriptDir, "..", "src", "generated", "changelog-data.ts");

const MAX_COMMITS = 300;
const RELEASE_HEADING = /^## (.+?) - (\d{4}-\d{2}-\d{2})$/;

/** Parse CHANGELOG.md release sections (mirrors packages/website changelog route). */
function parseReleases(markdown) {
  const releases = [];
  let current = null;
  for (const line of markdown.split("\n")) {
    const heading = line.match(RELEASE_HEADING);
    if (heading) {
      if (current) releases.push(current);
      current = { version: heading[1], date: heading[2], markdown: "" };
      continue;
    }
    if (current) current.markdown += `${line}\n`;
  }
  if (current) releases.push(current);
  for (const release of releases) {
    release.markdown = release.markdown.trim();
  }
  return releases;
}

// Conventional-commit type -> changelog section. Types not listed here (chore,
// docs, test, build, ci, style, ...) are treated as noise and left out of the
// synthesized "Unreleased" section. Section headings are in French to match the
// released sections (CHANGELOG.md), which are authored in French.
const TYPE_SECTIONS = new Map([
  ["feat", "Ajouts"],
  ["fix", "Corrections"],
  ["perf", "Améliorations"],
  ["refactor", "Améliorations"],
]);
const SECTION_ORDER = ["Ajouts", "Améliorations", "Corrections"];
const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/;

/**
 * Build an "Unreleased" release from commits newer than the newest dated
 * release, grouped by conventional-commit type. Returns null when there is
 * nothing to show. This is what makes the Releases tab reflect work-in-progress
 * automatically on every build — no manual CHANGELOG.md edit required.
 */
function synthesizeUnreleased(releases, commits) {
  const since = releases[0]?.date ?? null;
  const buckets = new Map(SECTION_ORDER.map((section) => [section, []]));
  for (const commit of commits) {
    // Compare on the date part only; commits on/before the last release day are
    // considered released. This over-includes same-day post-release commits at
    // worst, which is acceptable for a "what's next" preview.
    if (since && commit.date.slice(0, 10) <= since) continue;
    const match = commit.subject.match(CONVENTIONAL);
    const section = match && TYPE_SECTIONS.get(match[1].toLowerCase());
    if (!section) continue;
    const message = match[2].trim();
    const bullet = message.charAt(0).toUpperCase() + message.slice(1);
    // Translate the English commit-derived bullet to French via a one-time
    // backfill map. Bullets with no entry pass through unchanged, so future
    // French commit subjects render as-is. See changelog-unreleased-fr.mjs.
    buckets.get(section).push(UNRELEASED_FR[bullet] ?? bullet);
  }
  const parts = [];
  for (const section of SECTION_ORDER) {
    const items = buckets.get(section);
    if (items.length === 0) continue;
    parts.push(`### ${section}\n\n${items.map((item) => `- ${item}`).join("\n")}`);
  }
  if (parts.length === 0) return null;
  return {
    version: "Unreleased",
    date: commits[0].date.slice(0, 10),
    markdown: parts.join("\n\n"),
  };
}

/** Read recent commits via git. Tolerates missing git / shallow clones by returning []. */
function readCommits() {
  const SEP = "\x1f";
  const format = ["%H", "%h", "%aI", "%an", "%s"].join(SEP);
  let raw;
  try {
    // --all walks every branch/ref, not just the checked-out HEAD, so the
    // changelog reflects work on ANY branch the moment it's committed — no need
    // to be on (or merge into) a specific branch first. --date-order keeps the
    // newest commits first regardless of which branch they came from. Each
    // commit appears once even when reachable from multiple refs.
    raw = execFileSync(
      "git",
      [
        "log",
        "--all",
        "--date-order",
        `-n${MAX_COMMITS}`,
        "--no-merges",
        `--pretty=format:${format}`,
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (error) {
    console.warn(`[generate-changelog-data] git log unavailable: ${error.message}`);
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, shortHash, date, author, subject] = line.split(SEP);
      return { hash, shortHash, date, author, subject };
    });
}

const releases = existsSync(changelogPath)
  ? parseReleases(readFileSync(changelogPath, "utf8"))
  : [];
const commits = readCommits();
const unreleased = synthesizeUnreleased(releases, commits);
if (unreleased) releases.unshift(unreleased);
const generatedAt = commits[0]?.date ?? releases[0]?.date ?? null;

const banner =
  "// AUTO-GENERATED by packages/app/scripts/generate-changelog-data.mjs — do not edit by hand.\n" +
  "// Refreshed on every build:web; run `npm run generate:changelog --workspace=@getpaseo/app` to update.\n";

const contents = `${banner}
export interface ChangelogRelease {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  markdown: string;
}

export interface ChangelogCommit {
  hash: string;
  shortHash: string;
  /** ISO 8601 author date */
  date: string;
  author: string;
  subject: string;
}

export const CHANGELOG_RELEASES: ChangelogRelease[] = ${JSON.stringify(releases, null, 2)};

export const CHANGELOG_COMMITS: ChangelogCommit[] = ${JSON.stringify(commits, null, 2)};

/** Newest known change date (ISO), or null when nothing is available. */
export const CHANGELOG_GENERATED_AT: string | null = ${JSON.stringify(generatedAt)};
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, contents);
console.log(
  `[generate-changelog-data] wrote ${releases.length} releases, ${commits.length} commits -> ${outputPath}`,
);

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Public address of a project's dev instance on this host.
 *
 * Personal self-host fork feature, like `paseo-deploy.ts`: every project added
 * to the VPS runs as an `autoproject-<slug>` systemd unit whose launcher script
 * `cd`s into the project's checkout, and is exposed by a Caddy vhost file whose
 * first line is the hostname. Walking those two directories is what lets a
 * finished card link straight to the site it just deployed, instead of asking
 * the user to remember which subdomain belongs to which project.
 *
 * Everything here is best-effort: a missing directory, an unreadable file or a
 * project with no dev instance simply yields `null`, never an error.
 */
const RUN_DIR = "/var/lib/project-autostart/run";
const VHOST_DIR = "/etc/caddy/project-autostart.d";
/** Paseo's own web UI is published by the local build script, not autoproject. */
const PASEO_APP_URL = "https://app.haikostudio.cloud";

/** Cached slug → project directory map; the VPS layout changes very rarely. */
let cachedSlugDirs: Map<string, string> | null = null;

export function resetProjectDevInstanceCache(): void {
  cachedSlugDirs = null;
}

/** The URL Paseo's own PWA is published at (used when a Paseo card ships). */
export function getPaseoAppUrl(): string {
  return PASEO_APP_URL;
}

async function readSlugDirs(): Promise<Map<string, string>> {
  if (cachedSlugDirs) {
    return cachedSlugDirs;
  }
  const map = new Map<string, string>();
  try {
    const slugs = await readdir(RUN_DIR);
    for (const slug of slugs) {
      try {
        const script = await readFile(join(RUN_DIR, slug, "start.sh"), "utf8");
        const dir = parseStartScriptDir(script);
        if (dir) {
          map.set(slug, dir);
        }
      } catch {
        // No launcher for this slug — skip it.
      }
    }
  } catch {
    // No autoproject layout on this host at all.
  }
  cachedSlugDirs = map;
  return map;
}

/** First `cd '<dir>'` of a launcher script — where the dev server actually runs. */
export function parseStartScriptDir(script: string): string | null {
  for (const line of script.split("\n")) {
    const match = /^\s*cd\s+'([^']+)'/.exec(line) ?? /^\s*cd\s+"([^"$]+)"/.exec(line);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

/** Hostname declared by a Caddy vhost file (`example.com {` on the first line). */
export function parseVhostHost(contents: string): string | null {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const host = trimmed.split(/[\s{,]/)[0];
    return host && host.includes(".") ? host : null;
  }
  return null;
}

/** A project's dev instance on this host: its systemd slug and public address. */
export interface ProjectDevInstanceTarget {
  /** The `autoproject-<slug>` systemd unit and Caddy vhost key. */
  slug: string;
  /** `https://…` address the vhost serves, or null when unreadable. */
  url: string | null;
}

/** The slug whose launcher `cd`s into this checkout (or contains it). */
async function matchSlug(rootPath: string): Promise<string | null> {
  const slugDirs = await readSlugDirs();
  let matchedSlug: string | null = null;
  for (const [slug, dir] of slugDirs) {
    // Exact match first; otherwise the deepest containing directory wins, so
    // `/root/eloya-saas/web` doesn't get claimed by a shorter unrelated prefix.
    if (dir === rootPath) {
      return slug;
    }
    if (dir.startsWith(`${rootPath}/`)) {
      matchedSlug = slug;
    }
  }
  return matchedSlug;
}

/**
 * The project's dev instance — its `autoproject-<slug>` unit and served URL — or
 * null when the project has no instance on this host. This is what the central
 * publisher needs: the service to restart and the address to probe. A worktree
 * path resolves to its project's instance too, since the dev server serves the
 * main checkout.
 */
export async function resolveProjectDevInstanceTarget(
  rootPath: string | null,
): Promise<ProjectDevInstanceTarget | null> {
  if (!rootPath) {
    return null;
  }
  const slug = await matchSlug(rootPath);
  if (!slug) {
    return null;
  }
  let url: string | null = null;
  try {
    const contents = await readFile(join(VHOST_DIR, `${slug}.caddy`), "utf8");
    const host = parseVhostHost(contents);
    url = host ? `https://${host}` : null;
  } catch {
    url = null;
  }
  return { slug, url };
}

/**
 * `https://…` address serving this project's checkout, or null when the project
 * has no dev instance on this host.
 */
export async function resolveProjectDevInstanceUrl(
  rootPath: string | null,
): Promise<string | null> {
  const target = await resolveProjectDevInstanceTarget(rootPath);
  return target?.url ?? null;
}

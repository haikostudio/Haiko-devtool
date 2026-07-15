# Self-host fork ↔ upstream sync

How the self-hosted Paseo fork (`app.haikostudio.cloud`) stays current with the
open-source upstream while keeping a thin custom layer on top.

## Layout

- `origin` → `getpaseo/paseo` — the open-source upstream. **This is the base.**
- `fork` → `haikostudio/paseo` — the self-host fork. Deploys from branch
  `feat/github-repo-picker`.

The branch is **upstream `origin/main` + a thin custom layer** (5 commits):

| Commit | What |
| --- | --- |
| `Add project autostart and launcher infrastructure` | `ops/project-autostart`, `ops/project-launcher` |
| `ci: add self-host web build workflow` | `.github/workflows/build-web-selfhost.yml` |
| `fix(attachments): compress oversized images…` | client-side image compression + send-budget guard |
| `feat(relay): self-host chunking + e2ee…` | relay chunking for >1 MiB payloads (Cloudflare 1009) |
| `style: apply oxfmt…` | formatting of the above |

Everything else comes from upstream. The **GitHub repo picker is intentionally
NOT custom** — upstream ships its own (`project.add`,
`workspace.github.search_repositories`, `project.github.clone`); the fork uses
that. An earlier custom picker was dropped during the July 2026 rebase.

## Keeping in sync

### Automatic (weekly scheduled agent)

A scheduled routine runs weekly. It invokes `ops/sync-upstream.sh` and, if that
reports a conflict, resolves it (the custom layer wins for
`packages/relay`, `packages/app/src/attachments`, `ops/`, and the self-host CI
workflow), re-verifies with `build:web`, and reports back. See the `schedule`
skill / the routine named **sync-paseo-upstream**.

### Manual

```bash
./ops/sync-upstream.sh
```

The script:

1. Refuses to run on a dirty tree.
2. `git fetch origin`; exits early if already up to date.
3. Tags `pre-sync-backup` (recovery point), then `git rebase origin/main`.
4. On conflict: aborts the rebase and exits non-zero with guidance.
5. On success: `npm install`, `build:client`, `build:server`, then
   `build:web` (the CI-critical check).
6. `git push fork feat/github-repo-picker --force-with-lease`.

It **never touches the live site.** Publishing stays an explicit step so upstream
changes are reviewed first:

```bash
/home/paseo/paseo-app-deploy.sh   # download CI artifact → rsync → reload Caddy
```

## Conflict resolution principle

The custom layer is deliberately small and mostly non-overlapping with upstream
(relay is untouched upstream; attachments/compression is new; `ops/` and the CI
workflow are fork-only). When a rebase conflicts, **keep the custom side** for
those paths and take upstream everywhere else. If upstream ever adds its own
image compression or relay chunking, retire the corresponding custom commit
instead of carrying a duplicate.

## Recovery

Any sync tags `pre-sync-backup`; the original pre-migration state is at
`pre-upstream-merge-backup`. To undo a bad sync:

```bash
git reset --hard pre-sync-backup
```

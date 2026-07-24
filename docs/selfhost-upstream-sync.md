# Self-host fork ↔ upstream sync

How the self-hosted Paseo fork (`app.haikostudio.cloud`) stays current with the
open-source upstream while keeping a thin custom layer on top.

## Layout

- `origin` → `getpaseo/paseo` — the open-source upstream. **This is the base.**
- `fork` → `haikostudio/paseo` — the self-host fork. Deploys from branch
  `feat/github-repo-picker`.

The branch is **upstream `origin/main` + a thin custom layer** (5 commits):

| Commit                                              | What                                                 |
| --------------------------------------------------- | ---------------------------------------------------- |
| `Add project autostart and launcher infrastructure` | `ops/project-autostart`, `ops/project-launcher`      |
| `ci: add self-host web build workflow`              | `.github/workflows/build-web-selfhost.yml`           |
| `fix(attachments): compress oversized images…`      | client-side image compression + send-budget guard    |
| `feat(relay): self-host chunking + e2ee…`           | relay chunking for >1 MiB payloads (Cloudflare 1009) |
| `style: apply oxfmt…`                               | formatting of the above                              |

Everything else comes from upstream. The **GitHub repo picker is intentionally
NOT custom** — upstream ships its own (`project.add`,
`workspace.github.search_repositories`, `project.github.clone`); the fork uses
that. An earlier custom picker was dropped during the July 2026 rebase.

## Keeping in sync

### Automatic (weekly systemd timer)

A systemd timer on the VPS runs the sync every **Monday 04:17** local time:

- `paseo-sync-upstream.timer` → `paseo-sync-upstream.service`
  (installed in `/etc/systemd/system/`, unit sources kept in `/home/paseo/`).
- Runs as user `paseo`, `Persistent=true` (catches up a missed run after downtime).
- Logs append to `/home/paseo/paseo-sync.log`; full journal via
  `journalctl -u paseo-sync-upstream`.

Useful commands:

```bash
systemctl list-timers paseo-sync-upstream.timer   # when it next fires
sudo systemctl start paseo-sync-upstream.service  # run now
tail -f /home/paseo/paseo-sync.log                # watch output
```

On a **clean** rebase the timer syncs and pushes unattended. On a **conflict** the
script aborts (non-zero, logged) and leaves the tree clean — resolve it manually
or ask Claude to (custom layer wins for `packages/relay`,
`packages/app/src/attachments`, `ops/`, and the self-host CI workflow; take
upstream elsewhere), then re-run.

> A remote/cloud scheduled agent (the `schedule` skill) can't be used here: those
> agents run in Anthropic's cloud with no access to this VPS, `/root/paseo`, the
> local `gh` credentials, or `sudo`. The sync is inherently a local-VPS operation,
> hence the systemd timer.

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

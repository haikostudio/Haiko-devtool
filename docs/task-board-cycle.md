# Task board cycle — who is allowed to move a card

The kanban board has seven columns, in order:

```
Notes → À faire (backlog) → Validé → Planifié → En cours → Terminé → Déployé
```

**The board is moved by hand.** A card changes column because the user dragged
it. Three machine-made moves survive, and only three: the analysis promotion
("Validé" → "Planifié", the instant a card's cost analysis succeeds), the launch
stamp ("Planifié" → "En cours", at the instant the agent really starts) and the
final-check bar ("En cours" → "Terminé"). Nothing else — no agent activity, no
heuristic — may move a card.

## Ownership of each transition

| Transition          | Who performs it               | Notes                                                                                                                                                                          |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| → Notes / → À faire | user **or** an agent          | The only two columns an agent may write to.                                                                                                                                    |
| À faire → Validé    | **user only**                 | Drag, the task chat's "Valider la tâche" bar, or approving a proposal.                                                                                                         |
| Validé → Planifié   | estimator                     | Auto, the instant the card's cost analysis succeeds (see below).                                                                                                               |
| Planifié → En cours | scheduler                     | Stamped at launch, when the slot, quota and timing gates all pass.                                                                                                             |
| En cours → Terminé  | **user-initiated**            | The final-check bar — the card's own agent checks, deploys, finishes it.                                                                                                       |
| Terminé → Déployé   | publish **or** user-initiated | Auto-stamped when the card's branch is confirmed merged + published; also reachable by hand via the "Lancer le déploiement" bar (the card's own agent deploys, then moves it). |

## The invariants

1. **`createTask` always pins "backlog".** No caller can create a card straight
   into the pipeline — the `column` field on `CreateTaskInput` is deliberately
   ignored. A card enters the pipeline by being _moved_, never by being _born_.
2. **The scheduler never promotes a backlog card.** Backlog does exactly two
   things: self-healing cleanup of stray cost state, and the free light analysis
   (title + tidied prompt). No estimate, no agent, no exit. There used to be a
   per-folder "auto-start" default that auto-validated backlog cards; it was
   removed — cards appeared to transit "À faire" and land in "Validé" by
   themselves, which is precisely the consent the column exists to capture.
3. **Agents are blocked at the tool boundary, not by a prompt.** `move_task`
   accepts only `notes` and `backlog` (`AGENT_WRITABLE_TASK_COLUMNS`) and throws
   for the rest — except the two per-card consent windows a user press opens:
   `done` while a final check runs (`validation.state === "running"`) and
   `deployed` while a deploy runs (`deployment.state === "running"`). Prompt
   wording alone is not a gate: a model that is told to be helpful will validate
   its own work.
4. **Agent activity never moves a card.** `agent-sync` may create a card, link an
   agent to it and update its `progress` badge — it holds no `transitionTask`
   call at all. It used to drag cards into "En cours" the moment a linked agent
   started a turn; since every card owns an agent from birth, that dragged brand
   new cards out of "À faire" on their own. A checked-off todo is a
   `ready_for_review` badge, nothing more.
5. **"Validé" promotes itself only on a _successful_ analysis.** The cost
   analysis runs there; the instant it succeeds (`TaskEstimator.estimate`), the
   card moves itself to "Planifié" so the scheduler can pick it up — the user no
   longer drags an already-costed card forward by hand. This is strictly guarded
   to the consent gate: a card whose analysis is still pending, failed, or held
   (`executionHold`) stays in "Validé", and a card the user already moved is left
   where it is. Validated → scheduled is a move _between_ pipeline columns, so it
   preserves the estimate and its `awaiting_slot` schedule (it neither re-arms nor
   disarms anything). The move goes through `transitionTask`, never the agent's
   `move_task` — the analysis agent is still confined to "Notes"/"À faire".

## Auto-promotion after analysis — the third exception

The consent that used to live in the "Validé" → "Planifié" _drag_ now lives one
step earlier, at "À faire" → "Validé": validating a card is the user saying "yes,
run this". Once validated, the pipeline is autonomous — the estimator costs the
card and, on success, promotes it to "Planifié" itself. A card can only sit in
"Validé" while it has no usable estimate (analysis pending, failed and awaiting a
retry, or explicitly held for review), which is exactly when it must not launch.

That consent has two equivalent front doors, both strictly user-driven and both
routed through `TaskBoardService.approveTask` (never the agent's `move_task`): a
drag of the card onto "Validé", and the **"Valider la tâche" bar** shown above
the prompt in the task chat while the card is in "À faire". `approveTask` handles
both a plain backlog card and an agent proposal awaiting approval — it moves the
card into "Validé" and arms its `schedule` with `pending_estimate` so the
estimator picks it up. Do not confuse it with the "En cours" → "Terminé"
final-check bar, which shares the confusingly-named `validateTask` label key but
is a different gesture entirely.

The card then shows **when** it will run, not just that it is scheduled: a
"Planifié" card carrying an off-peak/heavy estimate renders a concrete
"Vers mar. 01:00" hint (`computeNextRunAt` in `task-card.tsx`, resolved from the
tasks quiet-hours window), so the user sees the actual launch slot the scheduler
is holding it for. Light "auto"/"asap" cards that run on the next tick show the
plain "En attente de créneau" badge instead — there is no future slot to name.

## The final check — a window, not a verdict

Pressing "Lancer le contrôle" does not run a hidden reviewer. It sends a check
prompt into the card's OWN conversation (`tasks/validator.ts`): the agent
re-reads the request, runs the project's checks, **fixes what it finds**,
**deploys the change onto the project's dev instance on the VPS**, and completes
the card itself once everything is green. The user reads the whole thing live
instead of a dumped report.

**Finishing a card is what publishes it.** There is no deploy button and no
deploy sheet in the app any more (both were deleted); the whole publication path
now hangs off the card reaching "Terminée":

- **An ordinary project** is deployed by the agent itself, inside the check: its
  dev server runs as the `autoproject-<slug>` systemd unit behind Caddy on
  `<slug>.haikostudio.cloud`, so the agent merges its branch into the project's
  main checkout, restarts the unit and checks the URL answers.
- **Paseo itself** is published by the daemon: `setOnTaskCompleted` in
  `bootstrap.ts` hands the card to `TaskPublisher`, which fires
  `triggerPaseoDeploy` with the card's branch the instant it lands in "Terminée"
  (local build → Caddy webroot). The agent must NOT run a publish script by
  hand, and never restarts `paseo.service`.

Because there is no progress sheet any more, `TaskPublisher` narrates the
publication into the card's OWN conversation ("Construction…", "Mise en ligne…",
"c'est en ligne : <url>", or the failure reason). It also stamps
`KanbanTask.deployedUrl` — the address the work went live at, resolved from the
host's `autoproject` layout (`run/<slug>/start.sh` → checkout,
`project-autostart.d/<slug>.caddy` → hostname) — so a finished card shows an
"En ligne" chip one tap from the thing it changed.

That press opens a consent window on that one card — `validation.state ===
"running"` — and it is the second exception in `move_task`: `done` is accepted
while the window is open, for that card only. The window closes as soon as the
agent stops working (`watchAgentIdle`), whether or not it completed the card, so
a check can never leave the bar stuck.

## Deploying a finished card — the "Lancer le déploiement" bar

The automatic publish above only stamps `deployed` for cards it actually ships —
Paseo's own cards, or a project whose branch is confirmed merged. Every other
finished card used to sit in "Terminé" for good. The **"Lancer le déploiement"**
bar (offered above the prompt on a "Terminé" card) closes that gap, as the exact
sibling of the final-check bar:

- It is served by `TaskDeployer` (`deployer.ts`), symmetric to `TaskValidator`.
  Pressing it hands the card's OWN agent a deploy-then-confirm prompt
  (`buildDeployPrompt`): verify the work still runs, deploy it (dev instance for a
  project; for Paseo, only confirm — the daemon already published at "Terminé"),
  then move the card to "Déployé" itself.
- The press opens a consent window on that one card — `deployment.state ===
"running"` — the **third exception** in `move_task`: `deployed` is accepted
  while the window is open, for that card only. The window closes on
  `watchAgentIdle`, so a deploy can never leave the bar stuck.
- The move to `deployed` carries an optional `needsDaemonRestart` argument, which
  an agent may still set by hand. It is **purely informative** — it never triggers
  a restart; that stays the user's explicit call. See below for how the flag is
  now resolved automatically, well before the deploy.
- On a "Terminé" card the deploy bar takes the composer slot ahead of the archive
  bar, so the natural order is deploy, then archive.

## "Redémarrage requis" — an advance warning, not a post-mortem

`KanbanTask.needsDaemonRestart` is resolved **automatically the moment a card
reaches "Terminé"**, so the user knows _before_ publishing whether the work will
only take effect after a daemon restart — instead of discovering it afterwards.

- **How.** `moveTask` fires a best-effort resolver (wired at bootstrap to
  `resolveDaemonRestartImpact`) against the files the next publication will carry
  (`getPendingDeployFiles` — the diff from `.deployed-sha` plus the working tree).
  `needsDaemonRestartForFiles` (pure, unit-tested) answers yes for anything under
  `packages/server|protocol|relay|highlight` — the code the daemon process loads —
  and no for app/website work, for the CLI and desktop wrapper (separate processes),
  and for tests/markdown. **Only Paseo's own checkout can require one**: a client
  project's work never touches the Paseo daemon, so it resolves to `false`.
- **Never a guess.** An unresolved verdict (`null`: git unavailable, no baseline)
  leaves whatever the card already carried, so a flag an agent set by hand is
  never wiped.
- **On the card.** `showsRestartNotice` renders it as an amber `StatusBadge`
  beside the live status badge — same tinted-frame family as "Publication en
  cours" / "Contrôle final en cours". It rides the card for the whole wait and
  **disappears once the work is live** (column `deployed`, or a stamped
  `deployedUrl`): by then the user has already been told.

## Archiving a card — hide, never publish

A finished card (in "Terminé" or "Déployé") can be **archived** by hand from the
"Archiver" bar above its prompt. Archiving is deliberately **orthogonal to the
seven columns**: it does not move the card, does not publish it, and does not
touch the automatic `done → deployed` publication that `TaskPublisher` already
runs (`publish-on-complete.ts`). It only sets an optional `archivedAt` stamp and
the board **hides** the card from view.

Two behaviours were considered:

- **(a) a manual `Terminé → Déployé` shortcut** — force publication when the
  automatic path does not apply.
- **(b) hide the card from the board** — remove it from view without publishing.

We chose **(b)**. Archiving is a filing gesture, not a publishing one: the user
is saying "I'm done looking at this", not "put this live". Publication already
happens on its own the instant a card reaches "Terminé" (Paseo by the daemon,
ordinary projects by the card's own agent inside the final check), so an archive
that also published would either double the work or race it. Keeping archive
purely additive means it can never break invariant 4 below.

The mechanics:

- `archivedAt` is an **optional, additive** field on the task (old boards/clients
  simply omit it). Setting it never changes the card's `column`, so the pipeline,
  the scheduler and `TaskPublisher` all keep seeing the card exactly as before.
- The **board hides** archived cards on the display side; the daemon still stores
  them, so a future "archived" view can list and un-archive them. Nothing on the
  server drops an archived task from the pipeline.
- The bar is offered **only** in "Terminé"/"Déployé" — the two terminal columns —
  because archiving mid-flight would hide live work.

## The other exception

A publish blocked by a merge conflict opens a repair task and validates it
itself (`bootstrap.ts`, the deploy-conflict task creator). The publish being
unblocked is the consent, and the repair exists only to let it through. It is
the sole place in the daemon that moves a card into "Validé" on the user's
behalf — keep it that way.

# Task board cycle — who is allowed to move a card

The kanban board has seven columns, in order:

```
Notes → À faire (backlog) → Validé → Planifié → En cours → Terminé → Déployé
```

**The board is moved by hand.** A card changes column because the user dragged
it. Two machine-made moves survive, and only two: the launch stamp
("Planifié" → "En cours", at the instant the agent really starts) and the
final-check bar ("En cours" → "Terminé"). Nothing else — no analysis result, no
agent activity, no heuristic — may move a card.

## Ownership of each transition

| Transition          | Who performs it      | Notes                                                                    |
| ------------------- | -------------------- | ------------------------------------------------------------------------ |
| → Notes / → À faire | user **or** an agent | The only two columns an agent may write to.                              |
| À faire → Validé    | **user only**        | Drag, or the approval action on a proposed task.                         |
| Validé → Planifié   | **user only**        | Analysis runs in "Validé" and stops there; the drag is the go signal.    |
| Planifié → En cours | scheduler            | Stamped at launch, when the slot, quota and timing gates all pass.       |
| En cours → Terminé  | **user-initiated**   | The final-check bar — the card's own agent checks, deploys, finishes it. |
| Terminé → Déployé   | publish              | Stamped when the card's branch is confirmed merged + published.          |

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
   for the rest. Prompt wording alone is not a gate: a model that is told to be
   helpful will validate its own work.
4. **Agent activity never moves a card.** `agent-sync` may create a card, link an
   agent to it and update its `progress` badge — it holds no `transitionTask`
   call at all. It used to drag cards into "En cours" the moment a linked agent
   started a turn; since every card owns an agent from birth, that dragged brand
   new cards out of "À faire" on their own. A checked-off todo is a
   `ready_for_review` badge, nothing more.
5. **"Validé" does not promote itself.** The cost analysis runs there and the
   card waits. The user drags it into "Planifié" when they want it run.

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

## The other exception

A publish blocked by a merge conflict opens a repair task and validates it
itself (`bootstrap.ts`, the deploy-conflict task creator). The publish being
unblocked is the consent, and the repair exists only to let it through. It is
the sole place in the daemon that moves a card into "Validé" on the user's
behalf — keep it that way.

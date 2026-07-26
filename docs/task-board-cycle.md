# Task board cycle — who is allowed to move a card

The kanban board has seven columns, in order:

```
Notes → À faire (backlog) → Validé → Planifié → En cours → Terminé → Déployé
```

**Validation is a human act.** "Validé" is not a status, it is the user's consent
to spend quota and let an agent touch the code. Everything after it is automatic;
everything before it is inert.

## Ownership of each transition

| Transition          | Who performs it      | Notes                                                           |
| ------------------- | -------------------- | --------------------------------------------------------------- |
| → Notes / → À faire | user **or** an agent | The only two columns an agent may write to.                     |
| À faire → Validé    | **user only**        | Drag, or the approval action on a proposed task.                |
| Validé → Planifié   | scheduler            | Once the cost analysis produced an estimate.                    |
| Planifié → En cours | scheduler            | When the slot, quota and timing gates all pass.                 |
| En cours → Terminé  | **user only**        | The "Valider la tâche" action (runs the final review first).    |
| Terminé → Déployé   | publish              | Stamped when the card's branch is confirmed merged + published. |

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
4. **A checked-off todo never completes a card.** Agent-sync marks it
   `ready_for_review` in "En cours"; only the user moves it to "Terminé".

## The one exception

A publish blocked by a merge conflict opens a repair task and validates it
itself (`bootstrap.ts`, the deploy-conflict task creator). The user's click on
"Publier" is the consent, and the repair exists only to unblock that click. It is
the sole place in the daemon that moves a card into "Validé" on the user's
behalf — keep it that way.

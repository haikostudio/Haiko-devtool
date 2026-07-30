# Task board cycle — who is allowed to move a card

The kanban board has seven columns, in order:

```
Notes → À faire (backlog) → Validé → Planifié → En cours → Terminé → À déployer
```

The last column is the publication **queue**, not a claim that the work is
online. Its wire key is still `deployed` (the protocol never renames a column
value — an old client must keep parsing the board), but its label and its meaning
are "waiting to be published". What says a card is actually live is its own
`deployedAt` stamp, never the column.

**The board is moved by hand.** A card changes column because the user dragged
it. Three machine-made moves survive, and only three: the analysis promotion
("Validé" → "Planifié", the instant a card's cost analysis succeeds), the launch
stamp ("Planifié" → "En cours", at the instant the agent really starts) and the
"Terminer la tâche" bar ("En cours" → "Terminé", which is nothing more than that
move). Nothing else — no agent activity, no heuristic — may move a card. In
particular the last hop ("Terminé" → "À déployer") never happens on its own: a
finished card rests in "Terminé" until the user queues it, or until a publication
the user launched sweeps it in (see "Publishing" — the run promotes what it is
about to ship, which is bookkeeping inside a gesture the user made, not a fourth
machine-made move).

**One project, one board.** Folders (classeurs) are gone from the product: a
project has exactly one task list, minted by the server on demand
(`ensureDefaultFolder`), and the board shows every task of the project without
narrowing by it. Nothing in the UI creates, renames, deletes or selects a folder,
and the conductor's folder tools are blocked. The `tasks.folder.*` RPCs and the
`folderId` on a persisted task stay on the wire for old clients and for the
branch/shared-worktree record legacy lists carry — that is compatibility, not a
feature. `createTask` tolerates an unknown or empty `folderId` and files the card
in the project's single list.

## Ownership of each transition

| Transition           | Who performs it      | Notes                                                                                                                                                     |
| -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| → Notes / → À faire  | user **or** an agent | The only two columns an agent may write to.                                                                                                               |
| À faire → Validé     | **user only**        | Drag, the task chat's "Valider la tâche" bar, or approving a proposal.                                                                                    |
| Validé → Planifié    | estimator            | Auto, the instant the card's cost analysis succeeds (see below).                                                                                          |
| Planifié → En cours  | scheduler            | Stamped at launch, when the slot, quota and timing gates all pass. A card held by one of them says which — see "Why a card waits in Planifié".            |
| En cours → Terminé   | **user only**        | The "Terminer la tâche" bar (or a drag). A plain column move: no prompt, no check, no deployment — see below.                                             |
| Terminé → À déployer | **user only**        | Manual: a finished card RESTS in "Terminé" and waits. The user queues it with the card's button (or a drag), or a publication they launched sweeps it in. |

## The invariants

1. **`createTask` always pins "backlog".** No caller can create a card straight
   into the pipeline — the `column` field on `CreateTaskInput` is deliberately
   ignored. A card enters the pipeline by being _moved_, never by being _born_.
2. **The scheduler never promotes or prepares a backlog card.** Backlog does
   exactly one thing: self-healing cleanup of stray pipeline state left by older
   builds. No estimate, no tidied prompt, no agent prompt, no exit. There used
   to be a per-folder "auto-start" default that auto-validated backlog cards;
   it was removed — cards appeared to transit "À faire" and land in "Validé" by
   themselves, which is precisely the consent the column exists to capture.
3. **Agents are blocked at the tool boundary, not by a prompt.** `move_task`
   accepts only `notes` and `backlog` (`AGENT_WRITABLE_TASK_COLUMNS`) and throws
   for the rest — except the ONE per-card consent window a user press opens:
   `deployed` while a deploy runs (`deployment.state === "running"`). `done` has no
   window any more: finishing a card is the user's own press, so no agent can
   complete its own work under any circumstance. Prompt wording alone is not a
   gate: a model that is told to be helpful will validate its own work.
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
6. **"À déployer" is reachable from "Terminé" only.** Enforced in the service
   (`isDeployedReachableFrom`, `TaskBoardService.moveTask`) and mirrored in the
   app's move guard, so no caller — drag, `move_task`, batch publisher, archive
   restore — can slip a card into the publication queue without it having
   completed. A card carrying `completedAt` is exempt: that is a re-queue or the
   "Désarchiver" restore, neither of which skips anything.

   The rule earns its keep because the skip has already happened twice: once as a
   deliberate auto-hop (removed), and once because the **compiled daemon was
   stale**. Which leads to the trap below.

   The one sanctioned exception is `queueOnComplete`, armed by the card's
   "Terminer et mettre en file" press: the card completes and continues into the
   queue in one gesture. It still passes THROUGH "Terminé" (the completion
   listener fires first), and the flag is one-shot — cleared as soon as it is
   honoured, so it can never re-arm a later run.

   Refused moves are logged rather than swallowed: `Refused task move` in the
   daemon log, `[paseo:board-move]` in the client console, plus a bounded
   in-memory history surfaced on the board (`RefusedMovesNotice`) — one silent
   no-op is right, three in a row look like a broken board.

## "Tout déployer" — what one press actually runs

The press is the ONLY thing that publishes, and what it starts is a script, not
an agent:

```
TaskBatchDeployer.deployAll        (queue, one run per project, serialized)
  → triggerPaseoDeploy             (snapshot the lot, reset the phase marker)
    → spawn ops/paseo-build-local.sh (detached, its own log, no model involved)
       prepare → push → verify → daemon → site → publish
  → watch (poll deploy status ~5 s, narrate each phase into every card)
  → stamp the cards live, then request the daemon restart
```

Each step of the script writes its name into
`/home/paseo/paseo-build-local.phase` (the column's progress bar) and every fatal
cause is printed as `!! <raison>` — the exact line the board shows in the failure
recap. The full output goes to `/home/paseo/paseo-ship-now.log`; the daemon
serves this run's slice of it as `deployLog` on the deploy-status RPC, and the
banner opens it (`DeployLogSheet`). That log IS the window onto a publication.

**Never put a model back on this path.** Publication used to be handed to an LLM
agent that ran the script, watched it and repaired environment failures. The day
both provider quotas were spent, pressing "Tout déployer" created an agent that
died on "usage limit" before running anything: nothing was built, nothing went
online, and the column filled with the agent's own errors. A publication must not
be able to fail for a reason unrelated to the code being published. Environment
repairs that were the agent's excuse to exist are now explicit steps in the
script (disk preflight, residual-lock probe, push retries).

**Publishing includes saving.** `prepare` commits whatever is uncommitted (the
message names the lot's cards, passed down as `PASEO_DEPLOY_TASKS`) and `push`
sends it to the fork — three attempts, then a hard stop. A site built from files
that exist nowhere but this server is code that cannot be reviewed, reverted or
retrieved, and it makes `.deployed-sha` name a commit that does not contain what
is online. `PASEO_DEPLOY_SKIP_PUSH=1` is the escape hatch when the remote is
durably unreachable.

**The restart is a step, not a reaction.** A successful batch always restarts the
daemon, so the engine runs the code that just went online. The single exception
is a proven one: the engine already runs exactly the published sha (a republish
with no new commit). An unknown version never takes that door.

## The stale-daemon trap

The daemon does not run the source — it runs `packages/*/dist`. Publication used
to build the web app only, so a server-side fix could be committed, "published"
and even followed by a daemon restart while the daemon reloaded the exact same
old compiled code. Symptom: a bug that was fixed hours ago behaves as if the fix
had never been written, and the card keeps skipping "Terminé".

`ops/paseo-build-local.sh` now builds the daemon too (`build:server:clean` inside
the frozen snapshot), then swaps the compiled `dist` of `highlight`, `relay`,
`protocol`, `client`, `server` and `cli` into the live checkout by rename before
the batch publisher's final restart. Never remove that step.

Diagnosing a suspected stale daemon: compare a distinctive string from the source
against the built file (`grep` in `packages/server/dist/server/server/…`), or the
`dist` mtimes against the commit time. Same source, absent string ⇒ the running
daemon predates the fix.

The daemon now answers that question itself. The publish script stamps the commit
it compiled into `/home/paseo/paseo-daemon-built.sha`; at every boot
`DaemonRestartReminder.checkBuildFreshness()` compares three facts — the compiled
engine, the deploy marker (`.deployed-sha`) and the version the SITE declares
(`version.json`) — and warns when any two disagree, in the log and as a push
notification. The board shows the same verdict as a banner
(`StaleEngineBanner`, fed by `useDaemonBuildFreshness` over the deploy-status
RPC). The compiled marker also makes the restart-debt count honest (measured from
the COMPILED commit, not from HEAD at boot) and rides on the deploy status as
`daemonBuiltSha`. A missing marker (dev runs, older installs) means no claim: an
unknown answer must never look like a diagnosis.

Each published card also carries `deployedSha`, stamped by the batch publisher
from the version that actually went online, and shown on the card. "Déployé"
alone stops answering "which build?" as soon as a second publication follows.

## Ce qui crée une carte — the conductor's triage

The "chef d'orchestre" used to read every message as an intention to add work:
one message, one card. Asking it "combien de cartes sont en attente ?" created a
card about counting the cards. Its system prompt
(`packages/server/src/server/tasks/conductor-agent.ts`) now starts with a triage
into four families, and only one of them mints anything:

| Message                                                                                    | What the conductor does                                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Question / information** — "comment ça marche ?", "où en est X ?", "combien de cartes ?" | Answers in the conversation. **No card.** May read the board and the code. |
| **Action** — "corrige le graphe", "ajoute un bouton", or a reported bug                    | `create_task`, straight into "À faire", exactly as before.                 |
| **Ambiguous** — "le chargement est lent, non ?"                                            | Answers, then offers in one sentence to make it a task. Card only on yes.  |
| **Board upkeep** — "renomme la carte X", "supprime la carte Y", "liste les cartes"         | Calls `update_task` / `move_task` / `delete_task` / `list_tasks` directly. |

Reading is not acting: the conductor keeps `Read`/`Grep`/`Glob` and the read-only
board tools so it can answer a question accurately without inventing a card as a
pretext. Hesitation resolves to _ambiguous_, not to _action_ — offering a card
costs a sentence, minting one costs a column.

Two bans are unchanged by the triage and restated in the same prompt: the
conductor **never writes code** (its edit/shell/subagent tools are removed at the
SDK level) and **never moves a card into "Validé"** (`move_task` refuses it — see
invariant 3).

### One exception — the conductor on the Paseo repo itself

Everything above describes the conductor on a **user project**. On the **Paseo
repo itself** it wears the other hat: a **full agent**, like a global agent. It
carries out an action request **directly** — edit code, run commands, publish —
instead of minting a card, and its edit/shell/subagent tools are **not** stripped
(`disallowedTools` is empty). It still knows the board and manages it on demand.

The switch is decided by the project's checkout path, not a remote URL:
`ensureConductorAgentInner` calls `isPaseoDeployRoot(project.rootPath)` (the same
signal the deploy pipeline trusts to recognise "this is Paseo"), and threads the
resulting `isSelf` through the prompt builder, the config builder, and the
relock/current checks in `conductor-agent.ts`. On Paseo the full agent still
respects the standing deploy directive baked into its prompt: **commit + push
freely, never publish or restart the daemon on its own initiative** — that stays
the user's call.

### Accepting the offer in one click

The ambiguous case ends with the offer on a line of its own ("Souhaitez-vous que
j'en fasse une tâche ?"). The app detects that closing sentence
(`utils/task-offer.ts` — a verb of creation + "une tâche"/"une carte" + a
question mark, last offer only) and hangs an **"Oui, fais-en une tâche"** button
under it, so accepting costs one press instead of typing "oui".

The button **sends the confirmation as a message**; it does not create the card
itself. The conductor still writes the title and the description, because it is
the one holding the conversation — a client-side create would only have the
offer's prose to name the card with.

It sends through `onQuickSend`, the composer's raw send, deliberately NOT the
normal submit path: `submitAgentInput` clears the draft and the attachments, and
a one-click reply must never swallow a message the user is halfway through
writing. No composer, no channel, no button (read-only transcripts stay clean).

The shape of its answers follows the same split: the conductor gets the
`conductor` response template (see [response-templates.md](response-templates.md))
— no numbered sections, no estimate, no billing line — because it never executes
anything and so has nothing to report. A question gets a couple of sentences; a
handled request gets a bullet per card touched.

> The prompt is stored with the agent record, so an existing conductor is
> re-locked onto the new wording on the next ensure, and the new behaviour takes
> effect **after a daemon restart** — not at publication time.

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
"Terminer la tâche" bar, which shares the confusingly-named `validateTask` label
key but is a different gesture entirely.

The card then shows **when** it will run, not just that it is scheduled: a
"Planifié" card carrying an off-peak/heavy estimate renders a concrete
"Vers mar. 01:00" hint (`computeNextRunAt` in `task-card.tsx`, resolved from the
tasks quiet-hours window), so the user sees the actual launch slot the scheduler
is holding it for. Light "auto"/"asap" cards that run on the next tick show the
plain "En attente de créneau" badge instead — there is no future slot to name.

## Finishing a card — a move, and nothing else

Pressing "Terminer la tâche" moves the card from "En cours" to "Terminé"
(`tasks/validator.ts`). That is the whole action: no prompt is sent, no agent
turn starts, nothing is built and **nothing is deployed**.

It was not always so. The bar used to hand the card's own agent a
check-then-deploy prompt: re-read the request, run the project's checks, fix what
it found, **push the change onto the project's dev instance on the VPS**, then
complete the card itself. Two problems, both fatal. It DEPLOYED — a card looked
published before the user had queued anything, which is exactly the decision the
"À déployer" column exists to hold. And it spent a full agent turn on every single
finished card, the most expensive moment of the board's life.

**Verification lives at publication time now.** `buildDeployPrompt`
(`tasks/deployer.ts`) is where the agent re-reads the request, exercises the work,
runs typecheck/lint/tests, fixes what it finds — and only then puts it online. It
is the right place twice over: the code is about to go live anyway, and a card the
user never queues never spends a check at all.

**Finishing a card STOPS it in "Terminé".** `setOnTaskCompleted` in
`bootstrap.ts` hands the card to `TaskPublisher.announceReady`, which only writes
a note in the card's own conversation — it moves nothing. Queueing the card into
"À déployer" is the user's separate press. The daemon briefly did that hop by
itself, which left "Terminé" permanently empty: the user never saw finished work
come to rest, and the board read as if execution went straight to publication.
Nothing is built at that moment either.

Publication used to fire right there, once per card. On the shared checkout that
raced itself: several builds reading the same files while other agents were still
writing them, which is how a torn bundle (a mix of two versions of the same file,
crashing in the browser with no visible cause) gets published. One press, one
build, one batch is the fix — see the next section.

Because nothing is dispatched, no consent window is opened either: `move_task` has
no `done` exception left, and an agent can never complete a card. The press does
clear any `validation` state a card still carries from an older daemon, so a stale
"check running" window cannot freeze a card forever.

The one thing the press still arms is the optional queue hop: "Terminer et mettre
en file" sets `queueOnComplete`, honoured (and cleared) by the completion listener,
so the card continues into "À déployer" in a single gesture.

## Publishing — the "Tout déployer" button

The **only** gesture that puts work online is the button at the FOOT of the
"À déployer" column (`deploy-all-button.tsx` → `tasks.board.deploy_all` →
`TaskBatchDeployer`). It publishes every card of that column whose work is not
live yet, in ONE run, and restarts the daemon at the end.

- **What it takes.** `selectPendingDeployTasks`: every FINISHED card — column
  `deployed` **or** `done` — that is not archived, not held (`deployHold`) and not
  live yet (`deployedAt` / `deployment.state === "deployed"` / `deployedUrl`).

  "Terminé" counts because a publication builds the whole checkout: a finished
  card the user never queued rides along physically no matter what the board says.
  It used to ride along INVISIBLY — its work went online while its card stayed in
  "Terminé", unstamped, unarchived, and eligible for a later publication with
  nothing left to publish. `beginCycle` therefore sweeps those cards into the
  queue (`promoteFinishedCards`) BEFORE the run starts, so the lot on screen is
  the lot the build carries. `deployHold` remains the one way to keep a finished
  card out. The client's count (`countTasksAwaitingDeploy`) mirrors this exactly —
  the button must never promise fewer cards than the run publishes.

  The off-peak watcher is the one caller that keeps the narrower view
  (`selectQueuedDeployTasks`): only a card the user placed in "À déployer" may
  ORDER an unattended publication. Once it starts, it publishes the full lot like
  any other run.

- **Two shapes.** Paseo's own batch goes through `triggerPaseoDeploy` (which
  merges the cards' branches and hands the build to its own supervising agent);
  the daemon watches the run, narrates each phase into every card's conversation,
  stamps the cards live (`markTaskDeployed`) and then restarts itself. Any other
  project is deployed card by card by each card's own agent (the per-card path
  below), and no daemon restart follows — that project's own service was
  restarted by the agent that deployed it.
- **It refuses to start** while a card is still in "En cours" (a build taken from
  a checkout other agents are writing into is the torn-bundle bug), while a batch
  is already running, and when there is nothing left to publish. Each refusal
  says which case it is.
- **The restart is part of the deal, unconditionally.** The confirmation dialog
  says so before anything starts: the daemon is running the code from BEFORE the
  publication, so the batch ends by restarting it. That press is the explicit,
  informed consent — nothing else in the daemon ever restarts it on its own.

  It is no longer conditional on `needsDaemonRestart`. That flag is a heuristic
  over the changed paths, so a daemon change it failed to recognise went online
  while the engine kept executing the previous build — the published version and
  the running version disagreeing with no trace, which reads as "the fix was never
  applied". A few seconds of reconnect per publication buys the end of that whole
  class of ghost bugs. The flag survives only as the card's "Redémarrage requis"
  badge, cleared as the batch stamps each card.

- **A failed run marks nothing live**, sets each card's `deployment.state` to
  `failed`, and says why in the conversations. Silence is never taken for success.

### What the column shows while (and after) it runs

The run is recorded on the BOARD, not on a card (`TaskBoard.deployBatch`, written
by `setDeployBatch`/`patchDeployBatch`): it is one build covering several cards,
so it gets one bar, not N spinners.

- **During**: `DeployBatchBanner` sits above the cards with a single progress bar
  fed by the build script's own phases (sauvegarde → construction → mise en
  ligne). It is server truth, not a local animation guessing at the daemon.
- **After**: the same banner becomes the "voici ce qui vient d'être mis en ligne"
  recap — the card titles it took out (snapshotted at start, so a rename or an
  archive afterwards cannot rewrite history), the address, or the failure reason.
  One tap dismisses it (remembered per run, `dismissedDeployBatchAt`), and a recap
  older than a day hides itself.
- A project deployed card-by-card (not the self-host) clears the record once every
  card has been handed to its own agent: there is no single run left to follow, and
  each card carries its own "Publication en cours" badge.

### Holding one card back — "Retirer du prochain lot"

A queued card can be taken out of the next batch from its ⋮ menu, without
archiving it: `deployHold` (additive, optional) keeps the card exactly where it
is, visible and finished, and `selectPendingDeployTasks` skips it. The button's
counter drops accordingly. "Remettre dans le lot" is the same single gesture the
other way. It is a pause, not a filing gesture — the difference from archiving is
that a held card is still on the board asking to be published one day.

### Publishing on its own — "Publier automatiquement en heures creuses"

Opt-in, off by default, one switch under the button (`tasks.autoDeployOffPeak` in
the daemon config). When it is on, `AutoDeployWatcher` checks every few minutes
whether the clock is inside the tasks quiet-hours window and, if cards are
waiting, starts exactly the same batch the button would — closing restart
included. That is the whole point of off-peak: the restart lands when nobody is
working.

- Turning it ON is the standing authorization for that restart, and the
  confirmation dialog says so in as many words. Nothing else in the daemon ever
  restarts it unattended.
- The watcher forces nothing: `deployAll` keeps every refusal it has (a card still
  running, a batch already going, an empty queue), and each one simply means "not
  this tick".
- A run it started is flagged `auto` on the board record, so the banner and the
  recap say the publication went out on its own.

## Deploying one finished card — the "Lancer le déploiement" bar

A single card can still be published on its own, which is how an ordinary project
(one dev instance, one systemd unit) is deployed:

- It is served by `TaskDeployer` (`deployer.ts`), symmetric to `TaskValidator`.
  Pressing it hands the card's OWN agent a deploy-then-confirm prompt
  (`buildDeployPrompt`): verify the work still runs, deploy it (dev instance for a
  project; for Paseo, only confirm — its publication belongs to "Tout déployer"),
  then confirm it with `move_task(…, "deployed")`, which stamps the card live.
- The press opens a consent window on that one card — `deployment.state ===
"running"` — the **third exception** in `move_task`: `deployed` is accepted
  while the window is open, for that card only. The window closes on
  `watchAgentIdle`, so a deploy can never leave the bar stuck.
- The move to `deployed` carries an optional `needsDaemonRestart` argument, which
  an agent may still set by hand. It is **purely informative** — it never triggers
  a restart; that stays the user's explicit call. See below for how the flag is
  now resolved automatically, well before the deploy.
- The bar is offered on a finished card that is not live yet — whether it is
  still in "Terminé" or already waiting in "À déployer" — and takes the composer
  slot ahead of the archive bar, so the natural order is deploy, then archive.

## Why a card waits in "Planifié"

A queued card that is not launching is always held by exactly one of four gates,
and **all four now say so on the card**. They used to be two: the other two were a
bare `continue`/`return` in the tick loop, which is how a card sat for hours
wearing a green "Démarrage imminent" while the scheduler knew precisely why it was
not starting. "On l'a lancée et elle reste dans Planifié" was that silence, not a
crash.

| Gate                              | Field                     | Card says                           |
| --------------------------------- | ------------------------- | ----------------------------------- |
| Outside the launch window         | `schedule.waitingReason`  | "Attente heures creuses"            |
| Not enough quota left             | `schedule.waitingReason`  | "En attente de quota"               |
| A sibling holds the shared branch | `schedule.waitingBlocker` | "Une autre tâche occupe le dossier" |
| Every launch slot is taken        | `schedule.waitingBlocker` | "Tous les créneaux sont occupés"    |

Two fields, one concept, on purpose: `waitingReason` is a wire `z.enum`, and a
third literal on it would make an old client reject the whole board message. So
the two new holds travel in their own optional field
(`COMPAT(scheduleWaitingBlocker)`), to be folded in once the version floor allows.

The blocker is cleared the moment the card is actually launched — a stale
explanation on a card that is starting is its own small lie. Run-now overrides the
two timing gates but NOT the two physical ones, so the "Lancer maintenant" control
names the hold instead of looking like it ignored the press.

## "Redémarrage requis" — an advance warning, not a post-mortem

`KanbanTask.needsDaemonRestart` is resolved **automatically the moment a card
reaches "Terminé"**, so the user knows _before_ publishing whether the work will
only take effect after a daemon restart — instead of discovering it afterwards.

- **How.** `moveTask` fires a best-effort resolver (wired at bootstrap to
  `resolveDaemonRestartImpact`) against the files the next publication will carry
  (`getPendingDeployFiles` — the diff from `.deployed-sha` plus the working tree).
  `needsDaemonRestartForFiles` (pure, unit-tested) answers yes for anything under
  `DAEMON_CODE_PATHS` — deliberately the SAME list the "engine is behind" counter
  uses, so the pre-publication warning and the post-publication debt can never
  disagree. That covers `server`/`protocol`/`relay`/`highlight` plus `cli` (the
  daemon is launched through the CLI entry point); app/website/desktop work and
  tests/markdown answer no. **Only Paseo's own checkout can require one**: a
  client project's work never touches the Paseo daemon, so it resolves to `false`.
- **Never a guess.** An unresolved verdict (`null`: git unavailable, no baseline)
  leaves whatever the card already carried, so a flag an agent set by hand is
  never wiped.
- **Not on the card any more.** The badge slot now answers a more useful question:
  what the NEXT publication will do with this card. `getPublishNotice` renders a
  quiet green "Partira à la prochaine publication" on every finished card — true
  because the run sweeps them in — or an amber "Retirée du prochain lot" when the
  user held it back. The restart wording is gone from it: a publication restarts
  the engine every time, so "Redémarrage requis" no longer distinguished anything,
  while a finished card shipping without notice genuinely surprised people. The
  notice rides the card for the whole wait and **disappears once the work is live**
  (a stamped `deployedAt` / `deployedUrl`).
- **On the board.** `PendingPublishSummary` sits above the columns (same gutter
  rule as the billable total) with one line — "3 cartes prêtes à publier" — so the
  pending volume reads without opening a card. Archived cards are excluded and the
  line hides entirely when nothing is pending. It used to add "dont 1 nécessitant
  un redémarrage"; `countPendingPublish` dropped that half for the same reason.

### Finishing the job — the restart itself

- **On the card.** Once the work IS live and needed a restart, the card offers a
  "Redémarrer le moteur" bar (`offersDaemonRestart` → `RestartDaemonBar`), taking
  the composer slot ahead of the archive bar: publish → restart → archive, with
  no terminal in between. It reuses the existing `restart_server` RPC (the same
  gesture as Settings → host), so nothing new was added to the protocol.
  **It always confirms first, and says how many agents the restart will cut** —
  the daemon is only ever restarted on an explicit, informed go.
- **The undo window.** Pressing the bar does NOT fire the request: it arms it for
  a few seconds, during which the bar itself becomes "Annuler (3 s)". The seconds
  right after saying yes are exactly when people change their mind, and a restart
  cuts every running agent. Past that window the request goes out and the button
  is unpressable — offering "Annuler" there would be a button that cannot keep its
  promise.
- **The countdown.** Once sent, the bar counts down ("Reconnexion dans 7 s…"),
  then falls back to a quiet "Reconnexion…" past the estimate and to "Le moteur
  n'est pas revenu" past a minute. The wording rule (`describeRestartProgress`,
  `restartProgressLabel`) is pure and unit-tested, and **shared with the settings
  host page** so a restart says the same thing wherever it was started from.
  Reconnection is only believed once the connection has been seen to **drop and
  come back**: the old socket survives the request by a moment, so a naive
  "connected?" check would end the countdown before the daemon had even stopped.
- **Interrupted agents pick their work back up.** The agents mid-turn are captured
  _before_ the request goes out (once the daemon is down, nobody can be asked),
  and each gets a message when it returns. Deliberately **not** a replay of the
  original prompt — re-sending "commit and push" to an agent that had already
  committed is how work gets done twice. `buildRestartResumePrompt` names the
  objective from the agent's own synthesis and asks it to check what is already
  done before continuing.
- **One gesture, not two.** On a card that will need a restart, the deploy
  confirmation offers a third door — "Publier puis redémarrer". Choosing it arms
  `restartAfterDeployTaskId`; `DeployRestartChain` fires the restart the instant
  that card's work is live, **without asking again** (one decision, already made
  — it still opens its undo window). The choice is remembered
  (`preferDeployThenRestart`) and becomes the highlighted default next time; both
  doors always stay on screen, so a habit can never railroad a one-off.
- **The debt is settled at boot.** A daemon that has just started IS running the
  current code, so `settleRestartFlags` clears `needsDaemonRestart` on every card
  whose work is already live (per project, at bootstrap). Without it the flag was
  permanent: a shipped card kept offering "Redémarrer le moteur" forever, and the
  "Archiver" bar it shares that slot with could never be reached again. Cards not
  yet published keep their flag — that one is a forecast about the NEXT
  publication, which this boot says nothing about. It reads before it writes:
  `store.mutate` persists unconditionally, so going straight to it would create a
  board file (and push a board update) for every project with no cards at all.
- **One owner for all of it.** `DaemonRestartWatcher` is mounted exactly once at
  the **app root** (`DaemonRestartHost`, which mounts nothing while idle) and owns
  the clock, the arming→send transition, the reconnection detection, the timeout
  and the agent resumes; `useDaemonRestartStore` holds the state, including which
  host is being restarted. App-root, not screen-level: a restart started from a
  card must keep running when the user walks off to another screen. Putting those
  effects in the shared hook would give every mounted reader its own timer and its
  own "moteur redémarré" toast.
- **The reminder.** `DaemonRestartReminder` polls the daemon's restart debt
  (`getDaemonRestartDebt`: daemon-side commits since the boot SHA) and, if
  published work stays dormant past a two-hour grace period, sends **one** push
  per HEAD. The decision rule (`decideRestartReminder`) is pure and unit-tested:
  a new HEAD restarts the countdown, a restart clears the state so the next
  publication gets its own reminder, and an unreadable debt never nags. It only
  ever notifies — it never restarts anything.

## Archiving a card — hide, never publish

A finished card (in "Terminé" or "À déployer") can be **archived** by hand from
the "Archiver" bar above its prompt. Archiving is deliberately **orthogonal to
the seven columns**: it does not move the card and does not publish it. It only
sets an optional `archivedAt` stamp and the board **hides** the card from view —
which also drops it out of the next batch (`selectPendingDeployTasks` skips
archived cards), so filing a card away is a way to say "not this one".

Two behaviours were considered:

- **(a) a manual `Terminé → Déployé` shortcut** — force publication when the
  automatic path does not apply.
- **(b) hide the card from the board** — remove it from view without publishing.

We chose **(b)**. Archiving is a filing gesture, not a publishing one: the user
is saying "I'm done looking at this", not "put this live". Publication has its
own explicit button ("Tout déployer"), so an archive that also published would
either double the work or race it. Keeping archive purely additive means it can
never break invariant 4 below.

The mechanics:

- `archivedAt` is an **optional, additive** field on the task (old boards/clients
  simply omit it). Setting it never changes the card's `column`, so the pipeline
  and the scheduler keep seeing the card exactly as before.
- The **board hides** archived cards on the display side; the daemon still stores
  them, so a future "archived" view can list and un-archive them. Nothing on the
  server drops an archived task from the pipeline.
- The bar is offered **only** in "Terminé"/"À déployer" — the two terminal columns —
  because archiving mid-flight would hide live work.

### An archived card closes its conversation

Both doors into the archive — the manual `archivedAt` hide above, and the
automatic move into the terminal `archived` column once a card's work went live
(`markTaskDeployed`) — fire `TaskBoardService.setOnTaskArchived`. Bootstrap wires
that to `TaskSessionCloser` (`tasks/session-closer.ts`), which **archives the
card's agent**. Nothing else: archiving the agent is the single lever that closes
the tab, because the app's tab reconciler already drops agent tabs whose agent
left the active set. There is deliberately no second "close this tab" channel —
one would be a new resurrection race.

Four things the closer gets right, each of which was a bug waiting to happen:

- **Not every agent on a card belongs to it.** `primaryAgentId` and `agentIds` can
  hold the agent that merely PROPOSED the card — the conductor, message triage,
  an agent whose todo list minted it — and each of those holds a live
  conversation of its own. Closing one would shut the conductor's chat the moment
  a card it created got archived. `ownsTask` therefore demands proof: the agent
  carries this card's `paseo.task-id` label (stamped by the provisioner and the
  scheduler), or the card names it as `taskAgentId`. Anything unproven is left
  alone — a stale tab costs a click, someone else's closed conversation costs
  their work.
- **A running agent is never cut off.** Its archive waits on `watchAgentIdle`, the
  same watcher the deploy path uses. A card hidden by hand while its last reply
  streams keeps that reply.
- **Agents this daemon never resumed still get closed.** A card's agent survives
  restarts as a stored record that clients keep listing (and keep a tab for), so
  the closer falls back to `archiveSnapshot` on the record. Boot runs
  `sweepArchivedTasks` per project to catch up on everything archived before this
  existed.
- **A pinned tab loses to the archive.** `applyPinnedAndHidden` used to re-add any
  pinned agent still present in `knownAgentIds` — and archived agents stay in
  `knownAgentIds` — so the tab of a card the user had opened themselves never
  closed. The reconcile snapshot now carries `archivedAgentIds`, and archiving
  beats the pin. `reconcileTabs` also tombstones what it closes (see
  `session-ui-state/close-tombstones`), so a host snapshot captured before the
  archive cannot reopen the tab at the next reconnect.

The card's **terminals** go with its conversation. A terminal knows its cwd and
its workspace, never who asked for it — and a card runs in the project's main
checkout alongside everything else, so "the terminals of this workspace" is far
too wide a net. The only honest link is the gesture: the agent called
`create_terminal`, and that call records the owner in `AgentTerminalRegistry`
(`agent/agent-terminal-registry.ts`, wired through the tool catalog's
`onAgentTerminalCreated`). The closer claims that list when it archives the
agent, and:

- kills each terminal **after** the conversation is closed, never before — a
  terminal cut while its agent still runs takes unfinished work with it;
- **leaves a terminal that reports `working` open**, and releases it from the
  card's ownership. A build or a dev server the user is watching must not die
  because a card was filed away;
- is in-memory and daemon-local on purpose: terminals do not survive a daemon
  restart, so a mapping that did would only point at terminals that no longer
  exist.

## The other exception

A publish blocked by a merge conflict opens a repair task and validates it
itself (`bootstrap.ts`, the deploy-conflict task creator). The publish being
unblocked is the consent, and the repair exists only to let it through. It is
the sole place in the daemon that moves a card into "Validé" on the user's
behalf — keep it that way.

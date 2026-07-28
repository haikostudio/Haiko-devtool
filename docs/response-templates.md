# Response templates — one fixed answer shape per board column

Single reference for the shape every agent answer takes. The shape is **imposed
by the daemon, never chosen by the agent**: on every prompt dispatch the
AgentManager wraps the text in a `<paseo-format>…</paseo-format>` envelope
carrying one of the templates below.

- Bodies: `packages/server/src/services/response-format.ts`
- Column → template map: `packages/server/src/server/tasks/response-template.ts`
- Injection point: `AgentManager.applyBrainRecall` (same choke point as the
  Cerveau recall, so every entrypoint is covered — chat, MCP, schedules, loops,
  task launches)
- Wiring: `bootstrap.ts` → `agentManager.setResponseFormatTemplateHook(...)`

## Why per-column

A card's answer means a different thing depending on where the card sits:

- in **Validé**, nothing has run yet — a "Ce qui est fait" section would be a lie;
- in **En cours**, the answer is a work report, and its evolutions are meant to
  be clickable;
- in **Déployé**, the answer is a publication log — billing and next steps
  belong elsewhere.

One template for all three produced answers that padded an analysis with fake
"impact" sections and closed a deployment log with an invoice line.

## The templates

| Template      | When                                                                  | Sections                                                                                                        |
| ------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `analysis`    | card in **Validé** or **Planifié**                                    | 1. Objectif · 2. Approche retenue · 3. Fichiers & points de vigilance · 4. Estimation                           |
| `progress`    | card in **En cours**, **Terminée** or queued in **À déployer**        | 1. Ce qui est fait · 2. Ce qui change · 3. Impact · 4. Évolutions possibles                                     |
| `publication` | work already live (`deployedAt`/URL), or a deploy in flight           | 1. Ce qui a été publié · 2. Déroulé de la publication · 3. Vérification · 4. Suites éventuelles                 |
| `conductor`   | the board's chef d'orchestre agent                                    | none — it never executes anything, so it never reports (see `conductor-agent.ts`)                               |
| `default`     | anything that is not a card (plain chat, schedules, MCP, **backlog**) | the historical five: Ce qui est fait · Ce qui change · Impact · Évolutions possibles · Activation & facturation |

Exclusions are stated in the templates themselves, not merely implied:

- `analysis` bans "Ce qui est fait", "Ce qui change", "Impact", "Évolutions
  possibles" and "Activation & facturation";
- `progress` bans "Activation & facturation", analysis and estimates;
- `publication` bans analysis, estimates, billing and evolutions.

## Rules that apply to every template

- Headings stay numbered `## N.` — **the app adds the icons**
  (`components/markdown/section-icons.ts`), the agent never writes one.
- French, plain language, non-technical reader; no file paths unless asked.
- A one-line header before the sections: model, level, estimated time, cost at
  130 CHF/h.
- Coloured callouts (`> [!TIP]`, `> [!NOTE]`, …) only where they genuinely help.

Adding a section title? Add its keyword to `section-icons.ts`, or it renders
without an icon (`section-icons.test.ts` covers every template's headings).

## The "+" button on evolutions

In the `progress` template, each line of "Évolutions possibles" carries a `+`
button that drops that line into the composer (and a second button that turns it
into a backlog card). The chain, in the app:

1. `splitMarkdownBlocks` cuts the answer on blank lines;
2. `splitBlocksAtHeadings` re-cuts so a heading **always** opens a block — this
   is what makes a dense answer (no blank lines around its titles) work;
3. `flagEvolutionBlocks` flags the blocks belonging to the section;
4. `normalizeEvolutionBlock` rewrites every plain line of those blocks as a list
   item — bullets, numbered items, bold lines and bare sentences all end up
   actionable, and the renderer keeps a single rule;
5. the renderer's `list_item` rule renders `EvolutionListItem`, which carries the
   buttons.

Left untouched by step 4: headings, code fences, table rows, quotes/callouts and
indented continuations.

Pressing `+` marks the line as taken: it is struck through and faded to 50%, so
a long list of proposals shows at a glance which ones already went to the
composer. The struck line is redrawn as a single plain `Text` — `line-through`
does not travel down to sibling `Text` nodes inside a `View` on native.

The prompt side helps the render side: the `progress` template asks for **one
self-contained proposal per line**, no sub-lists, no free paragraphs — a line
inserted into the composer has to read as a standalone instruction.

Coverage: `packages/app/src/utils/evolution-section.test.ts` walks every
formatting variant through the chain and asserts each proposal comes out
actionable.

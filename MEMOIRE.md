# Mémoire du projet

Faits durables sur ce projet, tenus par les agents eux-mêmes. Une ligne courte
par fait. On n'y met PAS ce que le code, les tests ou l'historique git disent
déjà, ni ce qui ne vaut que pour une conversation. Une ligne devenue fausse se
supprime, elle ne se contredit pas. Objectif : moins de cent lignes.

Ce fichier est injecté une fois par agent, au premier message, par la synchro
d'état du projet — d'où l'exigence de brièveté.

## Décisions structurantes

- La mémoire longue durée externe (« Cerveau ») a été retirée : elle coûtait
  deux appels de modèle et plusieurs milliers de jetons par message. Ce fichier
  la remplace, à coût nul.
- La publication ne reconstruit que ce qui a changé (site et moteur séparément).
  Au moindre doute — repère absent, chemin non classé — elle reconstruit tout.
- Le redémarrage du moteur après publication dépend d'un fait posé sur le
  disque par le script (un dist a-t-il été installé ?), jamais d'une déduction
  sur les chemins modifiés. Cette nuance a déjà coûté des correctifs fantômes.
- Les consignes envoyées aux agents ont un budget de longueur explicite. Toute
  phrase ajoutée est payée à chaque message, pour toujours.
- Le tableau se déplace à la main. Trois exceptions seulement, et « Validé »
  reste le geste par lequel l'utilisateur autorise la dépense de quota.
- Chaque carte s'exécute dans SON worktree isolé + branche `task/<id>-<slug>`
  (modèle GitHub) : les cartes d'un même projet tournent en parallèle, et une
  carte terminée-non-déployée ne bloque plus rien. Deux exceptions restent « en
  place » sur le checkout partagé : Paseo lui-même (isSelf) et le mode plan.
  Le verrou « une autre tâche occupe le dossier » ne vaut donc plus que pour ces
  cartes en place. La publication groupée fusionne la branche de chaque carte,
  signale (sans casser le lot) une carte en conflit, et supprime les branches
  fusionnées.

## Pièges connus

- Le démon exécute `packages/*/dist`, pas la source : un correctif serveur reste
  sans effet tant que le moteur n'a pas été reconstruit ET redémarré.
- `/root/paseo` est un checkout partagé : plusieurs agents y écrivent en même
  temps. La publication travaille donc sur une copie figée du commit à publier.
- `version.json` porte la version DU BUNDLE, jamais celle de la publication.
  Les faire diverger déclenche la bannière « nouvelle version » en boucle.
- Paseo n'a pas d'instance de développement testable : la seule façon d'essayer
  une modification serveur est de la publier.

## Préférences de l'utilisateur

- Enregistrer et sauvegarder toujours (commit + push), publier jamais sans son
  accord : les changements doivent apparaître en attente dans sa fenêtre.
- Ne jamais redémarrer le démon du port 6767 sans accord explicite.
- Réponses en français simple, pour un lecteur non technique : pas de jargon,
  pas de chemins de fichiers, pas de pavés.
- Économiser le quota est un objectif permanent, pas une optimisation ponctuelle.
- Chef d'orchestre tourne sur `claude-sonnet-5` ou `gpt-5.4-mini` — jamais Haiku
  (ni un id inventé type "-20251001" : toujours vérifier list_models avant de
  fixer un runConfig). À la création d'une carte, il DOIT déjà assigner le
  modèle réel que la tâche utilisera (ex. `claude-opus-4-8` pour du code exigeant
  des compétences, `claude-sonnet-5`/`gpt-5.4` sinon) — la tâche hérite de ce
  choix, pas question de laisser le défaut du chef d'orchestre s'appliquer.
- Défauts de l'AGENT « chef d'orchestre » (celui qui gère le tableau, pas le
  runConfig des cartes) fixés dans conductor-agent.ts : Sonnet 5 medium (Claude),
  gpt-5.6-luna medium (Codex). Le client (tasks-board-ui-store.ts) envoie
  toujours l'id de provider NU ("claude"/"codex"), jamais un modèle en dur —
  sinon le client impose le modèle et le défaut serveur ne s'applique jamais
  (bug vécu : bascule Codex chargeait gpt-5.4 car le client l'envoyait tel quel).
  Un chef d'orchestre déjà créé avant ce correctif garde son ancien modèle tant
  qu'on ne clique pas « Réinitialiser » (le niveau de réflexion, lui, se corrige
  seul au prochain chargement s'il n'était pas explicitement choisi).
- Sur le dépôt Paseo lui-même (isSelf), le chef d'orchestre est un agent complet
  qui code : il démarre sur Opus 5 « high » (Claude) / gpt-5.6-sol « high »
  (Codex), pas sur les défauts gestionnaire de tableau des autres projets. Le
  modèle/niveau dépend donc de isSelf (comme déjà le prompt et les permissions).
  Sur Paseo, les pins gestionnaire fuités (sonnet-5 / luna, effort medium) d'un
  chef créé avant isSelf sont FORCÉS vers le modèle frontière au rechargement
  (comme l'alias legacy) : il se remet à niveau seul, sans « Réinitialiser ».
  Ailleurs, la règle reste « ne remplir que le vide, un choix explicite l'emporte ».

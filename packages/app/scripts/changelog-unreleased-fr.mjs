// One-time French backfill for the auto-synthesized "Unreleased" changelog section.
// Keys are the exact English commit-derived bullet strings; values are French.
// COMPAT(changelog-fr-backfill): transitional — entries drop out once the work ships
// into a dated release (which is authored in French directly). Safe to prune unused keys.
export const UNRELEASED_FR = {
  // Added
  "Add task-schedule module required by tasks screen":
    "Ajout du module de planification requis par l'écran des tâches",
  "Move new-workspace to a + button in the Workspaces header":
    "Nouvel espace de travail déplacé vers un bouton + dans l'en-tête des espaces",
  "Full-width compact view tabs with header spacing":
    "Onglets pleine largeur en vue compacte avec espacement de l'en-tête",
  "Inline primary actions in mobile sidebar":
    "Actions principales intégrées dans la barre latérale mobile",
  "Folder nav in the board header + fixed full-width new-folder footer":
    "Navigation par dossier dans l'en-tête du tableau + pied de page « nouveau dossier » pleine largeur fixe",
  "Include daemon version in logs (#2155)": "Version du démon incluse dans les journaux (#2155)",
  "Declutter kanban cards — hide priority boilerplate, single meta line, cap tags":
    "Cartes kanban épurées — priorité masquée, une seule ligne d'infos, étiquettes limitées",
  "Steer replies toward simple, playful, non-technical tone":
    "Réponses orientées vers un ton simple, léger et non technique",
  'Add "Validated" column as the analysis/execution gate':
    "Ajout de la colonne « Validé » comme filtre entre analyse et exécution",
  "Migrate existing projects and worktrees": "Migration des projets et worktrees existants",
  "Restore recent chat while reconnecting (#2206)":
    "Conversation récente restaurée pendant la reconnexion (#2206)",
  "Connect daemons to Hub through browser approval":
    "Connexion des démons au Hub via approbation dans le navigateur",
  "Per-card overflow menu to launch or re-analyze a task from the board":
    "Menu par carte pour lancer ou réanalyser une tâche depuis le tableau",
  "Instant in-chat feedback when sending a prompt":
    "Retour immédiat dans la conversation à l'envoi d'un message",
  "Project rail counts + visible search field":
    "Compteurs dans la colonne des projets + champ de recherche visible",
  "Floating task badge + drawer for agent toasts":
    "Badge de tâche flottant + tiroir pour les notifications des agents",
  "Structured recall pill + startup/emit diagnostics":
    "Pastille de rappel structurée + diagnostics de démarrage et d'émission",
  "Redesign the tasks board — pastel columns, soft chips, real timeline":
    "Refonte du tableau des tâches — colonnes pastel, pastilles douces, vraie chronologie",
  "Edit priority and deadline as dedicated fields in the task sheet":
    "Priorité et échéance éditables comme champs dédiés dans la fiche de tâche",
  "Show real app in homepage hero":
    "Vraie application affichée dans l'en-tête de la page d'accueil",
  "Drive task concurrency by quota budget, not a fixed count":
    "Nombre de tâches simultanées piloté par le budget de quota, plus par un chiffre fixe",
  "Autopilot folders, per-task worktrees, backlog estimation, quota packing":
    "Dossiers en autopilote, worktrees par tâche, estimation du backlog, optimisation du quota",
  "Hide provider-internal subagent rows from the track":
    "Masquage des sous-agents internes du fournisseur dans le suivi",
  "Triage tray pinned above the composer, chat-styled and fully editable":
    "Bac de triage épinglé au-dessus de la zone de saisie, style conversation et entièrement éditable",
  "Redesign triage carousel — violet block, dots, full field set":
    "Refonte du carrousel de triage — bloc violet, points, ensemble complet de champs",
  "Show the tasks timeline on the mobile project screen":
    "Chronologie des tâches affichée sur l'écran projet mobile",
  "Always show the Cerveau pill, even on empty recall":
    "Pastille Cerveau toujours affichée, même sans rappel",
  "Recall Cerveau on every prompt (drop substance gate)":
    "Rappel Cerveau à chaque message (suppression du filtre de pertinence)",
  "In-chat approval carousel for triage-proposed tasks":
    "Carrousel d'approbation dans la conversation pour les tâches proposées au triage",
  "Project-colored Gantt timeline above the kanban board":
    "Chronologie Gantt aux couleurs du projet au-dessus du tableau kanban",
  "Exact model + reasoning, dual cost, run in current workspace":
    "Modèle et raisonnement exacts, double coût, exécution dans l'espace de travail courant",
  "Tighter dashboard stats padding on compact screens":
    "Marges resserrées des statistiques du tableau de bord sur écrans compacts",
  "Taller activity bar with a percentage in every slice":
    "Barre d'activité plus haute avec un pourcentage dans chaque segment",
  "Multi-select project filter + percentages on the activity bar":
    "Filtre de projets multi-sélection + pourcentages sur la barre d'activité",
  "Single stacked project bar + colored project tags on Activity":
    "Barre de projets empilée unique + étiquettes de projet colorées dans Activité",
  "Deterministic per-interaction synthesis banner (no LLM)":
    "Bannière de synthèse déterministe par interaction (sans LLM)",
  "Colored per-project activity chart on the Activity screen":
    "Graphique d'activité coloré par projet sur l'écran Activité",
  "Task board — folder/task counts, priority flags, deadlines, project search":
    "Tableau des tâches — compteurs de dossiers/tâches, drapeaux de priorité, échéances, recherche de projet",
  "Global activity log — one line per agent per turn":
    "Journal d'activité global — une ligne par agent et par tour",
  "Plain-language end-of-turn recap block + colored callouts":
    "Bloc de récapitulatif de fin de tour en langage simple + encadrés colorés",
  "Brain memory curation — librarian filter, project fiche, scribe distillation":
    "Curation de la mémoire du Cerveau — filtre bibliothécaire, fiche projet, distillation par le greffier",
  "Running conversation-synthesis thread, content-width banner":
    "Fil de synthèse de conversation en continu, bannière à la largeur du contenu",
  "Inline LLM task-intent triage from chat messages":
    "Triage d'intention de tâche par LLM directement depuis les messages de la conversation",
  "Show project name + request duration in every task toast":
    "Nom du projet + durée de la requête affichés dans chaque notification de tâche",
  "Per-task run config, approval gate, quiet-hours scheduling, MCP task tools":
    "Configuration d'exécution par tâche, filtre d'approbation, planification en heures calmes, outils de tâche MCP",
  "Floating conversation-synthesis block per agent":
    "Bloc de synthèse de conversation flottant par agent",
  "Replace pulsing toast border with a colored status dot + running timer":
    "Bordure clignotante de la notification remplacée par un point de statut coloré + minuteur en cours",
  "Auto-sort task toasts by lifecycle + show project/time when done":
    "Tri automatique des notifications de tâche par état + affichage du projet et de l'heure à la fin",
  "Loop-free cross-device sync of draft agent config":
    "Synchronisation sans boucle de la config d'agent en brouillon entre appareils",
  "Highlight sidebar resize handles":
    "Poignées de redimensionnement de la barre latérale mises en évidence",
  "Auto-refresh changelog snapshot on every commit":
    "Rafraîchissement automatique du journal des modifications à chaque commit",
  "Folder card kebab menu to edit or delete a task folder":
    "Menu de la carte dossier pour modifier ou supprimer un dossier de tâches",
  "Import existing project setup": "Import de la configuration d'un projet existant",
  "Pluggable forge abstraction + GitLab and Gitea/Forgejo/Codeberg (#1913)":
    "Abstraction de forge modulaire + GitLab et Gitea/Forgejo/Codeberg (#1913)",
  "Diffuse radar ping + full-height magic scrollbar rail":
    "Ping radar diffus + rail pleine hauteur de la barre de défilement magique",
  "Pulsing amber/green border on agent task toasts":
    "Bordure clignotante ambre/verte sur les notifications de tâche des agents",
  "Re-derive workspace title from each user message":
    "Titre de l'espace de travail redérivé à partir de chaque message utilisateur",
  "In-app changelog page with releases + commits tabs":
    "Page des nouveautés intégrée avec onglets versions et commits",
  "Active dot with radar ping on the magic scrollbar":
    "Point actif avec ping radar sur la barre de défilement magique",
  "Magic scrollbar on the agent conversation":
    "Barre de défilement magique sur la conversation de l'agent",
  "Folder creation modal with colors, inline ticket drafts on the board":
    "Fenêtre de création de dossier avec couleurs, brouillons de tickets intégrés au tableau",

  // Improved
  "Remove unused websocket close codes": "Suppression des codes de fermeture websocket inutilisés",
  "Reuse client heartbeat for socket liveness":
    "Réutilisation du battement client pour vérifier la vivacité de la socket",
  "Make project imports pluggable": "Imports de projet rendus modulaires",

  // Fixed
  "Show workspace kebab on compact in the real project list":
    "Menu de l'espace de travail affiché en mode compact dans la vraie liste des projets",
  "Tighten padding in the agent Options sheet":
    "Marges resserrées dans la fiche Options de l'agent",
  "Always show workspace row kebab on compact web PWA":
    "Menu de la ligne d'espace de travail toujours affiché en PWA web compacte",
  "Align thinking section scroll layout with other detail sections (#1884)":
    "Alignement du défilement de la section réflexion sur les autres sections de détail (#1884)",
  "Keep message input visible after dictation (#2194)":
    "Champ de saisie maintenu visible après la dictée (#2194)",
  "Stop phantom parent subagents (#2214)": "Suppression des sous-agents parents fantômes (#2214)",
  "Drawer owns its bottom safe-area so PWA cards clear the home indicator":
    "Le tiroir gère sa propre zone de sécurité basse afin que les cartes PWA évitent l'indicateur d'accueil",
  "NFC-normalize tags so priority/deadline stop leaking as raw chips":
    "Normalisation NFC des étiquettes pour que priorité et échéance ne fuitent plus en pastilles brutes",
  "Task drawer badge headroom + bottom safe-area fallback":
    "Espace pour le badge du tiroir de tâche + repli sur la zone de sécurité basse",
  "Stop flagging direct agent feedback + explain the questions pill":
    "Fin du signalement des retours directs de l'agent + explication de la pastille de questions",
  "Authorize active workspace config": "Autorisation de la config de l'espace de travail actif",
  "Reject nested command substitutions": "Rejet des substitutions de commandes imbriquées",
  "Refresh managed checkout config": "Rafraîchissement de la config de checkout gérée",
  "Preserve adopted workspace config": "Préservation de la config de l'espace de travail adopté",
  "Validate source refs and expansions": "Validation des références de source et des expansions",
  "Preserve direct port arithmetic": "Préservation du calcul direct des ports",
  "Release workspace watchers on shutdown":
    "Libération des observateurs d'espace de travail à l'extinction",
  "Normalize checkout branch refs": "Normalisation des références de branche de checkout",
  "Validate live source state": "Validation de l'état de source en direct",
  "Share service command semantics": "Partage de la sémantique des commandes de service",
  "Normalize source references": "Normalisation des références de source",
  "Preserve Windows shell semantics": "Préservation de la sémantique du shell Windows",
  "Preserve consistent source state": "Préservation d'un état de source cohérent",
  "Gate automatic source discovery": "Encadrement de la découverte automatique des sources",
  "Validate workspace connection targets":
    "Validation des cibles de connexion des espaces de travail",
  "Preserve source command semantics": "Préservation de la sémantique des commandes de source",
  "Preserve checkout and shell semantics": "Préservation de la sémantique de checkout et de shell",
  "Harden Hub approval transport": "Renforcement du transport d'approbation du Hub",
  "Flush migration output before completion": "Vidage de la sortie de migration avant l'achèvement",
  "Restrict Hub activation URLs": "Restriction des URL d'activation du Hub",
  "Bound Hub registration startup": "Limitation du démarrage de l'enregistrement au Hub",
  "Keep Hub approval polling within expiry":
    "Interrogation d'approbation du Hub maintenue dans le délai d'expiration",
  "Raise task badge above the composer": "Badge de tâche remonté au-dessus de la zone de saisie",
  "Neutral gray board, grayscale timeline, tighter mobile spacing":
    "Tableau gris neutre, chronologie en niveaux de gris, espacement mobile resserré",
  "Mobile timeline tab + fix Gantt axis label overlap":
    "Onglet chronologie mobile + correction du chevauchement des libellés d'axe Gantt",
  "Highlight changes that apply next turn (#2201)":
    "Mise en évidence des changements qui s'appliquent au prochain tour (#2201)",
  "Keep queued follow-ups visible until the daemon confirms delivery":
    "Messages en file maintenus visibles jusqu'à ce que le démon confirme leur envoi",
  "Preserve persisted theme styles after startup":
    "Préservation des styles de thème enregistrés après le démarrage",
  "Always show user-message actions, not just on hover":
    "Actions des messages utilisateur toujours affichées, pas seulement au survol",
  "Never drop a queued follow-up when the client is unavailable":
    "Aucun message en file abandonné lorsque le client est indisponible",
  "Always show message timestamps and turn completion time":
    "Horodatage des messages et heure de fin de tour toujours affichés",
  'Accept thinkingLevel "max" when importing OMP sessions (#2191)':
    "Prise en charge du niveau de réflexion « max » à l'import des sessions OMP (#2191)",
  "Remove wall-clock timeout for Pi compact RPC (#2181)":
    "Suppression du délai d'expiration réel pour le RPC compact de Pi (#2181)",
  "Make bottom-sheet rows and sections much tighter":
    "Lignes et sections des feuilles bien plus resserrées",
  "Stop stale UI-state snapshots resurrecting empty draft tabs":
    "Fin de la résurrection d'onglets brouillons vides par d'anciens instantanés d'interface",
  "Tighten bottom-sheet padding and row heights":
    "Marges des feuilles et hauteurs de lignes resserrées",
  "Show backlog tasks in the tasks timeline too":
    "Tâches du backlog affichées aussi dans la chronologie des tâches",
  "Update lockfile signatures and Nix hash [skip ci]":
    "Mise à jour des signatures du lockfile et du hash Nix [skip ci]",
  "Fall back to inline read when binary file transfer stalls":
    "Repli sur une lecture intégrée quand le transfert de fichier binaire bloque",
  "Alias/family-tolerant project matching (mirror of Cerveau scope resolution)":
    "Correspondance de projet tolérante aux alias et familles (miroir de la résolution de portée du Cerveau)",
  "Align the tasks timeline strip with the kanban columns":
    "Alignement de la bande chronologique des tâches avec les colonnes kanban",
  "Stop stale sync snapshots from spawning a second tab after draft submit":
    "Fin de la création d'un second onglet par d'anciens instantanés de synchronisation après l'envoi d'un brouillon",
  "Show user-sent images on every client, not just the sender":
    "Images envoyées par l'utilisateur affichées sur tous les clients, pas seulement l'émetteur",
  "Keep new-agent draft focused after submit":
    "Brouillon de nouvel agent maintenu focalisé après l'envoi",
  "Reuse existing workspace for external/internal agent creation":
    "Réutilisation de l'espace de travail existant pour la création d'agents externes/internes",
  "Enforce one-workspace-per-directory invariant at the registry":
    "Application de la règle un espace de travail par dossier au niveau du registre",
  "Enforce one workspace per directory at creation chokepoint":
    "Application d'un espace de travail par dossier au point de création",
  "Collapse local workspace create to one-per-directory":
    "Création d'espace de travail local ramenée à un par dossier",
  "Activity filter chips rendered as full-height capsules":
    "Pastilles de filtre d'activité rendues en capsules pleine hauteur",
  "Stack synthesis banner labels above values, add separator":
    "Libellés de la bannière de synthèse empilés au-dessus des valeurs, ajout d'un séparateur",
  "Give the attachment thumbnail image an explicit plain-object size":
    "Taille explicite en objet simple donnée à la vignette de la pièce jointe",
  "Tighten relay backpressure accounting": "Comptabilité de contre-pression du relais resserrée",
  "Bound stale websocket connections": "Limitation des connexions websocket obsolètes",
  "Stop syncing active-agent composer drafts (broke image send)":
    "Fin de la synchronisation des brouillons de saisie de l'agent actif (cassait l'envoi d'images)",
  "Keep composer-held attachment blobs from being garbage collected":
    "Blobs de pièces jointes retenus dans la zone de saisie protégés du ramasse-miettes",
  "Reject imported port offsets": "Rejet des décalages de port importés",
  "Refresh import availability previews": "Rafraîchissement des aperçus de disponibilité d'import",
  "Expose remaining import errors": "Exposition des erreurs d'import restantes",
  "Tighten conductor service imports": "Resserrement des imports du service conductor",
  "Preserve conductor migration context": "Préservation du contexte de migration conductor",
  "Report remaining import gaps": "Signalement des lacunes d'import restantes",
  "Inset transcript below the floating synthesis banner":
    "Transcription décalée sous la bannière de synthèse flottante",
  "Stop pasted image being cleared by a stale draft tombstone":
    "Image collée protégée de l'effacement par un ancien marqueur de brouillon",
  "Wait for import preview before setup callout":
    "Attente de l'aperçu d'import avant l'encadré de configuration",
  "Keep project imports current and complete": "Imports de projet maintenus à jour et complets",
  "Give release builds more memory": "Davantage de mémoire allouée aux builds de release",
  "Handle remaining import edge cases": "Prise en charge des cas limites d'import restants",
  "Close project import edge cases": "Fermeture des cas limites d'import de projet",
  "Harden conductor imports": "Renforcement des imports conductor",
  "Straddle toast status dot over the top-left corner":
    "Point de statut de la notification chevauchant le coin supérieur gauche",
  "Pin toast status dot to the top-left corner":
    "Point de statut de la notification épinglé au coin supérieur gauche",
  "Render attachment thumbnails with expo-image":
    "Vignettes des pièces jointes rendues avec expo-image",
  "Update provider icon": "Mise à jour de l'icône du fournisseur",
  "Propagate draft clear/send to other devices":
    "Propagation de l'effacement/envoi du brouillon aux autres appareils",
  "Fix draft image race + sync active-agent composer content":
    "Correction de la course sur l'image en brouillon + synchronisation du contenu de saisie de l'agent actif",
  "Bound magic scrollbar above the composer on mobile":
    "Barre de défilement magique bornée au-dessus de la zone de saisie sur mobile",
  "Make sidebar reordering respond immediately":
    "Réorganisation de la barre latérale rendue immédiatement réactive",
  "Revert live draft-config sync that caused a cross-device loop":
    "Retour arrière sur la synchro en direct de la config brouillon qui provoquait une boucle entre appareils",
  "Apply materialized image attachments to a focused composer":
    "Application des pièces jointes image matérialisées à une zone de saisie focalisée",
  "Refresh stale config import apply":
    "Rafraîchissement de l'application d'import de config obsolète",
  "Normalize conductor import paths": "Normalisation des chemins d'import conductor",
  "Rappel Cerveau projet-d'abord + complément global + procédures":
    "Rappel Cerveau axé projet en priorité + complément global + procédures",
  "Apply remote draft agent config to an open composer":
    "Application de la config d'agent brouillon distante à une zone de saisie ouverte",
  "Live-adopt remote draft text into an open composer":
    "Adoption en direct du texte brouillon distant dans une zone de saisie ouverte",
  "Sync draft composer text + agent config across devices":
    "Synchronisation du texte de saisie brouillon + config d'agent entre appareils",
  "Shift task toasts left so the magic scrollbar stays visible":
    "Notifications de tâche décalées à gauche pour que la barre de défilement magique reste visible",
  "Kanban drag-and-drop everywhere + full-width cards":
    "Glisser-déposer kanban partout + cartes pleine largeur",
  "Tasks board + sheet layout on compact/mobile web":
    "Mise en page du tableau et de la fiche des tâches en web compact/mobile",
  "Stop raw <contexte_memoire> blocks leaking into replayed user messages":
    "Fin de la fuite des blocs bruts <contexte_memoire> dans les messages utilisateur rejoués",
  "Stop the tasks board flashing a stale/empty note on project open":
    "Fin du clignotement d'une note obsolète/vide du tableau des tâches à l'ouverture d'un projet",
  "Stop injecting broad overview memories on brain recall miss":
    "Fin de l'injection de mémoires de vue d'ensemble larges en cas de rappel Cerveau infructueux",
  "Tasks page sidebar toggle + one-page three-pane layout":
    "Bascule de barre latérale de la page des tâches + mise en page à trois volets sur une page",
  "Show a label under every usage chart column":
    "Libellé affiché sous chaque colonne du graphique d'usage",
  "Allow remote project ids in tasks board store":
    "Prise en charge des identifiants de projet distants dans le stockage du tableau des tâches",
  // Backfill — commits arrivés après la traduction initiale
  "Status-driven, compact actions in task detail sheet":
    "Actions compactes et adaptées au statut dans la feuille de détail d'une tâche",
  "Full-screen agent drawer (Chat + Details) on mobile task tap":
    "Tiroir d'agent plein écran (Chat + Détails) au toucher d'une tâche sur mobile",
  "Cerveau recall on every prompt via AgentManager choke point":
    "Rappel du Cerveau à chaque prompt via le point de passage AgentManager",
  "Per-column search/filter/sort toolbar on the board":
    "Barre de recherche, filtre et tri par colonne sur le tableau",
  "Mirror the selected task's agent in a resizable desktop side panel":
    "Reflète l'agent de la tâche sélectionnée dans un panneau latéral redimensionnable sur bureau",
  "Live tab title + one-sentence banner headline from the response":
    "Titre d'onglet en direct + bannière d'une phrase tirée de la réponse",
  "Auto lucide icons on task-report section headings":
    "Icônes Lucide automatiques sur les titres de sections du compte-rendu de tâche",
  "Grey card callouts with lucide icons, drop left border":
    "Encadrés gris avec icônes Lucide, bordure gauche supprimée",
  "Timeline shows only planned + running, colored by column; visible search bar + faceted filter":
    "La chronologie n'affiche que le planifié et l'en-cours, coloré par colonne ; barre de recherche visible + filtre à facettes",
  "Auto-title the tab from the agent's response each turn":
    "Titre automatique de l'onglet à partir de la réponse de l'agent à chaque tour",
  "Search field + sort menu on the board": "Champ de recherche + menu de tri sur le tableau",
  "Compress from held base64, not a store object-URL round-trip":
    "Compression depuis le base64 conservé, sans détour par une object-URL du store",
  "Downscale images for Codex, not just the relay budget":
    "Réduction des images pour Codex, pas seulement pour le budget du relais",
  "Per-column search field white + full-width in toolbar":
    "Champ de recherche par colonne blanc et pleine largeur dans la barre d'outils",
  "Stop double-opening a background tab for a just-created agent":
    "N'ouvre plus deux fois un onglet en arrière-plan pour un agent tout juste créé",
};

# Journal des modifications

## 0.1.108 - 2026-07-16

### Ajouts

- Créez un nouveau dossier de projet ou clonez un dépôt GitHub depuis Ajouter un projet ([#1331](https://github.com/getpaseo/paseo/pull/1331), [#2045](https://github.com/getpaseo/paseo/pull/2045), [#2097](https://github.com/getpaseo/paseo/pull/2097) by [@mcowger](https://github.com/mcowger))
- Recherchez et ouvrez des espaces de travail depuis le menu de recherche ([#2096](https://github.com/getpaseo/paseo/pull/2096))
- Épinglez des espaces de travail en haut de la barre latérale ([#1981](https://github.com/getpaseo/paseo/pull/1981) by [@half144](https://github.com/half144))
- Regroupez les appels d'outils dans un seul élément réduit, avec un nouveau réglage d'apparence ([#2031](https://github.com/getpaseo/paseo/pull/2031), [#2069](https://github.com/getpaseo/paseo/pull/2069), [#2090](https://github.com/getpaseo/paseo/pull/2090) by [@mcowger](https://github.com/mcowger))
- Conservez les cookies et données de sites du navigateur d'un onglet à l'autre et après redémarrage ([#2089](https://github.com/getpaseo/paseo/pull/2089))
- Les sous-agents Claude et Codex affichent désormais leur vrai nom, avec une nouvelle option pour archiver les sous-agents terminés de Claude Code, Codex et OpenCode ([#2073](https://github.com/getpaseo/paseo/pull/2073))
- Dupliquez des conversations à partir de tours en échec ([#2063](https://github.com/getpaseo/paseo/pull/2063))

### Améliorations

- Les modes de permission ont des icônes plus claires ([#1980](https://github.com/getpaseo/paseo/pull/1980) by [@cleiter](https://github.com/cleiter))
- Le bureau reste utilisable dans des fenêtres plus étroites ([#1983](https://github.com/getpaseo/paseo/pull/1983))
- Les commandes de la barre latérale restent en place lorsque les panneaux du bureau s'ouvrent et se ferment ([#2078](https://github.com/getpaseo/paseo/pull/2078))
- La saisie dans les longs brouillons est plus fluide ([#2086](https://github.com/getpaseo/paseo/pull/2086))
- Les commandes de terminal Codex apparaissent toujours dans la conversation, même sans sortie ([#2037](https://github.com/getpaseo/paseo/pull/2037))

### Corrections

- Nouvel espace de travail conserve votre prompt et vos pièces jointes quand vous changez de projet ou d'hôte ([#2030](https://github.com/getpaseo/paseo/pull/2030), [#2036](https://github.com/getpaseo/paseo/pull/2036))
- Les sessions OpenCode se ferment sans faire planter Paseo ([#2027](https://github.com/getpaseo/paseo/pull/2027) by [@mcowger](https://github.com/mcowger))
- Les commandes slash de Pi ne laissent plus les conversations bloquées en cours d'exécution ([#2066](https://github.com/getpaseo/paseo/pull/2066) by [@ebg1223](https://github.com/ebg1223))
- Les mises à jour des agents en arrière-plan apparaissent désormais après la réponse principale ([#2058](https://github.com/getpaseo/paseo/pull/2058) by [@1254087415](https://github.com/1254087415))
- Les sous-agents Codex ne disparaissent plus de la piste Sous-agents ([#2068](https://github.com/getpaseo/paseo/pull/2068))
- Les conversations dupliquées s'ouvrent prêtes à être modifiées dans leur nouvel onglet ([#2038](https://github.com/getpaseo/paseo/pull/2038))
- Paseo Desktop s'ouvre normalement après un arrêt interrompu ([#1962](https://github.com/getpaseo/paseo/pull/1962))
- Les raccourcis clavier fonctionnent maintenant avec `-`, `=`, `;` et `'` ([#2047](https://github.com/getpaseo/paseo/pull/2047) by [@OnCloud125252](https://github.com/OnCloud125252))
- Les modèles Codebuddy Code apparaissent désormais dans le sélecteur de modèles ([#1979](https://github.com/getpaseo/paseo/pull/1979) by [@park0er](https://github.com/park0er))
- La recherche d'espaces de travail inclut désormais les commandes et workflows OpenCode ([#2049](https://github.com/getpaseo/paseo/pull/2049))
- Les installations Nix incluent désormais l'application web Paseo ([#1978](https://github.com/getpaseo/paseo/pull/1978) by [@liamdiprose](https://github.com/liamdiprose))

## 0.1.107 - 2026-07-13

### Ajouts

- Inspectez les sous-agents créés par les providers et leurs conversations en direct depuis la piste Sous-agents ([#2013](https://github.com/getpaseo/paseo/pull/2013) by [@omercnet](https://github.com/omercnet))
- Dupliquez des conversations avec tous les providers d'agents pris en charge ([#2022](https://github.com/getpaseo/paseo/pull/2022))

### Améliorations

- Ajoutez des projets directement depuis Nouvel espace de travail quand aucun n'est configuré ([#2026](https://github.com/getpaseo/paseo/pull/2026))
- Les nouveaux terminaux s'ouvrent immédiatement à la bonne taille ([#2023](https://github.com/getpaseo/paseo/pull/2023) by [@cleiter](https://github.com/cleiter))
- Les actions du pied de la barre latérale s'expliquent désormais via des infobulles ([#2025](https://github.com/getpaseo/paseo/pull/2025))
- Les appels d'outil shell de Codex n'affichent que la commande exécutée ([#2029](https://github.com/getpaseo/paseo/pull/2029))
- Les providers ACP personnalisés gardent par défaut le travail sur fichiers et terminal dans l'environnement de l'agent ([#2024](https://github.com/getpaseo/paseo/pull/2024))
- Catalogue de providers ACP mis à jour vers les dernières versions du registre

### Corrections

- Les grands tableaux ne rendent plus les conversations iOS non réactives
- Les commandes de conversation restent cliquables près du bouton de défilement vers le bas ([#2007](https://github.com/getpaseo/paseo/pull/2007))
- Les sorties d'outil surdimensionnées ne ralentissent ni n'inondent plus les fils de conversation ([#2020](https://github.com/getpaseo/paseo/pull/2020))
- Les sous-agents inter-providers peuvent utiliser des providers sans réglages de mode ([#2000](https://github.com/getpaseo/paseo/pull/2000) by [@githubbzxs](https://github.com/githubbzxs))
- Les tâches de métadonnées internes de Pi n'encombrent plus l'historique normal des sessions ([#1999](https://github.com/getpaseo/paseo/pull/1999) by [@githubbzxs](https://github.com/githubbzxs))
- Les conversations Pi restent utilisables après l'annulation de commandes d'extension ([#2019](https://github.com/getpaseo/paseo/pull/2019))

## 0.1.106 - 2026-07-12

### Ajouts

- Approuvez les demandes de permission MCP de Codex dans Paseo ([#2001](https://github.com/getpaseo/paseo/pull/2001))

### Améliorations

- Catalogue de providers ACP mis à jour vers les dernières versions du registre

### Corrections

- Moins de blocages et d'écrans vides sur mobile lors du changement d'espace de travail pendant que des agents diffusent ([#1989](https://github.com/getpaseo/paseo/pull/1989))
- Les sessions OpenCode démarrent de façon fiable au lieu de perdre parfois le premier tour ([#2015](https://github.com/getpaseo/paseo/pull/2015) by [@mcowger](https://github.com/mcowger))
- Le passage d'un espace de travail à l'autre n'affiche plus d'écran blanc
- Pi conserve vos outils et réglages MCP existants quand Paseo ajoute les siens ([#1990](https://github.com/getpaseo/paseo/pull/1990) by [@mcowger](https://github.com/mcowger))

## 0.1.105 - 2026-07-10

### Ajouts

- Parcourez les fichiers modifiés sous forme d'arborescence de dossiers repliable ou de liste à plat ([#1918](https://github.com/getpaseo/paseo/pull/1918), [#1945](https://github.com/getpaseo/paseo/pull/1945) by [@cleiter](https://github.com/cleiter))
- Déployez toujours le raisonnement de l'agent grâce à un nouveau réglage d'apparence ([#1943](https://github.com/getpaseo/paseo/pull/1943) by [@mcowger](https://github.com/mcowger))

### Améliorations

- Le sélecteur de projet trouve les dossiers via recherche approximative et navigation native sur le bureau ([#1968](https://github.com/getpaseo/paseo/pull/1968))
- Les grandes barres latérales d'espaces de travail restent réactives ([#1966](https://github.com/getpaseo/paseo/pull/1966))
- Les noms d'espaces de travail générés et le texte Git peuvent utiliser MiniMax M3 ([#1955](https://github.com/getpaseo/paseo/pull/1955) by [@octo-patch](https://github.com/octo-patch))
- Cursor expose désormais le mode réflexion et le mode rapide ([#1952](https://github.com/getpaseo/paseo/pull/1952))

### Corrections

- Codex reste actif et diffuse correctement pendant l'exécution des sous-agents ([#1967](https://github.com/getpaseo/paseo/pull/1967))
- Les interruptions audio sous Android ne font plus planter le mode vocal ni ne bloquent la dictée ([#1941](https://github.com/getpaseo/paseo/pull/1941))
- Les barres latérales mobiles restent synchronisées et conservent les gestes de balayage pour ouvrir ([#1953](https://github.com/getpaseo/paseo/pull/1953), [#1976](https://github.com/getpaseo/paseo/pull/1976))
- Les modèles Pi texte seul acceptent les prompts avec image sans casser la session ([#1960](https://github.com/getpaseo/paseo/pull/1960))
- Les échecs de rendu de l'app affichent un écran de récupération réessayable au lieu d'un écran blanc ([#1924](https://github.com/getpaseo/paseo/pull/1924))
- L'usage du contexte de Pi reste visible avec les anciennes versions d'Oh My Pi ([#1886](https://github.com/getpaseo/paseo/pull/1886) by [@theslava](https://github.com/theslava))
- Les popovers d'usage des providers ne génèrent plus d'erreur lorsqu'ils sont ouverts et fermés rapidement ([#1885](https://github.com/getpaseo/paseo/pull/1885) by [@theslava](https://github.com/theslava))
- Les menus d'espaces de travail sur mobile masquent les badges de raccourcis réservés au bureau ([#1964](https://github.com/getpaseo/paseo/pull/1964))

## 0.1.104 - 2026-07-08

### Ajouts

- Les agents peuvent piloter le navigateur intégré avec captures de page, saisie de confiance, boîtes de dialogue et contrôle des onglets ([#1881](https://github.com/getpaseo/paseo/pull/1881))
- Inspectez, annotez et envoyez des éléments de page depuis un onglet de navigateur vers l'agent ([#1708](https://github.com/getpaseo/paseo/pull/1708) by [@huiliaoning](https://github.com/huiliaoning))
- Écran Planifications pour créer et gérer des agents récurrents ([#1246](https://github.com/getpaseo/paseo/pull/1246))
- Ouvrez un projet depuis n'importe où avec Cmd+O ([#1849](https://github.com/getpaseo/paseo/pull/1849))
- Les agents peuvent renommer les espaces de travail une fois la tâche comprise ([#1876](https://github.com/getpaseo/paseo/pull/1876))
- Claude Ultra Code est disponible pour les modèles Claude pris en charge ([#1872](https://github.com/getpaseo/paseo/pull/1872))
- ByteDance TRAE CLI disponible comme provider d'agent ([#1831](https://github.com/getpaseo/paseo/pull/1831), [#1896](https://github.com/getpaseo/paseo/pull/1896) by [@park0er](https://github.com/park0er))

### Améliorations

- Gérez le démon intégré depuis un seul endroit dans les réglages du bureau ([#1938](https://github.com/getpaseo/paseo/pull/1938))
- Les exécutions planifiées et en boucle obtiennent chacune leur propre espace de travail dans la barre latérale ([#1909](https://github.com/getpaseo/paseo/pull/1909), [#1934](https://github.com/getpaseo/paseo/pull/1934))
- Les gros rafraîchissements de providers et de modèles se chargent plus vite dans l'app ([#1895](https://github.com/getpaseo/paseo/pull/1895))
- Les espaces de travail créés par les agents obtiennent désormais des noms générés lisibles ([#1887](https://github.com/getpaseo/paseo/pull/1887))
- Les onglets de navigateur ouverts par les agents restent en arrière-plan jusqu'à ce que vous y basculiez ([#1875](https://github.com/getpaseo/paseo/pull/1875))
- Cartes plus claires lorsqu'un agent pose une question ([#1643](https://github.com/getpaseo/paseo/pull/1643) by [@cleiter](https://github.com/cleiter))
- Les rapports de diagnostic incluent les journaux de l'application de bureau ([#1914](https://github.com/getpaseo/paseo/pull/1914))
- Les outils intégrés de Paseo prennent moins de contexte ([#1939](https://github.com/getpaseo/paseo/pull/1939))

### Corrections

- Les hôtes renommés conservent leur nom après reconnexion ([#1940](https://github.com/getpaseo/paseo/pull/1940))
- Le bureau trouve vos CLI installés même quand votre shell est lent à démarrer ([#1916](https://github.com/getpaseo/paseo/pull/1916))
- Le redémarrage du démon depuis les réglages du bureau fonctionne de façon fiable ([#1915](https://github.com/getpaseo/paseo/pull/1915))
- Le redémarrage du démon depuis le CLI intégré le laisse géré par l'application de bureau ([#1919](https://github.com/getpaseo/paseo/pull/1919))
- L'interface web se charge quand le démon est démarré depuis le CLI intégré ([#1899](https://github.com/getpaseo/paseo/pull/1899) by [@yzim](https://github.com/yzim))
- Les scripts de configuration de worktree conservent votre PATH ([#1908](https://github.com/getpaseo/paseo/pull/1908))
- Les images Docker continuent de tourner pendant le nettoyage des providers et les diagnostics ([#1877](https://github.com/getpaseo/paseo/pull/1877))
- Les brouillons de Nouvel espace de travail survivent à l'archivage d'un espace de travail ([#1838](https://github.com/getpaseo/paseo/pull/1838))
- L'autocomplétion du composeur reste ouverte après un changement d'écran ([#1851](https://github.com/getpaseo/paseo/pull/1851))
- L'usage de Claude apparaît quand une fenêtre de quota n'a pas de réinitialisation planifiée ([#1855](https://github.com/getpaseo/paseo/pull/1855))
- L'action Nouvel espace de travail s'affiche pour les projets non-git dans la barre latérale ([#1857](https://github.com/getpaseo/paseo/pull/1857) by [@cleiter](https://github.com/cleiter))

## 0.1.103 - 2026-07-01

### Ajouts

- Claude Sonnet 5 est disponible dans le sélecteur de modèles Claude ([#1850](https://github.com/getpaseo/paseo/pull/1850))

## 0.1.102 - 2026-06-30

### Ajouts

- Dupliquez des conversations dans un nouvel onglet ou un nouveau worktree ([#1788](https://github.com/getpaseo/paseo/pull/1788))
- Voyez les espaces de travail de tous les hôtes connectés ([#1538](https://github.com/getpaseo/paseo/pull/1538), [#1775](https://github.com/getpaseo/paseo/pull/1775), [#1825](https://github.com/getpaseo/paseo/pull/1825))
- Le démon peut désormais servir l'interface web ([#1635](https://github.com/getpaseo/paseo/pull/1635), [#1739](https://github.com/getpaseo/paseo/pull/1739))
- Lancez Paseo depuis une image Docker officielle ([#1740](https://github.com/getpaseo/paseo/pull/1740) by [@Herbrant](https://github.com/Herbrant))
- Mettez à jour un démon à distance depuis l'app ([#1513](https://github.com/getpaseo/paseo/pull/1513) by [@thedavidweng](https://github.com/thedavidweng))
- Configurez des points d'accès OpenAI distincts pour la reconnaissance vocale et la synthèse vocale ([#1823](https://github.com/getpaseo/paseo/pull/1823))
- Déposez des fichiers dans n'importe quel composeur ([#1750](https://github.com/getpaseo/paseo/pull/1750), [#1801](https://github.com/getpaseo/paseo/pull/1801))
- Affichez l'usage de MiniMax dans les vues de quota ([#1662](https://github.com/getpaseo/paseo/pull/1662) by [@ilteoood](https://github.com/ilteoood))
- Coloration syntaxique des blocs de code C# ([#1651](https://github.com/getpaseo/paseo/pull/1651) by [@dev693](https://github.com/dev693))

### Améliorations

- Nouvel espace de travail s'ouvre depuis n'importe où ([#1746](https://github.com/getpaseo/paseo/pull/1746), [#1806](https://github.com/getpaseo/paseo/pull/1806))
- La recherche de projet affiche la progression du chargement ([#1762](https://github.com/getpaseo/paseo/pull/1762))
- Les vérifications de mise à jour du bureau affichent un statut plus clair ([#1808](https://github.com/getpaseo/paseo/pull/1808), [#1815](https://github.com/getpaseo/paseo/pull/1815))
- Les hôtes distants lents expirent moins agressivement ([#1789](https://github.com/getpaseo/paseo/pull/1789))
- Pi attend plus longtemps les résultats d'extension ([#1732](https://github.com/getpaseo/paseo/pull/1732) by [@theslava](https://github.com/theslava))
- Les onglets de fichiers ouverts se rafraîchissent quand vous y revenez ([#1699](https://github.com/getpaseo/paseo/pull/1699) by [@cleiter](https://github.com/cleiter))
- Les terminaux web défilent plus fluidement ([#1622](https://github.com/getpaseo/paseo/pull/1622) by [@TommyLike](https://github.com/TommyLike))

### Corrections

- Les projets fraîchement ajoutés peuvent être modifiés sans redémarrage ([#1761](https://github.com/getpaseo/paseo/pull/1761) by [@huiliaoning](https://github.com/huiliaoning))
- Les gros dépôts s'ouvrent de façon plus fiable ([#1620](https://github.com/getpaseo/paseo/pull/1620) by [@jms830](https://github.com/jms830))
- Le mobile restaure l'espace de travail sauvegardé au lancement ([#1777](https://github.com/getpaseo/paseo/pull/1777))
- Les prompts d'agent ne renomment plus les espaces de travail ([#1779](https://github.com/getpaseo/paseo/pull/1779))
- La conversation reste en place quand un historique retardé arrive ([#1776](https://github.com/getpaseo/paseo/pull/1776))
- Les images diffusées dans la conversation restent dans l'ordre ([#1805](https://github.com/getpaseo/paseo/pull/1805))
- Les actions de conversation restent sous la sortie des outils ([#1827](https://github.com/getpaseo/paseo/pull/1827))
- La narration des sous-agents Claude reste hors de la conversation ([#1807](https://github.com/getpaseo/paseo/pull/1807))
- Les commandes slash et compétences de Kiro apparaissent dans Paseo ([#1792](https://github.com/getpaseo/paseo/pull/1792) by [@park0er](https://github.com/park0er))
- Les listes d'agents survivent aux enregistrements de projet obsolètes ([#1812](https://github.com/getpaseo/paseo/pull/1812))
- Les aperçus d'image sous Windows gèrent les chemins avec lettre de lecteur ([#1811](https://github.com/getpaseo/paseo/pull/1811))
- OpenCode se ferme proprement sous Windows ([#1771](https://github.com/getpaseo/paseo/pull/1771) by [@agamotto](https://github.com/agamotto))
- Les téléversements de fichiers sur le bureau conservent leur extension ([#1741](https://github.com/getpaseo/paseo/pull/1741))
- Le nettoyage de Claude Code tue les processus enfants ([#1540](https://github.com/getpaseo/paseo/pull/1540) by [@TommyLike](https://github.com/TommyLike))
- OpenCode n'indexe plus votre répertoire personnel ([#1704](https://github.com/getpaseo/paseo/pull/1704) by [@rex-chang](https://github.com/rex-chang))
- Le démon CLI macOS empaqueté n'affiche plus d'icônes supplémentaires dans le Dock ([#1759](https://github.com/getpaseo/paseo/pull/1759) by [@yzim](https://github.com/yzim))
- `paseo daemon status` fonctionne sans charger les agents ([#1810](https://github.com/getpaseo/paseo/pull/1810))
- Les worktrees de PR affichent correctement l'état poussé ([#1804](https://github.com/getpaseo/paseo/pull/1804))

## 0.1.101 - 2026-06-26

### Ajouts

- Copiez un rapport de dépannage depuis les Réglages quand le support a besoin des détails d'hôte, de démon, de provider et de journaux ([#1728](https://github.com/getpaseo/paseo/pull/1728))
- Les résultats de l'outil image de Claude s'affichent désormais comme des images dans la conversation ([#1717](https://github.com/getpaseo/paseo/pull/1717))
- Ajout du japonais ([#1694](https://github.com/getpaseo/paseo/pull/1694) by [@sysCat64](https://github.com/sysCat64))
- Ajout du portugais brésilien ([#1653](https://github.com/getpaseo/paseo/pull/1653) by [@Alcimerio](https://github.com/Alcimerio))

### Améliorations

- Les diagnostics de provider restent utiles même quand la découverte de modèles est lente ([#1724](https://github.com/getpaseo/paseo/pull/1724))
- Les requêtes de provider lentes ne font plus paraître l'app déconnectée ([#1723](https://github.com/getpaseo/paseo/pull/1723))
- Les worktrees liés à des branches suivies nommées différemment trouvent correctement leurs PR ([#1718](https://github.com/getpaseo/paseo/pull/1718))
- Les espaces de travail lancés depuis des prompts de commande slash obtiennent des noms plus clairs ([#1709](https://github.com/getpaseo/paseo/pull/1709))
- Catalogue de providers ACP mis à jour vers les dernières versions du registre

### Corrections

- Pi ne crée plus de sessions vides pendant le chargement des options de nouvel agent ([#1727](https://github.com/getpaseo/paseo/pull/1727))
- Le statut du démon sous Windows trouve le processus du démon de façon plus fiable ([#1725](https://github.com/getpaseo/paseo/pull/1725))
- Les identifiants vocaux OpenAI n'affectent plus les autres outils basés sur OpenAI
- Les listes de modèles de provider ne disparaissent plus pendant le rafraîchissement

## 0.1.100 - 2026-06-24

### Ajouts

- Faites défiler les modes de l'agent avec Shift+Tab
- Sélectionnez un agent Copilot personnalisé au démarrage ou en cours de session ([#1700](https://github.com/getpaseo/paseo/pull/1700))

### Améliorations

- Catalogue de providers ACP mis à jour vers les dernières versions du registre

### Corrections

- Claude n'envoie plus de requête API supplémentaire après chaque message ([#1701](https://github.com/getpaseo/paseo/pull/1701))
- OpenCode ne laisse plus de serveurs en arrière-plan tourner après la fin des sessions ([#1697](https://github.com/getpaseo/paseo/pull/1697))
- Les commandes slash et compétences se chargent désormais dans les agents OMP ([#1698](https://github.com/getpaseo/paseo/pull/1698))

## 0.1.99 - 2026-06-23

### Améliorations

- Le panneau des PR dispose désormais d'un bouton de rafraîchissement et d'états de chargement plus clairs ([#1664](https://github.com/getpaseo/paseo/pull/1664))
- Les diagnostics de provider et les listes de modèles restent désormais synchronisés ([#1660](https://github.com/getpaseo/paseo/pull/1660))

### Corrections

- Les providers ACP comme Grok n'affichent plus de messages utilisateur en double
- Les modes du composeur sauvegardés ne se réinitialisent plus pendant le chargement des données de provider ([#1658](https://github.com/getpaseo/paseo/pull/1658))
- La barre latérale droite ne reste plus bloquée sur mobile ([#1661](https://github.com/getpaseo/paseo/pull/1661))

## 0.1.98 - 2026-06-21

### Ajouts

- Consultez l'usage de votre forfait dans l'app pour Claude, Codex, Copilot, Cursor, Z.AI, Grok et Kimi ([#1278](https://github.com/getpaseo/paseo/pull/1278) by [@ABorakati](https://github.com/ABorakati))
- Ajout d'Ultracode pour Claude ([#1625](https://github.com/getpaseo/paseo/pull/1625))
- Détachez un sous-agent pour l'exécuter de façon autonome ([#1612](https://github.com/getpaseo/paseo/pull/1612))
- Ajoutez un projet sans créer d'espace de travail
- Ajout d'un réglage pour afficher les noms de branches plutôt que les titres dans la barre latérale

### Améliorations

- Les changements de réflexion et de mode en cours de tour indiquent désormais qu'ils s'appliquent au tour suivant
- Les options de fusion de PR nomment leur méthode : squash, merge ou rebase ([#1608](https://github.com/getpaseo/paseo/pull/1608) by [@mcowger](https://github.com/mcowger))
- Le changement de mode d'un agent en cours d'exécution est mémorisé pour les nouveaux agents
- Copiez le diagnostic de lancement d'un provider en un seul geste ([#1611](https://github.com/getpaseo/paseo/pull/1611))

### Corrections

- OpenCode n'analyse plus tout votre disque sur le bureau macOS ([#1626](https://github.com/getpaseo/paseo/pull/1626))
- Le démon ne plante plus quand la synthèse vocale OpenAI n'a pas de clé API ([#1368](https://github.com/getpaseo/paseo/pull/1368) by [@mcowger](https://github.com/mcowger))
- La réouverture d'un agent Codex archivé ne se bloque plus
- Le compteur de contexte de Claude ne saute plus à l'usage des sous-agents
- Le compteur de contexte de Claude se remplit dès le premier message d'une nouvelle session
- Le sélecteur de mode d'OpenCode respecte désormais vos modes désactivés ([#1366](https://github.com/getpaseo/paseo/pull/1366) by [@mcowger](https://github.com/mcowger))
- Les liens de fichiers et mentions @ trouvent les fichiers dans les dossiers cachés et les chemins profonds ([#1609](https://github.com/getpaseo/paseo/pull/1609))
- L'archivage du dernier espace de travail d'un projet ne le fait plus disparaître ([#1631](https://github.com/getpaseo/paseo/pull/1631))
- Les projets repliés dans la barre latérale restent repliés

## 0.1.97 - 2026-06-18

### Ajouts

- **Modèle d'espace de travail simplifié** — lancez plusieurs espaces de travail sur le même code sans worktree, chacun avec ses propres agents, terminaux et statut ([#1539](https://github.com/getpaseo/paseo/pull/1539))
- **Rouvrez des espaces de travail archivés depuis l'Historique** — restaurez un ancien espace même après la suppression de son worktree
- **Les terminaux indiquent si leur agent travaille, est au repos ou attend une saisie** ([#1507](https://github.com/getpaseo/paseo/pull/1507))
- **Joignez des fichiers aux agents sur mobile** ([#1501](https://github.com/getpaseo/paseo/pull/1501))
- **Masquez les fichiers cachés dans l'explorateur de fichiers** ([#1516](https://github.com/getpaseo/paseo/pull/1516) by [@yuruiz](https://github.com/yuruiz))
- **Épinglez les boutons terminal, navigateur et nouvel onglet à la barre d'onglets et à la barre latérale**
- **Créez un nouvel espace de travail avec un raccourci clavier**

### Améliorations

- Les titres d'espace de travail proviennent de votre premier prompt et sont plus courts ([#1563](https://github.com/getpaseo/paseo/pull/1563))
- Copiez la branche ou le chemin d'un espace de travail depuis sa fiche au survol
- Les terminaux restent fluides même avec une sortie volumineuse ([#1500](https://github.com/getpaseo/paseo/pull/1500))
- Les worktrees sont supprimés quand leur dernier espace de travail est archivé ([#1562](https://github.com/getpaseo/paseo/pull/1562))
- Les notifications de fin incluent les résultats des sous-agents ([#1558](https://github.com/getpaseo/paseo/pull/1558))
- Cursor ne liste que les modèles que vous pouvez sélectionner ([#1556](https://github.com/getpaseo/paseo/pull/1556))
- Le catalogue de providers ACP est mis à jour avec les dernières versions du registre

### Corrections

- Les brefs ralentissements du démon ne coupent plus votre connexion
- Les mises à jour de l'AppImage Linux ne bloquent plus à la fermeture ni ne suppriment l'application ([#1485](https://github.com/getpaseo/paseo/pull/1485) by [@xpufx](https://github.com/xpufx))
- L'ouverture des réglages Providers ne plante plus sur Android ([#1537](https://github.com/getpaseo/paseo/pull/1537))
- Les raccourcis de terminal des agents de code fonctionnent sur Windows ([#1509](https://github.com/getpaseo/paseo/pull/1509))
- Les sessions ACP et Kimi peuvent à nouveau être importées ([#1510](https://github.com/getpaseo/paseo/pull/1510) by [@wbxl2000](https://github.com/wbxl2000))
- Les agents ACP s'arrêtent sans laisser de processus orphelins ([#1460](https://github.com/getpaseo/paseo/pull/1460) by [@yeshan333](https://github.com/yeshan333))
- Les aperçus des sessions importées affichent des prompts propres ([#1502](https://github.com/getpaseo/paseo/pull/1502))
- Les offres d'appairage local utilisent la bonne URL d'application ([#1187](https://github.com/getpaseo/paseo/pull/1187) by [@aibaiiqpl](https://github.com/aibaiiqpl))
- L'application ne se fige plus à cause de re-sondages répétés des providers
- Retirer un projet de la barre latérale supprime désormais le projet lui-même au lieu de le laisser en place
- Les numéros de raccourci d'espace de travail n'apparaissent plus pour la mauvaise touche ([#1580](https://github.com/getpaseo/paseo/pull/1580) by [@cleiter](https://github.com/cleiter))
- Les conversations ne se bloquent plus quand un message contient des backticks non appariés ([#1585](https://github.com/getpaseo/paseo/pull/1585) by [@thaning0](https://github.com/thaning0))

## 0.1.96 - 2026-06-13

_Cette version corrige uniquement un problème Android — les utilisateurs desktop n'ont pas besoin de mettre à jour._

### Corrections

- Sur Android, la barre latérale ne réapparaît plus et ne reste plus bloquée après l'ouverture d'une conversation

## 0.1.95 - 2026-06-13

### Ajouts

- **Joignez n'importe quel fichier aux agents sur desktop** ([#1474](https://github.com/getpaseo/paseo/pull/1474))

### Améliorations

- Le bouton git push apparaît avant les actions de merge quand votre branche est en avance ([#1488](https://github.com/getpaseo/paseo/pull/1488))
- Les pièces jointes SVG sont téléversées sur le disque
- Le changement d'espace de travail est plus fluide

### Corrections

- Correction des cas où des données GitHub obsolètes pouvaient s'afficher ([#1491](https://github.com/getpaseo/paseo/pull/1491))
- Les images téléversées dans les commentaires et fils de revue de PR se chargent désormais dans le panneau PR ([#1486](https://github.com/getpaseo/paseo/pull/1486))
- Ouvrir un projet dont le dossier est manquant affiche une erreur claire ([#1490](https://github.com/getpaseo/paseo/pull/1490))
- Le titre du nouvel espace de travail s'écarte du clavier ([#1489](https://github.com/getpaseo/paseo/pull/1489))
- Les barres latérales ne s'ouvrent plus toutes seules sur Android

## 0.1.94 - 2026-06-12

### Ajouts

- **Joignez à une conversation les commentaires, revues, fils et journaux de vérifications échouées d'une pull request depuis le panneau PR** ([#1400](https://github.com/getpaseo/paseo/pull/1400))
- **Utilisez Paseo en arabe, chinois, anglais, français, russe et espagnol** ([#1282](https://github.com/getpaseo/paseo/pull/1282), [#1478](https://github.com/getpaseo/paseo/pull/1478) by [@chyendongnhanh338](https://github.com/chyendongnhanh338), [@dwyanewang](https://github.com/dwyanewang))
- **Créez des profils de terminal réutilisables depuis les réglages Hôte**
- **Ouvrez des espaces de travail dans Antigravity** ([#1424](https://github.com/getpaseo/paseo/pull/1424) by [@krumpyzoid](https://github.com/krumpyzoid))

### Améliorations

- Les skills Claude apparaissent dans l'autocomplétion du prompt au fur et à mesure que vous tapez ([#1464](https://github.com/getpaseo/paseo/pull/1464))
- Copiez les chemins de fichiers directement depuis les menus des onglets d'aperçu ([#1473](https://github.com/getpaseo/paseo/pull/1473))
- Le statut de PR reste à jour après qu'un agent a mergé une branche ([#1455](https://github.com/getpaseo/paseo/pull/1455))
- Les onglets d'espace de travail restent rapides en ne conservant que les écrans de l'espace actif ([#1472](https://github.com/getpaseo/paseo/pull/1472))

### Corrections

- Les raccourcis d'envoi du composeur n'entrent plus en conflit avec d'autres raccourcis clavier
- Les prompts à questions multiples avancent une réponse à la fois ([#1462](https://github.com/getpaseo/paseo/pull/1462))
- Les sessions Pi importées conservent leur modèle et leurs réglages de réflexion d'origine ([#1441](https://github.com/getpaseo/paseo/pull/1441) by [@thomasaull](https://github.com/thomasaull))
- La reconnexion à un hôte desktop conserve le shell et la route d'espace de travail enregistrés
- Les terminaux de worktree n'apparaissent plus dans les espaces de travail parents
- Les reconnexions mobiles affichent correctement l'écran d'accueil

## 0.1.93 - 2026-06-10

### Ajouts

- **Claude Fable 5 est disponible dans le sélecteur de modèles Claude** ([#1443](https://github.com/getpaseo/paseo/pull/1443) by [@0-Captain](https://github.com/0-Captain))

## 0.1.92 - 2026-06-10

### Ajouts

- **Autocomplétion des skills dans les prompts**

### Améliorations

- Le catalogue de providers est intégré aux réglages Hôte ([#1423](https://github.com/getpaseo/paseo/pull/1423))
- Les vérifications manuelles de mise à jour ignorent les délais de déploiement échelonné
- CodeWhale remplace DeepSeek TUI dans le catalogue de providers
- Les entrées du catalogue de providers ACP sont mises à jour pour Cline, Codebuddy Code, DimCode, Factory Droid, Gemini, Nova et Qoder
- OMP a sa propre icône et sa page web
- Les descriptions du sélecteur de modèles sont plus claires
- Les erreurs des providers ACP affichent le vrai message d'échec du provider

### Corrections

- Les nouvelles branches de worktree Paseo peuvent pousser leurs premiers commits
- Les sessions importées ne s'ouvrent plus vides ni dans le mauvais espace de travail
- L'Explorateur Windows ouvre l'espace de travail sélectionné au lieu de Documents ([#1412](https://github.com/getpaseo/paseo/pull/1412) by [@bjspi](https://github.com/bjspi))
- Les raccourcis d'éditeur Windows installés comme command shims se lancent correctement ([#1387](https://github.com/getpaseo/paseo/pull/1387) by [@Peter7896](https://github.com/Peter7896))
- Les providers ACP qui ne peuvent pas utiliser de serveurs MCP démarrent correctement
- Les hôtes retirés ne laissent plus de pages d'hôte bloquées en connexion
- Les liens d'aperçu de fichier s'ouvrent dans votre navigateur externe
- La conversation reste ancrée au dernier message pendant que la sortie défile
- Le bouton d'envoi du composeur mobile ne se décale plus pendant la saisie

## 0.1.91 - 2026-06-08

### Ajouts

- **Ouvrez plusieurs fenêtres desktop** ([#1355](https://github.com/getpaseo/paseo/pull/1355) by [@arieel-ost](https://github.com/arieel-ost))
- **Ouvrez les pop-ups et liens du navigateur dans les onglets d'espace de travail** ([#1375](https://github.com/getpaseo/paseo/pull/1375))
- **Utilisez le centre de commande depuis le mobile**
- **Ajoutez OMP comme provider** ([#1388](https://github.com/getpaseo/paseo/pull/1388))

### Améliorations

- Les nouveaux espaces de travail mémorisent vos derniers choix de provider, mode et réflexion
- Les contrôles git orientent désormais par défaut les branches prêtes vers les pull requests et masquent les actions pull ou push indisponibles
- Les hôtes gérés par le desktop récupèrent plus fiablement après un état de démon obsolète
- Le statut du démon explique désormais les échecs d'authentification
- La recherche de projets ignore les environnements virtuels Python ([#1356](https://github.com/getpaseo/paseo/pull/1356))
- Les fichiers de configuration peuvent inclure `$schema` pour l'aide de l'éditeur
- Les serveurs MCP Claude conservent les réglages d'outils toujours chargés ([#1333](https://github.com/getpaseo/paseo/pull/1333) by [@nodomain](https://github.com/nodomain))
- Les profils Claude conservent leurs modèles configurés ([#1311](https://github.com/getpaseo/paseo/pull/1311) by [@ilteoood](https://github.com/ilteoood))
- Le chargement des providers peut patienter plus longtemps sur les machines lentes ([#1346](https://github.com/getpaseo/paseo/pull/1346) by [@nodomain](https://github.com/nodomain))
- L'entrée de catalogue Kimi pointe désormais vers Kimi Code CLI ([#1403](https://github.com/getpaseo/paseo/pull/1403) by [@wbxl2000](https://github.com/wbxl2000))
- Les entrées du catalogue de providers ACP sont mises à jour pour Auggie, Claude Agent, Cline, Codebuddy Code, DimCode, Factory Droid, fast-agent, Gemini, GitHub Copilot et Nova
- Les rapports de plantage de la dictée locale affichent des détails plus utiles ([#1379](https://github.com/getpaseo/paseo/pull/1379))
- Les journaux du démon indiquent pourquoi les workers gérés se ferment

### Corrections

- Les commandes slash de compaction Pi s'exécutent correctement ([#1338](https://github.com/getpaseo/paseo/pull/1338) by [@chyendongnhanh338](https://github.com/chyendongnhanh338))
- L'auto-archivage fonctionne toujours après la suppression d'une branche de PR mergée ([#1378](https://github.com/getpaseo/paseo/pull/1378))
- Les worktrees peuvent extraire correctement les refs de branches existantes ([#1358](https://github.com/getpaseo/paseo/pull/1358) by [@dixonl90](https://github.com/dixonl90))
- Les téléchargements de fichiers fonctionnent quand la protection par mot de passe du démon est activée ([#1351](https://github.com/getpaseo/paseo/pull/1351) by [@nodomain](https://github.com/nodomain))
- Les liens markdown iOS sont à nouveau cliquables ([#1334](https://github.com/getpaseo/paseo/pull/1334) by [@kaspesi](https://github.com/kaspesi))
- Les images markdown iOS s'affichent correctement
- Les espaces de travail Windows chargent correctement leurs providers ([#1329](https://github.com/getpaseo/paseo/pull/1329))
- Retirer un hôte localhost arrête son démon local ([#1297](https://github.com/getpaseo/paseo/pull/1297) by [@mcowger](https://github.com/mcowger))
- Les feuilles de réglages des providers s'empilent correctement
- L'écran de nouvel espace de travail ne s'ouvre plus derrière la barre latérale mobile
- Le listage global des agents fonctionne à nouveau ([#1420](https://github.com/getpaseo/paseo/pull/1420))
- Les résumés de compaction OpenCode restent hors de la conversation
- Les agents OpenCode partageant un espace de travail conservent leurs propres outils Paseo

## 0.1.90 - 2026-06-04

### Ajouts

- **Groupez la barre latérale par statut pour voir d'un coup d'œil les espaces de travail qui vous attendent, prêts à relire, en cours et terminés** ([#1317](https://github.com/getpaseo/paseo/pull/1317))
- **Démarrez un nouvel espace de travail depuis le bouton global de la barre latérale sans choisir de projet au préalable** ([#1324](https://github.com/getpaseo/paseo/pull/1324))
- **Ouvrez le fichier actif directement dans votre éditeur, gestionnaire de fichiers ou GitHub au lieu de n'ouvrir que la racine de l'espace de travail** ([#1285](https://github.com/getpaseo/paseo/pull/1285) by [@aaronzhongg](https://github.com/aaronzhongg))
- **Archivez automatiquement les espaces de travail de PR propres après le merge de la PR, depuis les réglages hôte** ([#1313](https://github.com/getpaseo/paseo/pull/1313))
- **Les skills Paseo gérés par le desktop restent à jour après l'installation d'une nouvelle build desktop** ([#1309](https://github.com/getpaseo/paseo/pull/1309))
- **Les fichiers Dart et les blocs de code Dart bénéficient désormais de la coloration syntaxique** ([#1326](https://github.com/getpaseo/paseo/pull/1326))

### Améliorations

- Les espaces de travail de la barre latérale peuvent être marqués comme lus quand ils sont prêts à relire ou en échec ([#1317](https://github.com/getpaseo/paseo/pull/1317))
- Les agents enfants conservent leurs permissions sans surveillance lorsqu'ils sont délégués entre providers ([#1315](https://github.com/getpaseo/paseo/pull/1315))
- Les agents planifiés s'ouvrent avec le vrai prompt et le vrai titre au lieu de paraître vides ([#1316](https://github.com/getpaseo/paseo/pull/1316))
- Les contrôles git priorisent l'action qui permet de livrer une branche prête ([#1316](https://github.com/getpaseo/paseo/pull/1316))
- Les questions multiples d'un agent sont affichées une à la fois
- Les questions OpenCode à réponse libre affichent la réponse saisie dans Paseo
- L'activité des agents délégués est visible sur l'espace de travail parent
- Les sessions sont classées par activité la plus récente
- Les entrées du catalogue de providers ACP sont mises à jour pour Claude Agent, Cline, Codebuddy Code, Factory Droid et Qoder

### Corrections

- Le rattrapage de la timeline ne laisse plus d'anciens messages non chargés
- Le code markdown des aperçus de fichiers s'affiche correctement
- Les longues nouvelles tentatives de dictée ne bloquent plus le nouvel audio
- La navigation du sélecteur d'hôte des réglages fonctionne depuis les pages de réglages hôte
- Les lignes de gouttière de diff restent alignées avec le code modifié
- Les gestes de la barre latérale mobile restent réactifs sous charge
- Les feuilles compactes gardent leur pied de page et leur espacement du bas visibles

## 0.1.89 - 2026-06-02

### Ajouts

- **Ouvrez les services d'un espace de travail via des liens de proxy de service publics** ([#1280](https://github.com/getpaseo/paseo/pull/1280) by [@mcowger](https://github.com/mcowger))
- **Choisissez où les nouveaux worktrees sont créés** ([#1230](https://github.com/getpaseo/paseo/pull/1230) by [@mcowger](https://github.com/mcowger))
- **Les fenêtres desktop se rouvrent à la même taille et à la même position** ([#1224](https://github.com/getpaseo/paseo/pull/1224) by [@everton-dgn](https://github.com/everton-dgn))
- **Les agents délégués peuvent fonctionner de manière autonome et envoyer des mises à jour de heartbeat récurrentes**

### Améliorations

- Les contrôles du composeur s'ajustent mieux dans les panneaux étroits
- Les badges de pull request des forks restent visibles dans les worktrees
- Cline dans le catalogue ACP est mis à jour vers la v3

### Corrections

- L'archivage d'un worktree se termine même si le démontage rencontre une erreur ([#1260](https://github.com/getpaseo/paseo/pull/1260) by [@mcowger](https://github.com/mcowger))
- Les messages de conversation iOS affichent correctement le gras, l'italique, le barré et les sauts de ligne ([#1254](https://github.com/getpaseo/paseo/pull/1254) by [@outofrange-consulting](https://github.com/outofrange-consulting))
- Le redimensionnement du panneau divisé sur le bord droit ne rogne plus ([#1261](https://github.com/getpaseo/paseo/pull/1261) by [@everton-dgn](https://github.com/everton-dgn))
- La sortie des commandes d'extension Pi ne se bloque plus
- Les agents délégués n'apparaissent plus dans les compteurs d'alertes des espaces de travail

## 0.1.88 - 2026-06-01

### Ajouts

- **Choisissez un thème d'application depuis les nouveaux réglages Apparence**
- **Définissez une police d'interface personnalisée**
- **Définissez une police de code personnalisée**
- **Ajustez la taille du texte de l'interface**
- **Ajustez la taille du texte de code**
- **Choisissez un thème de coloration syntaxique**
- **Gardez les planifications cron alignées sur un fuseau horaire choisi** ([#1232](https://github.com/getpaseo/paseo/pull/1232) by [@damselem](https://github.com/damselem))

### Améliorations

- Les réglages ont désormais une barre latérale plus plate avec un sélecteur d'hôte
- Le changement d'onglet d'espace de travail est plus rapide
- Les composeurs compacts affichent désormais l'utilisation du contexte en pourcentage
- Les terminaux d'agent ouverts dans des sous-répertoires d'espace de travail apparaissent désormais avec le reste des terminaux de l'espace
- Les écrans macOS peuvent se mettre en veille normalement pendant que l'application desktop est ouverte ([#1242](https://github.com/getpaseo/paseo/pull/1242) by [@fireblue](https://github.com/fireblue))
- Les grands diffs générés affichent désormais un espace réservé « trop volumineux » clair au lieu d'essayer d'afficher tout le fichier

### Corrections

- L'historique de conversation se rattrape correctement autour des mises à jour d'outils de longue durée
- Les panneaux de terminal conservent la bonne taille après un partage ou un redimensionnement des panneaux
- Les instantanés de terminal restaurés se réagencent correctement après un changement de taille du panneau
- Les menus de scripts d'espace de travail conservent la bonne taille après le lancement d'un service
- Les messages de conversation iOS ne masquent plus les liens en ligne, les URL ni les chemins de fichiers liés ([#1257](https://github.com/getpaseo/paseo/pull/1257) by [@outofrange-consulting](https://github.com/outofrange-consulting))

## 0.1.87 - 2026-05-30

### Ajouts

- Les demandes de permission des sous-agents OpenCode apparaissent désormais dans Paseo pour que vous puissiez les approuver ou les refuser

### Corrections

- Correction d'un plantage Android intermittent pendant le dessin de vues animées
- Correction des feuilles du bas mobiles qui ne se rouvraient pas après avoir été fermées

## 0.1.86 - 2026-05-29

### Ajouts

- **Lancez Grok (xAI) comme agent de code**
- **Mode rapide pour Claude Opus**
- **Dictée locale multilingue avec le nouveau modèle vocal Parakeet v3**

### Améliorations

- Les appels aux outils Edit, Write et Read sont désormais colorés syntaxiquement
- Le sélecteur de modèle affiche l'erreur lorsqu'un fournisseur échoue au chargement
- La page À propos indique les versions des démons hôtes connectés
- Rafraîchissez les diffs git à la demande avec un nouveau bouton de rafraîchissement
- Les aperçus peuvent ouvrir des fichiers lisibles en dehors de l'espace de travail actuel
- Les projets sans icône affichent désormais une icône colorée plutôt qu'un carré gris
- Les titres d'agents générés automatiquement et les noms de branche des worktrees utilisent maintenant les fournisseurs de repli que vous avez configurés ([#1219](https://github.com/getpaseo/paseo/pull/1219) by [@mcowger](https://github.com/mcowger))
- La dictée locale garde ses modèles vocaux hors du démon, réduisant sa consommation mémoire

### Corrections

- Sur mobile, tout le composeur reste désormais au-dessus du clavier, si bien que la piste des sous-agents et les pastilles de brouillon ne disparaissent plus derrière lui
- La chronologie d'agent sur mobile se remet à jour intégralement après une reconnexion, plus aucun message perdu
- Le menu des commandes slash n'affiche plus /clear en double

## 0.1.85 - 2026-05-29

### Ajouts

- **Opus 4.8 dans le sélecteur de modèles Claude**, avec une variante à contexte 1M

### Améliorations

- Archiver un worktree conserve désormais ses agents dans la liste archivée au lieu de les supprimer
- Archiver un agent nettoie les planifications qui le ciblent

## 0.1.84 - 2026-05-28

### Ajouts

- **Acceptation automatique des appels d'outils pour les agents OpenCode**

### Améliorations

- Copiez une commande de reprise OpenCode pour continuer la session en dehors de Paseo
- Le sélecteur de modèle liste tous les fournisseurs activés, avec un bouton Réessayer quand l'un échoue au chargement
- Les réglages des fournisseurs sont plus faciles à rechercher et à gérer
- Les autres agents qui se connectent à Paseo via MCP voient les mêmes fournisseurs, modèles et modes que l'app ([#1198](https://github.com/getpaseo/paseo/pull/1198))
- Les appels à l'outil Edit d'OpenCode s'affichent en diffs intégrés
- Taper une commande slash affiche d'abord la meilleure correspondance
- Le démon démarre plus vite sur les espaces de travail comportant de nombreux dossiers git
- Les listes Markdown ont un espacement plus resserré
- Moins de saccades lors du streaming des réponses d'agent
- Les contrôles du pied de page des messages utilisateur s'alignent avec le reste du chat
- Les contrôles de mode d'agent adoptent un traitement monochrome plus épuré
- Les mises en page compactes déplacent l'anneau de contexte vers le bord droit du pied de page

### Corrections

- Autorise la sélection de texte dans le chat sur mobile ([#1153](https://github.com/getpaseo/paseo/pull/1153) by [@muzhi1991](https://github.com/muzhi1991))
- Soumettre une question Pi ne donne plus l'impression qu'un second prompt s'est ouvert ([#1188](https://github.com/getpaseo/paseo/pull/1188) by [@yuruiz](https://github.com/yuruiz))
- Fuite mémoire du démon due à des caches git d'espace de travail non bornés ([#1200](https://github.com/getpaseo/paseo/pull/1200))
- Les diagnostics des fournisseurs incluent le chemin du binaire de remplacement de commande ([#1191](https://github.com/getpaseo/paseo/pull/1191))
- Les serveurs MCP d'OpenCode se connectent correctement lorsque le démon écoute sur des adresses génériques
- Les appels d'outils des serveurs MCP renvoyant une sortie non conforme ne échouent plus à la validation

## 0.1.83 - 2026-05-26

### Corrections

- Créer un agent via MCP attend désormais son démarrage effectif, de sorte que les échecs remontent comme une erreur de création claire
- Planifier un agent via MCP ne rejette plus les espaces réservés de cadence laissés vides
- Les messages de brouillon réaffichent la pastille de mode d'agent sur les modèles sans options de réflexion

## 0.1.82 - 2026-05-26

### Ajouts

- **Rembobinez le chat ou les fichiers depuis n'importe quel message utilisateur** ([#1154](https://github.com/getpaseo/paseo/pull/1154))
- **Consultez le coût cumulé d'une session d'agent** ([#1163](https://github.com/getpaseo/paseo/pull/1163))
- **Déposez des fichiers sur le terminal pour insérer leurs chemins** ([#1173](https://github.com/getpaseo/paseo/pull/1173))
- **Touchez un chemin de fichier dans le terminal pour l'ouvrir dans l'aperçu de l'espace de travail** ([#1174](https://github.com/getpaseo/paseo/pull/1174))
- **Approuvez les permissions OpenCode pour toute la session** ([#1168](https://github.com/getpaseo/paseo/pull/1168))
- **Les scripts d'espace de travail apparaissent désormais dans l'en-tête mobile** ([#1093](https://github.com/getpaseo/paseo/pull/1093) by [@ayhanmalkoc](https://github.com/ayhanmalkoc))
- Devin CLI dans le catalogue de fournisseurs ACP (by [@Alcimerio](https://github.com/Alcimerio))
- Les agents OpenCode affichent les couleurs de leur mode

### Améliorations

- Le clavier du terminal mobile se cache quand vous ouvrez une barre latérale
- L'activité des outils de lecture, d'écriture et des outils OpenCode s'affiche plus uniformément ([#1171](https://github.com/getpaseo/paseo/pull/1171))
- Les actions de l'en-tête d'espace de travail compact sont plus soignées
- Les mesures de latence dans les réglages sont plus faciles à parcourir ([#1170](https://github.com/getpaseo/paseo/pull/1170))
- La fusion d'une pull request est disponible dès que GitHub signale que la PR est prête ([#1172](https://github.com/getpaseo/paseo/pull/1172))

### Corrections

- L'autocomplétion des commandes slash sur mobile ne scintille plus et ne se superpose plus mal
- Interrompre un agent OpenCode le remet au repos au lieu d'afficher une erreur ([#1169](https://github.com/getpaseo/paseo/pull/1169))
- La sélection de modèle par fournisseur et par espace de travail est respectée ([#1167](https://github.com/getpaseo/paseo/pull/1167))
- Le composeur de brouillon conserve le mode de permission que vous avez choisi ([#1175](https://github.com/getpaseo/paseo/pull/1175))
- Les requêtes de couleur du terminal ne renvoient plus de réponses malformées
- Les liens de fichiers dans le chat ne plantent plus quand un message contient un '%' isolé (by [@Elliotwu-7](https://github.com/Elliotwu-7))

## 0.1.81 - 2026-05-24

### Ajouts

- **Paseo peut désormais être installé comme application web depuis les navigateurs compatibles** ([#1144](https://github.com/getpaseo/paseo/pull/1144))
- **Les dialogues d'extension Pi apparaissent désormais comme des demandes de permission Paseo** ([#1134](https://github.com/getpaseo/paseo/pull/1134) by [@yuruiz](https://github.com/yuruiz))
- Ajout de liens communautaires et d'un bouton d'accueil dans la barre latérale

### Améliorations

- **Les terminaux mobiles se chargent plus vite et restaurent la sortie existante plus en douceur** ([#1147](https://github.com/getpaseo/paseo/pull/1147))
- La copie des messages de l'assistant préserve la mise en forme
- Les échecs de repli des métadonnées d'agent consignent désormais chaque tentative de fournisseur pour faciliter le débogage

### Corrections

- Android : les suggestions de commandes slash restent interactives quand elles sont ouvertes depuis le composeur
- macOS : les raccourcis Alt+lettre fonctionnent à nouveau
- Les panneaux de terminal ne scintillent plus lors du redimensionnement
- Les serveurs MCP d'OpenCode sont injectés une seule fois au lieu d'être connectés deux fois
- L'import de session n'affiche plus de sessions vides
- Le statut d'archive des worktrees ne signale plus de faux commits non poussés ([#1158](https://github.com/getpaseo/paseo/pull/1158))
- Les alias de commande slash `/exit`, `/quit` et `/q` s'affichent maintenant sur une seule ligne
- Les badges de raccourcis en accord sont lisibles en mode clair
- Les contrôles segmentés affichent leur piste sous chaque segment
- Le texte de recherche de l'en-tête de feuille est lisible en mode sombre

## 0.1.80 - 2026-05-21

### Corrections

- Ouvrir les menus déroulants ne plante plus sur mobile

## 0.1.79 - 2026-05-21

### Ajouts

- **Pi a été repensé avec un support de premier ordre**
  - Fonctionne via votre CLI Pi installée, de sorte que vos extensions et votre configuration Pi sont reprises
  - Les agents Pi peuvent appeler les outils Paseo lorsque l'extension MCP Pi est installée
  - Importez une session Pi que vous avez démarrée dans le terminal
  - Copiez la commande de reprise de Pi depuis n'importe quel agent pour continuer la session dans votre terminal
  - Windows : les sessions Pi correspondent correctement entre les chemins d'espace de travail liés par symlink et par jonction
- **Nouvel écran d'accueil avec des tuiles rapides pour ajouter un projet, importer une session, configurer des fournisseurs et appairer un appareil**
- **Créez un agent directement dans un worktree neuf qui s'auto-archive à la fin de l'exécution**
- **Définissez un prompt système personnalisé qui s'applique à chaque agent que vous démarrez**
- **Renommez les espaces de travail, les terminaux et les onglets d'agent** ([#531](https://github.com/getpaseo/paseo/pull/531))
- **DeepSeek TUI dans le catalogue de fournisseurs ACP** ([#1096](https://github.com/getpaseo/paseo/pull/1096))
- **Kiro CLI dans le catalogue de fournisseurs ACP** (by [@huhusmang](https://github.com/huhusmang))
- Les fournisseurs du catalogue affichent leurs icônes dans le sélecteur de modèle ([#1098](https://github.com/getpaseo/paseo/pull/1098))
- Les variables d'environnement personnalisées passées à la création d'un agent atteignent désormais le processus de l'agent ([#1112](https://github.com/getpaseo/paseo/pull/1112))
- Le module NixOS prend en charge l'option TLS publique pour les relais auto-hébergés ([#1106](https://github.com/getpaseo/paseo/pull/1106) by [@yzx9](https://github.com/yzx9))

### Améliorations

- **Les connexions hôtes obsolètes se rétablissent automatiquement sans rafraîchissement manuel**
- Paseo s'ouvre sur l'espace de travail où vous étiez la dernière fois ([#1101](https://github.com/getpaseo/paseo/pull/1101))
- Les espaces de travail mémorisent l'éditeur dans lequel vous les avez ouverts
- Les démons obsolètes suggèrent désormais une mise à jour lorsqu'ils reçoivent une commande qu'ils ne comprennent pas
- Le mode vocal est masqué pendant qu'un agent tourne
- Les infobulles des liens de fichiers d'agent affichent le chemin complet résolu ([#1088](https://github.com/getpaseo/paseo/pull/1088))
- Le statut git de l'espace de travail se rafraîchit moins agressivement en arrière-plan ([#1102](https://github.com/getpaseo/paseo/pull/1102))

### Corrections

- Le bureau macOS ne se fige plus après le réveil de l'écran ([#745](https://github.com/getpaseo/paseo/pull/745))
- Windows : Codex détecte correctement l'installation du Microsoft Store ([#1020](https://github.com/getpaseo/paseo/pull/1020) by [@32r4](https://github.com/32r4))
- La sélection d'espace de travail survit à un redémarrage du démon ([#1111](https://github.com/getpaseo/paseo/pull/1111))
- Les agents Cursor attendent le chargement des commandes slash avant de les lister ([#1099](https://github.com/getpaseo/paseo/pull/1099) by [@chrisbanes](https://github.com/chrisbanes))
- Les sous-agents Codex continuent de tourner malgré des erreurs transitoires de processus enfant (by [@xy-plus](https://github.com/xy-plus))
- Les terminaux iPad envoient correctement Ctrl+C depuis un clavier matériel (by [@samatar26](https://github.com/samatar26))
- Les noms de fichiers git avec des caractères non-ASCII s'affichent correctement (by [@samatar26](https://github.com/samatar26))
- Les raccourcis de collage fonctionnent sur les dispositions de clavier Dvorak (by [@qin-nz](https://github.com/qin-nz))
- Les liens de fichiers Claude se résolvent correctement pour les projets dont les chemins nécessitent un encodage SDK
- Le texte de résultat Claude en double n'apparaît plus dans le chat ([#1095](https://github.com/getpaseo/paseo/pull/1095))
- Les styles d'interface dynamiques ne débordent plus de règles CSS sur toute la page ([#1103](https://github.com/getpaseo/paseo/pull/1103))
- Les poignées de main du relais rejettent les sessions qui tentent de changer de clé de chiffrement en cours de route ([#1037](https://github.com/getpaseo/paseo/pull/1037) by [@joaosa](https://github.com/joaosa))

## 0.1.78 - 2026-05-18

### Améliorations

- **Le sélecteur de modèle mobile est plus rapide et plus direct** Choisir un modèle, un mode ou une option de réflexion demande moins de touches

### Corrections

- Diviser un panneau ne perd plus votre position de défilement
- Taper dans les feuilles mobiles ne scintille plus
- Les feuilles sur le web mobile ne plantent plus quand on les balaie pour les fermer

## 0.1.77 - 2026-05-18

### Ajouts

- **Commandes slash pour terminer et redémarrer un agent**
- **Coloration syntaxique des blocs de code dans le chat**
- **Bouton de copie sur les blocs de code dans le chat**
- **Historique de défilement du terminal configurable** ([#1021](https://github.com/getpaseo/paseo/pull/1021) by [@32r4](https://github.com/32r4))
- Les liens de fichiers de l'assistant s'ouvrent sur une plage de lignes précise lorsqu'elle est incluse
- Les icônes de mode apparaissent dans le menu de statut de l'agent ([#1059](https://github.com/getpaseo/paseo/pull/1059) by [@32r4](https://github.com/32r4))
- MCP expose les outils de mise à jour, de journaux et d'exécution unique des planifications ([#1032](https://github.com/getpaseo/paseo/pull/1032) by [@skevetter](https://github.com/skevetter))
- Les relais auto-hébergés peuvent utiliser un réglage TLS différent pour le point d'accès public ([#1045](https://github.com/getpaseo/paseo/pull/1045) by [@yzx9](https://github.com/yzx9))

### Améliorations

- Les messages utilisateur ont désormais un remplissage de bulle distinct pour une hiérarchie de chat plus claire
- Fermer un onglet ramène à son onglet parent
- Les lignes de diff affichent le chemin complet du fichier au survol ([#1061](https://github.com/getpaseo/paseo/pull/1061) by [@Myriad-Dreamin](https://github.com/Myriad-Dreamin))
- La CLI affiche l'hôte du démon distant quand `ls` ne parvient pas à se connecter ([#1043](https://github.com/getpaseo/paseo/pull/1043) by [@mturac](https://github.com/mturac))
- L'installation Nix du démon est plus légère ([#966](https://github.com/getpaseo/paseo/pull/966) by [@ixxie](https://github.com/ixxie))
- L'installation Nix respecte les chemins de profil home-manager lors de l'héritage du PATH utilisateur ([#1040](https://github.com/getpaseo/paseo/pull/1040) by [@ixxie](https://github.com/ixxie))

### Corrections

- Les sondes OpenCode ne créent plus de sessions vides
- Les commandes personnalisées OpenCode ne se bloquent plus
- Les imports de session OpenCode réussissent dans davantage d'environnements
- Les lignes de diff natives se déplient correctement ([#940](https://github.com/getpaseo/paseo/pull/940) by [@bolasblack](https://github.com/bolasblack))
- Les interactions de la barre latérale mobile fonctionnent correctement sur le web ([#900](https://github.com/getpaseo/paseo/pull/900) by [@nikuscs](https://github.com/nikuscs))
- Les gestes de glissement sur le web mobile se déclenchent de façon fiable ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Le glisser-déposer sur le web mobile s'active correctement ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Safari iOS ne zoome plus au focus du composeur ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Le comportement de la touche Entrée dans le composeur web mobile est cohérent ([#1048](https://github.com/getpaseo/paseo/pull/1048) by [@nikuscs](https://github.com/nikuscs))
- Le composeur ne scintille plus lors du redimensionnement avec de longs prompts
- Les liens de code intégrés dans les messages de l'assistant ouvrent le bon fichier
- La popover de changement d'hôte est assez large pour afficher les noms d'hôtes ([#981](https://github.com/getpaseo/paseo/pull/981) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))
- Windows : l'import des sessions existantes fait correspondre les chemins correctement ([#1012](https://github.com/getpaseo/paseo/pull/1012) by [@kj1534](https://github.com/kj1534))

## 0.1.76 - 2026-05-15

### Ajouts

- **Horodatages du chat et durées des tours** Chaque message indique quand il a été envoyé, et chaque tour révèle le temps pris par l'agent
- **Mode de permission Revue automatique pour Claude Code et Codex** Les agents s'arrêtent après chaque tour d'assistant pour revue au lieu de tourner sans surveillance ([#928](https://github.com/getpaseo/paseo/pull/928), [#963](https://github.com/getpaseo/paseo/pull/963) by [@bolasblack](https://github.com/bolasblack))
- Faites apparaître les événements de compaction de contexte de Codex et la commande `/compact` dans le chat
- Auto-archivage optionnel des worktrees dès que leur PR est fusionnée
- Collez l'URL d'une PR ou d'un ticket GitHub dans le composeur pour l'attacher comme contexte
- Faites apparaître les actions de fusion automatique GitHub dans la carte de survol de la PR
- Affichez tous les décomptes de vérifications de PR dans la carte de survol de la PR
- Renommez un projet pour distinguer les doublons qui partagent un nom de dossier
- Confirmez avant d'archiver un worktree contenant du travail non commité ou non poussé
- Claude Code récupère désormais les modèles depuis `~/.claude/settings.json`, de sorte que les listes de modèles personnalisées apparaissent dans le sélecteur de modèle
- Les réglages Claude Code locaux (`.claude/settings.local.json`) s'appliquent par espace de travail
- Les diagnostics des fournisseurs ACP génériques apparaissent dans le sélecteur de modèle
- Autorise l'activation du mode rapide pour les sous-agents Paseo ([#909](https://github.com/getpaseo/paseo/pull/909), [#910](https://github.com/getpaseo/paseo/pull/910) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

### Améliorations

- Fait apparaître les messages d'erreur Claude dans le chat au lieu de terminer le tour en silence
- Le sélecteur de checkout d'espace de travail sélectionne automatiquement quand une seule PR est attachée
- Le flux de nouvel espace de travail respecte la branche actuellement extraite lors de la création d'une branche ([#909](https://github.com/getpaseo/paseo/pull/908) by [@sbtobb](https://github.com/sbtobb))
- Les modèles OpenCode des fournisseurs à abonnement console apparaissent désormais dans le sélecteur de modèle ([#917](https://github.com/getpaseo/paseo/pull/917) by [@t2o2](https://github.com/t2o2))
- Le sélecteur de modèle Cursor reflète les modèles annoncés par le client ACP Cursor ([#958](https://github.com/getpaseo/paseo/pull/958) by [@chrisbanes](https://github.com/chrisbanes))

### Corrections

- La touche Entrée matérielle de l'iPad soumet le composeur ([#919](https://github.com/getpaseo/paseo/pull/919) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))
- Le statut de PR se rabat sur une requête sans vérifications pour les jetons GitHub à granularité fine ([#932](https://github.com/getpaseo/paseo/pull/932) by [@32r4](https://github.com/32r4))
- Les erreurs ACP s'affichent en texte lisible au lieu de `[object Object]`
- OpenCode ne se bloque plus à la nouvelle tentative quand le fournisseur en amont cale
- Le décompte d'avance du worktree est correct quand la branche amont a été supprimée
- Les worktrees créés par branche suivent la bonne branche amont
- La vue des changements de fichiers fonctionne sur les dépôts vides sans commit
- Les liens de fichiers des messages de l'assistant ouvrent le bon fichier
- L'option de réflexion par défaut correspond aux capacités du modèle sélectionné
- Shift+Entrée fonctionne à nouveau dans les modes de saisie du terminal
- Les entrées de projet en double n'apparaissent plus après réouverture d'un projet
- Les sessions basées sur Pi se rétablissent après un 413 de Copilot au lieu de rester bloquées
- Ignore le sondage des candidats exécutables non pertinents au lancement des agents
- Le chiffrement de bout en bout du relais se reconnecte proprement lors de connexions/déconnexions concurrentes
- Le type d'espace de travail reste synchronisé avec le type de projet après reconfiguration
- Les fichiers d'intégration zsh s'installent avec des modes d'exécution utilisables
- Le cache des worktrees MCP se rafraîchit après création et archivage ([#911](https://github.com/getpaseo/paseo/pull/911) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

## 0.1.75 - 2026-05-12

### Ajouts

- Définissez la langue de reconnaissance vocale utilisée par la dictée et le mode vocal depuis les réglages ([#941](https://github.com/getpaseo/paseo/pull/941))

### Corrections

- Les échecs de reprise Codex remontent désormais comme des erreurs explicites au lieu de laisser l'agent silencieusement bloqué ([#947](https://github.com/getpaseo/paseo/pull/947))
- Les fournisseurs personnalisés qui étendent Codex s'acheminent maintenant correctement quand ils définissent un `OPENAI_BASE_URL` personnalisé ([#915](https://github.com/getpaseo/paseo/pull/915))
- Correction du mode **Allow All** de Copilot (renommé depuis Autopilot) ([#935](https://github.com/getpaseo/paseo/pull/935))
- Bureau : le démarrage du démon n'échoue plus quand un fichier PID obsolète est laissé à côté d'un démon encore en cours ([#913](https://github.com/getpaseo/paseo/pull/913) by [@biaoma-ty](https://github.com/biaoma-ty))
- Les photos HEIC de l'iPhone s'attachent désormais correctement depuis le sélecteur d'images ([#934](https://github.com/getpaseo/paseo/pull/934))
- Les agents planifiés s'archivent désormais automatiquement après chaque exécution ([#945](https://github.com/getpaseo/paseo/pull/945))
- Windows : les résumés de commandes Codex retirent les enrobages `pwsh`, `powershell` ou `cmd` ([#931](https://github.com/getpaseo/paseo/pull/931) by [@32r4](https://github.com/32r4))
- iPad : la barre latérale des réglages et la barre latérale principale respectent la zone de sécurité supérieure dans les mises en page larges ([#922](https://github.com/getpaseo/paseo/pull/922), [#937](https://github.com/getpaseo/paseo/pull/937) by [@kongjiadongyuan](https://github.com/kongjiadongyuan))

## 0.1.74 - 2026-05-11

### Corrections

- **Les tours d'agent OpenCode ne calent plus** Paseo suit désormais le flux d'événements global d'OpenCode, si bien que les tours se diffusent de façon fiable sans recourir à des chemins de récupération fragiles ([#916](https://github.com/getpaseo/paseo/pull/916))

## 0.1.73 - 2026-05-10

### Corrections

- **Les agents OpenCode fonctionnent à nouveau sur OpenCode 1.14.42+** ([#895](https://github.com/getpaseo/paseo/pull/895), [#902](https://github.com/getpaseo/paseo/pull/902), [#904](https://github.com/getpaseo/paseo/pull/904) by [@atomlink-ye](https://github.com/atomlink-ye), [@plutofog](https://github.com/plutofog))
- Web : l'ouverture d'un espace de travail ne se bloque plus dans les navigateurs dépourvus de `crypto.randomUUID` ([#858](https://github.com/getpaseo/paseo/pull/858) by [@cokekitten](https://github.com/cokekitten))
- Les appels d'outils enfants des sous-agents Codex signalent désormais un état d'échec final au lieu de rester « en cours » ([#899](https://github.com/getpaseo/paseo/pull/899))
- Les anciennes URL d'appairage de relais sans indicateur TLS explicite fonctionnent à nouveau ([#896](https://github.com/getpaseo/paseo/pull/896))
- macOS : le raccourci de saut d'onglet n'entre plus en conflit avec les raccourcis système ([#859](https://github.com/getpaseo/paseo/pull/859) by [@nikuscs](https://github.com/nikuscs))
- Web : le composeur ne déclenche plus de clavier en feuille inférieure sur les navigateurs de bureau ([#898](https://github.com/getpaseo/paseo/pull/898) by [@nikuscs](https://github.com/nikuscs))
- Windows : les opérations git ne font plus clignoter une fenêtre de console à chaque invocation ([#897](https://github.com/getpaseo/paseo/pull/897))
- L'explorateur de fichiers ne suit plus les symlinks en dehors de la racine de l'espace de travail ([#847](https://github.com/getpaseo/paseo/pull/847) by [@joaosa](https://github.com/joaosa))
- Le bureau n'ouvre les URL externes que via les schémas http(s) et mailto ([#845](https://github.com/getpaseo/paseo/pull/845) by [@joaosa](https://github.com/joaosa))
- Les journaux de requêtes de débogage MCP masquent désormais le corps des requêtes ([#842](https://github.com/getpaseo/paseo/pull/842) by [@joaosa](https://github.com/joaosa))

## 0.1.72 - 2026-05-10

### Corrections

- **Les demandes d'approbation Codex ne se bloquent plus** Corrige une régression introduite en 0.1.70 où les agents Codex attendaient indéfiniment les approbations de commandes et de fichiers — la demande n'atteignait jamais l'app et l'agent restait bloqué « en cours » ([#866](https://github.com/getpaseo/paseo/pull/866), [#869](https://github.com/getpaseo/paseo/pull/869))
- **Windows : le démon ne plante plus quand Codex émet une sortie non-JSON** Les lignes de stdout localisées de la CLI Codex sont désormais ignorées au lieu de faire tomber le worker du démon ([#866](https://github.com/getpaseo/paseo/pull/866))
- Le glisser-déposer d'images sur l'écran de nouvel espace de travail fonctionne désormais ([#850](https://github.com/getpaseo/paseo/pull/850))
- Archiver un worktree depuis la barre d'outils vous redirige immédiatement au lieu de vous laisser un instant sur l'écran mort ([#852](https://github.com/getpaseo/paseo/pull/852))
- Les sessions basées sur Pi s'arrêtent désormais proprement quand vous les fermez, libérant les ressources d'extension côté Pi ([#863](https://github.com/getpaseo/paseo/pull/863))

## 0.1.71 - 2026-05-09

### Ajouts

- **Importez des sessions Claude, Codex et OpenCode existantes** dans Paseo — reprenez une conversation que vous avez démarrée dans le terminal et continuez depuis l'app, avec la chronologie complète ([#766](https://github.com/getpaseo/paseo/pull/766), [#833](https://github.com/getpaseo/paseo/pull/833))
- **Les sous-agents apparaissent désormais dans une section repliable au-dessus du composeur** pour que vous puissiez rejoindre les agents que votre agent principal a lancés ([#532](https://github.com/getpaseo/paseo/pull/532))
- Fusionnez une pull request directement depuis le panneau de checkout ([#814](https://github.com/getpaseo/paseo/pull/814))
- Personnalisez, par projet, les prompts que Paseo utilise pour générer automatiquement les titres d'agents, les noms de branche, les messages de commit et les descriptions de pull request ([#836](https://github.com/getpaseo/paseo/pull/836))
- Ouvrez un espace de travail vide sans taper de prompt au préalable ([#834](https://github.com/getpaseo/paseo/pull/834))
- Les réglages de projet sont désormais regroupés avec des liens intégrés vers les docs pertinentes ([#837](https://github.com/getpaseo/paseo/pull/837))
- Menu contextuel riche sur le bureau — copier le lien, copier l'image et suggestions de correction orthographique
- Archiver un agent basé sur Codex archive désormais aussi le fil Codex natif sous-jacent ([#827](https://github.com/getpaseo/paseo/pull/827) by [@32r4](https://github.com/32r4))

### Améliorations

- Ouvrir un espace de travail met automatiquement le focus sur l'agent qui réclame votre attention ([#828](https://github.com/getpaseo/paseo/pull/828))
- Un agent sans surveillance qui lance un sous-agent sur un autre fournisseur via MCP démarre désormais ce sous-agent en mode sans surveillance également

### Corrections

- Le sélecteur de projet iOS soumet désormais le chemin saisi ([#831](https://github.com/getpaseo/paseo/pull/831))
- Les messages système et les mentions de chat routés vers plusieurs agents atteignent désormais chaque destinataire de façon cohérente ([#830](https://github.com/getpaseo/paseo/pull/830))
- Cliquer sur un lien Markdown dans la sortie d'agent ne recharge plus l'app de bureau par-dessus l'ouverture du lien
- Les raccourcis de saut d'onglet du bureau macOS utilisent désormais Cmd+Option+1-9, évitant les conflits avec les caractères de clavier internationaux basés sur Option comme `@`

### Sécurité

- Les fichiers d'état local (paire de clés du démon, identifiants stockés, configuration persistée) ne sont désormais lisibles que par l'utilisateur propriétaire ([#825](https://github.com/getpaseo/paseo/pull/825) by [@joaosa](https://github.com/joaosa))

## 0.1.70 - 2026-05-08

### Changements incompatibles

- **Les agents Claude nécessitent désormais `claude` dans votre PATH** Installez Claude Code globalement (`npm install -g @anthropic-ai/claude-code`) avant de lancer un agent Claude — Paseo ne fournit plus de binaire de secours intégré. Même approche que Codex et OpenCode, et cela allège l'installation bureau d'environ 210 Mo par plateforme

### Ajouts

- **Fournisseurs ACP en un clic** — ajoutez Cursor, Hermes, Qwen Coder, Kimi Code et d'autres agents ACP depuis un catalogue intégré au lieu d'écrire la configuration à la main
- Commande slash `/goal` pour Codex — définissez ou modifiez l'objectif en cours de tour pendant qu'un agent Codex tourne
- Le modèle Sonnet 4.6 à contexte 1M de Claude est désormais sélectionnable dans le sélecteur de modèles
- Détection des URL d'issues et de PR GitHub collées dans la recherche du composeur
- Commande CLI `paseo worktree create`, à parité avec l'outil MCP `create_worktree`
- `paseo schedule update` pour modifier un planning sur place sans le recréer
- `paseo schedule run-once` pour des déclenchements de type cron, plus l'option `--mode` sur `schedule` et `loop`. Les exécutions en arrière-plan passent désormais par défaut en mode sans surveillance
- Les paramètres de projets listent désormais les workspaces de n'importe quel remote — GitLab, Gitea, Bitbucket, auto-hébergés et URL de type SSH, pas seulement GitHub ([#681](https://github.com/getpaseo/paseo/pull/681) by [@krumpyzoid](https://github.com/krumpyzoid))

### Améliorations

- Les skills s'installent, se mettent à jour et se désinstallent à la demande au lieu d'une synchronisation automatique silencieuse à chaque lancement du bureau
- Les relais auto-hébergés peuvent opter pour `wss://` pour des connexions TLS
- Les cibles d'ouverture de workspace n'affichent que les options accessibles depuis le démon actuel
- La recherche du combobox correspond aux descriptions des modèles, pas seulement aux noms
- Les images jointes de Codex s'affichent en ligne sous forme de markdown de chemin
- Les notifications de tâches de sous-agents n'encombrent plus la timeline de l'agent parent
- Mode vocal : tonalité de réflexion plus discrète et petites finitions d'interface
- Ordre de la barre latérale des paramètres : Projets apparaît désormais après Général
- Electron mis à jour vers 41.2.0 pour l'application bureau

### Corrections

- **Agent Claude : le démon ne plante plus en cours de tour** lorsque le SDK sous-jacent émet un message de contrôle parasite après la fermeture de la connexion
- **Windows :** les terminaux démarrent de façon fiable et s'arrêtent proprement sans laisser de processus bloqués
- **Linux :** les surveillants de fichiers de workspace ne génèrent plus de tempêtes d'événements sur les arbres de travail chargés, corrigeant les pics de CPU sur les gros dépôts ([#794](https://github.com/getpaseo/paseo/pull/794) by [@312223105](https://github.com/312223105))
- Les agents basés sur ACP lancent les commandes shell du terminal de façon fiable ([#793](https://github.com/getpaseo/paseo/pull/793) by [@ebg1223](https://github.com/ebg1223))
- Le résumé court du checkout compte désormais les fichiers non suivis ([#608](https://github.com/getpaseo/paseo/issues/608), [#762](https://github.com/getpaseo/paseo/pull/762) by [@somus](https://github.com/somus))
- Les points de terminaison de relais sur le port 443 utilisent automatiquement TLS ([#774](https://github.com/getpaseo/paseo/pull/774) by [@caoer](https://github.com/caoer))
- Gestion du TTY en passthrough de la CLI bureau — les commandes interactives se comportent désormais correctement lorsqu'elles sont lancées depuis l'application bureau
- La CLI respecte la variable d'environnement `PASEO_PASSWORD` pour les démons protégés par mot de passe
- L'arrêt du démon termine proprement tous les processus enfants via tree-kill
- Les chemins de lancement d'agents gèrent plus fiablement les exécutables manquants et les dispositions d'installation inhabituelles
- OpenCode transmet désormais les erreurs de nouvelle tentative du fournisseur au lieu de les avaler silencieusement
- L'import Codex ne revient plus au mauvais mode par défaut
- Les raccourcis clavier des panneaux ne se déclenchent plus pendant que vous tapez dans un champ éditable
- La navigation vers une URL de workspace à froid atterrit désormais dans la bonne entrée de barre latérale sur le web
- Régression de navigation de workspace corrigée sur le web
- Navigation shell de workspace en double éliminée
- L'encart « Mise à jour installée » ne clignote plus par erreur
- Gestion du focus au rechargement et des devtools du panneau navigateur
- La capture de terminal MCP inclut désormais l'historique de défilement
- Les branches de worktree ne sont plus renommées lorsqu'un agent est créé sur un worktree existant depuis MCP
- Créer un agent dans un sous-répertoire d'un workspace enregistré s'exécute désormais dans ce sous-répertoire au lieu de remonter au parent ([#551](https://github.com/getpaseo/paseo/issues/551))
- Les noms d'affichage des projets non-GitHub sont dérivés du propriétaire/dépôt du remote plutôt que du chemin local
- L'IPC bureau est encapsulé dans des hooks de mutation/requête partagés, corrigeant les états obsolètes et les échecs intermittents ([#761](https://github.com/getpaseo/paseo/issues/761))
- `paseo schedule create --host` exige désormais `--cwd` pour éviter d'exécuter des plannings dans le mauvais répertoire
- `paseo schedule create --every` s'exécute une fois immédiatement par défaut, puis à l'intervalle configuré
- L'outil MCP `create_agent` valide le mode demandé et refuse l'héritage silencieux entre fournisseurs

## 0.1.69 - 2026-05-05

### Corrections

- Paseo se rétablit désormais automatiquement lorsqu'un processus interne du démon plante — vos agents restent connectés au lieu de rester bloqués, et vous n'avez rien à redémarrer
- Répondre à une question interactive d'un agent Claude atteint désormais correctement Claude au lieu d'être perdu ([#760](https://github.com/getpaseo/paseo/pull/760) by [@somus](https://github.com/somus))

## 0.1.68 - 2026-05-05

### Corrections

- L'application bureau ne plante plus au premier lancement après une nouvelle installation

## 0.1.67 - 2026-05-03

### Corrections

- Archiver un worktree ou un workspace paraît instantané au lieu d'attendre le démon, avec restauration automatique en cas d'échec
- La bascule du démon intégré dans les paramètres bureau prend désormais réellement effet
- Les paramètres bureau ne se réinitialisent plus au lancement de l'application après une migration ancienne
- Les échecs de démarrage du démon bureau apparaissent désormais sur l'écran de démarrage et répondent à la nouvelle tentative, au lieu de laisser l'application silencieusement bloquée
- Les appels LLM internes (noms de branches, messages de commit, textes de PR) ne laissent plus de sessions d'agent éphémères dans l'historique de votre fournisseur

## 0.1.66 - 2026-05-03

### Corrections

- Le markdown en streaming préserve les sauts de ligne finaux, de sorte que l'espacement des paragraphes reste correct pendant que l'agent est encore en train d'écrire
- Les échecs d'initialisation d'agent apparaissent en moins de 30 secondes au lieu de 5 minutes
- Les terminaux répondent aux requêtes ANSI de position du curseur, de sorte que les outils qui demandent l'emplacement du curseur ne se bloquent plus

## 0.1.65 - 2026-05-03

### Ajouts

- **Navigateur intégré** — ouvrez un vrai navigateur web dans n'importe quel workspace pour tester votre application ([#670](https://github.com/getpaseo/paseo/pull/670) by [@jasonkneen](https://github.com/jasonkneen))
- Commentaires de revue en ligne dans le panneau de diff git. Touchez un numéro de ligne pour démarrer un commentaire ([#530](https://github.com/getpaseo/paseo/pull/530))
- L'activité des sous-agents est désormais affichée pour Codex, OpenCode et Claude ([#672](https://github.com/getpaseo/paseo/pull/672), [#658](https://github.com/getpaseo/paseo/pull/658) by [@thisisryanswift](https://github.com/thisisryanswift))
- Tirez et poussez votre branche en une étape depuis le menu d'actions git dans le panneau des changements
- Reprenez des sessions d'agent existantes avec `paseo import --provider <name> <id>` ([#632](https://github.com/getpaseo/paseo/pull/632))
- Authentification par mot de passe et prise en charge SSL pour les connexions au démon ([#635](https://github.com/getpaseo/paseo/pull/635))
- Connectez-vous à un démon via relais à l'aide d'une URL d'offre d'appairage depuis la CLI ([#639](https://github.com/getpaseo/paseo/pull/639))
- **Windows :** des builds ARM64 natifs sont désormais disponibles
- Les skills Paseo intégrées se rafraîchissent désormais automatiquement au lancement de l'application bureau

### Améliorations

- Le streaming de Codex paraît plus réactif — les limites de messages sont préservées et la sortie arrive plus tôt
- Les sessions de terminal s'exécutent dans un processus worker dédié pour une meilleure stabilité
- Les noms des nouvelles branches de worktree sont dérivés de votre prompt et de vos pièces jointes au lieu d'un espace réservé générique
- L'interface des commentaires de revue est plus épurée et plus facile à parcourir
- Le point de terminaison `/api/status` du démon est désormais protégé par authentification par mot de passe lorsqu'il en est configuré un

### Corrections

- **Mac Apple Silicon :** le pipeline de mise à jour bureau publie désormais les manifestes de façon atomique, fermant une course qui pouvait installer la version Intel sur les Mac Apple Silicon et provoquer une utilisation CPU du moteur de rendu supérieure à 100 %. Les utilisateurs affectés se corrigeront d'eux-mêmes — la détection Rosetta d'electron-updater bascule à nouveau vers arm64 au prochain sondage de mise à jour ([#555](https://github.com/getpaseo/paseo/issues/555))
- **Linux :** les paquets `.deb` et `.rpm` s'affichent désormais comme `Paseo` dans le dock et la liste des processus au lieu de `Paseo.bin`. `--no-sandbox` est désormais limité à AppImage uniquement, correspondant à la gestion du bac à sable de VS Code ([#602](https://github.com/getpaseo/paseo/issues/602))
- **Windows :** les commandes de diff git ne cassent plus sur les chemins comportant des caractères spéciaux ([#629](https://github.com/getpaseo/paseo/pull/629))
- La CLI Cursor et d'autres fournisseurs ACP personnalisés se lancent de façon fiable ([#628](https://github.com/getpaseo/paseo/pull/628))
- Le démon reste actif lorsque des clients WebSocket se déconnectent en cours de stream, et les plantages écrivent désormais une entrée de log fatale au lieu de disparaître silencieusement ([#613](https://github.com/getpaseo/paseo/pull/613) by [@yuruiz](https://github.com/yuruiz))
- Les longues timelines d'agents se reconnectent proprement via le relais au lieu de boucler à travers des déconnexions pendant le rattrapage ([#657](https://github.com/getpaseo/paseo/pull/657) by [@fireblue](https://github.com/fireblue))
- Les timelines d'agents se rafraîchissent avec des requêtes de rattrapage plus petites lorsque vous rouvrez un agent
- Les instantanés de terminal se vident de façon fiable avant que les clients ne se reconnectent
- Les reconnexions de workspace évitent le travail de rafraîchissement inutile lorsque le workspace focalisé est déjà à jour
- La dictée vocale continue d'enregistrer lorsque l'onglet de l'agent perd le focus
- Le sélecteur de mode OpenCode liste désormais les agents disponibles dans chaque mode ([#606](https://github.com/getpaseo/paseo/pull/606) by [@thisisryanswift](https://github.com/thisisryanswift))
- Les panneaux d'approbation de plan Codex ne se dupliquent plus
- Les agents importés affichent immédiatement le bon titre
- OpenCode fait remonter les erreurs de mode/modèle invalides au lieu de se bloquer
- Les worktrees archivés restent masqués sans réapparaître par intermittence dans la liste ([#640](https://github.com/getpaseo/paseo/pull/640))
- Les menus déroulants web ne se redimensionnent plus de façon inattendue
- Le panneau des changements visibles reste synchronisé avec le diff de l'arbre de travail
- Les lignes de détail d'appels d'outils sur la timeline sont à nouveau sélectionnables
- Les erreurs d'analyse de `paseo.json` dans les actions de setup, teardown et terminal font désormais remonter une erreur claire au lieu d'échouer silencieusement
- Les numéros de ligne de la gouttière de diff étaient décalés d'une ligne dans certains cas sur le web
- La sortie d'agent en streaming se réconcilie proprement lorsque la timeline s'hydrate en cours de tour ([#663](https://github.com/getpaseo/paseo/pull/663))
- Les images dans les messages de l'assistant affichent un indicateur de chargement pendant le chargement et un repli « Image indisponible » en cas d'échec, au lieu d'un espace vide
- Les feuilles modales isolées du bas se ferment et se rouvrent sans rester bloquées

## 0.1.64 - 2026-04-28

### Ajouts

- OpenCode dispose désormais d'un mode Accès complet qui approuve automatiquement les appels d'outils ([#595](https://github.com/getpaseo/paseo/pull/595) by [@tmih06](https://github.com/tmih06))
- OpenCode prend en charge les commandes slash exécutables ([#597](https://github.com/getpaseo/paseo/pull/597) by [@tmih06](https://github.com/tmih06))

### Améliorations

- La mention `@` reste réactive sur de très gros projets ([#600](https://github.com/getpaseo/paseo/pull/600) by [@yuruiz](https://github.com/yuruiz))

### Corrections

- Les workspaces se chargent toujours lorsque `paseo.json` comporte une erreur d'analyse

## 0.1.63 - 2026-04-28

### Ajouts

- Page de paramètres de projet avec un éditeur `paseo.json` intégré
- Le démarrage à froid restaure votre dernier workspace ouvert
- Les badges d'appels d'outils comportent un bouton pour ouvrir directement le fichier référencé
- Ouvrez la branche actuelle sur GitHub depuis le menu d'ouverture d'un workspace ([#583](https://github.com/getpaseo/paseo/pull/583) by [@Myriad-Dreamin](https://github.com/Myriad-Dreamin))
- Activez ou désactivez des fournisseurs depuis les Paramètres sans éditer de fichiers de configuration
- Paseo vous invite à configurer un script de setup de worktree lorsqu'il en manque un
- Choisissez si le démon s'arrête lorsque vous fermez l'application bureau

### Améliorations

- Les paramètres de fournisseurs et la sélection de modèles ont été repensés
- Le point de terminaison de transcription du mode vocal est configurable pour les fournisseurs compatibles OpenAI ([#570](https://github.com/getpaseo/paseo/pull/570) by [@yuruiz](https://github.com/yuruiz))
- Ajouter un projet n'attend plus le chargement de l'état des PR GitHub
- L'écran de démarrage est plus épuré — juste le logo avec un léger miroitement
- Le setup et le teardown de `paseo.json` acceptent une simple chaîne de commande, pas seulement un tableau
- Archiver un worktree est instantané au lieu d'attendre la confirmation du backend
- Les timelines d'agents et les listes de diff git ne sautillent plus pendant le chargement ou le streaming

### Corrections

- `paseo loop run` et `paseo run` respectent désormais les options `--provider` et `--model` ([#594](https://github.com/getpaseo/paseo/pull/594) by [@VincenzoRocchi](https://github.com/VincenzoRocchi))
- Le fournisseur Pi apparaît lorsque seules des clés d'API DeepSeek ou d'autres clés non OpenAI/Anthropic/OpenRouter sont définies
- Les modèles personnalisés d'`additionalModels` et `profileModels` sont respectés lors du choix d'un modèle par défaut pour les nouveaux agents
- Les numéros de ligne d'aperçu de fichier restent sur une seule ligne au-delà de la ligne 99
- Cmd+Q sur macOS quitte l'application bureau au lieu de la laisser tourner en arrière-plan
- Les sessions de terminal se rétablissent proprement après des ratés de rendu, y compris le redimensionnement initial pour nvim
- Les réponses aux requêtes de protocole de terminal ne fuient plus dans le navigateur
- La couleur des liens de l'assistant correspond à nouveau au thème
- Les liens de fichiers avec numéros de ligne (comme `foo.ts:42`) s'ouvrent correctement depuis les messages de l'assistant
- Les résultats Grep de Claude s'affichent dans le corps de détail de recherche
- Rouvrir un worktree l'atterrit sous le bon projet
- Les agents de fournisseurs désactivés ou indisponibles restent visibles dans l'historique
- Les nouveaux agents CLI exigent désormais un fournisseur au lieu d'échouer silencieusement
- Les en-têtes de diff git ne se tronquent plus
- Le modal de diagnostic de fournisseur défile sur les petits écrans
- Les diagnostics de fournisseur affichent l'erreur réelle et la sortie du processus enfant sous-jacent au lieu d'un message générique
- Les workspaces archivés n'interfèrent plus avec la résolution du répertoire de travail
- Un triple-clic sur un message n'étend plus la sélection aux bulles adjacentes
- L'application bureau packagée préserve votre prompt zsh

## 0.1.62 - 2026-04-23

### Ajouts

- Avertissement dans la barre latérale lorsque les versions de votre application et de votre démon divergent, avec un raccourci vers les paramètres

### Améliorations

- Les workspaces apparaissent dans la barre latérale immédiatement au démarrage au lieu d'attendre l'enregistrement git

### Corrections

- L'état des pull requests se résout correctement pour les PR ouvertes depuis des forks
- L'installation de la CLI paseo depuis l'application bureau macOS fonctionne désormais dans les builds packagés
- Les agents lancés depuis l'application bureau n'héritent plus de variables d'environnement propres à Electron

## 0.1.61 - 2026-04-23

### Ajouts

- L'option `additionalModels` dans la configuration de fournisseur vous permet d'ajouter ou de renommer des modèles sans remplacer la liste complète — les entrées fusionnent avec les modèles découverts à l'exécution (ACP) ou votre liste statique `models`. Voir la [documentation Providers](https://paseo.sh/docs/providers)
- Nouvelle [page de documentation Providers](https://paseo.sh/docs/providers) couvrant les fournisseurs de premier plan et tous les schémas de configuration de fournisseurs personnalisés en un seul endroit

### Améliorations

- Pi charge vos extensions installées au démarrage afin que leurs modèles apparaissent dans le sélecteur de modèles
- Redimensionner la barre latérale de l'explorateur ne re-rend plus le reste du workspace
- Les images dans les messages de l'assistant (chemins de fichiers et URL de données en ligne) persistent comme pièces jointes locales et s'ouvrent dans le panneau de fichiers

## 0.1.60 - 2026-04-22

### Ajouts

- Scripts et services par worktree — définissez des commandes nommées dans `paseo.json`, et les services de longue durée sont supervisés avec leurs propres ports et de jolies URL de proxy comme `http://web.my-app.localhost:6767`. Voir le [guide des worktrees](https://paseo.sh/docs/worktrees)
- Lancez les scripts et services d'un worktree directement depuis l'en-tête du workspace
- Nouvel onglet Setup dans chaque workspace affichant en direct la progression du setup, du teardown et des scripts
- Vérifications GitHub et revues de PR dans la barre latérale de l'explorateur, avec une carte au survol pour le détail complet
- Le nouveau flux de création de worktree vous permet de choisir une branche de base ou de récupérer une pull request GitHub existante
- Attachez des issues et pull requests GitHub à un agent dans le cadre du contexte de son prompt
- Panneau de pull requests dans la barre latérale du workspace
- Écran de paramètres repensé avec une navigation modulaire par section
- Configuration de fournisseurs par hôte — définissez fournisseurs, modèles et identifiants indépendamment sur chaque hôte distant
- L'intégration directe de Pi remplace le pont ACP, avec un streaming plus rapide et moins de ratés
- Canal de version bêta — inscrivez-vous depuis les Paramètres pour recevoir les builds bureau bêta avant leur promotion en stable
- Le sélecteur de nouveau workspace classe les branches par récence avec une recherche rapide

### Améliorations

- Le changement de workspace et d'onglet est nettement plus rapide sur bureau et mobile — vous pouvez garder de nombreux workspaces ouverts en parallèle sans latence
- Les streams d'agents s'affichent plus fluidement pendant une forte sortie d'outils
- Le démarrage de l'application passe par une connexion stable et atterrit sur le bon écran sans scintillement
- Le rafraîchissement des fournisseurs est fiable et ne bloque plus sur des échecs transitoires
- L'état git et GitHub reste synchronisé avec les changements locaux comme les commits, changements de branche et pushs
- Les pièces jointes du composeur ont été repensées avec une disposition de pastilles plus épurée et une visionneuse d'images
- Les notifications intégrées à l'application sont dirigées vers la surface que vous regardez réellement
- Les raccourcis clavier continuent de fonctionner pendant que les Paramètres sont ouverts
- Échap interrompt de façon fiable l'agent actif
- Récupérer une pull request depuis un fork atterrit sur une branche préfixée du propriétaire afin que plusieurs forks ne se télescopent pas
- `paseo ls` liste par défaut les agents actifs ; passez `-a` pour inclure les archivés
- Le sélecteur de branches et de PR GitHub se charge plus vite — les requêtes sont différées jusqu'à l'ouverture du sélecteur

### Corrections

- La zone de texte du composeur se rétracte après l'envoi sur le web
- Les brouillons de nouveau workspace se vident après l'envoi au lieu de rester
- Remplacer un agent en cours d'exécution nettoie le précédent sans le laisser traîner
- Les notifications d'agents ne sont plus avalées par un client focalisé mis en arrière-plan
- Les dossiers de workspace supprimés disparaissent à nouveau de la liste des workspaces
- Codex conserve le mode rapide après que vous approuvez un plan ([#526](https://github.com/getpaseo/paseo/pull/526) by [@therainisme](https://github.com/therainisme))
- Le focus de l'onglet de workspace est préservé entre les rafraîchissements de page
- L'écran de paramètres ne repousse plus son en-tête vers le bas avec un espacement supplémentaire
- Le titre du commutateur de branches ne déborde plus sur les lignes étroites
- Le sélecteur d'images iOS ne laisse plus l'écran insensible après annulation
- Archiver un worktree se rétablit proprement si une tentative précédente a été interrompue
- Les images dans les messages d'agents avec des chemins préfixés par `~` se chargent au lieu de tourner indéfiniment
- Les blocs d'appels d'outils s'étendent correctement sur mobile pendant qu'un agent est encore en streaming
- La timeline ne saccade plus lorsque les plages de rattrapage et projetées se chevauchent
- Codex n'affiche plus « inactif » par intermittence lorsqu'un tour de remplacement est en cours
- L'état de branche se rétablit correctement lorsqu'un rebase est en cours
- La carte de survol de workspace ne se coupe plus près des bords de l'écran

## 0.1.59 - 2026-04-16

### Ajouts

- Opus 4.7 dans le sélecteur de modèles Claude, avec une variante à contexte 1M
- Effort de réflexion Extra High pour Opus 4.7, entre High et Max

## 0.1.58 - 2026-04-16

### Ajouts

- Les fichiers markdown s'affichent sous forme de markdown formaté dans le panneau de fichiers ([#427](https://github.com/getpaseo/paseo/pull/427) by [@aaronflorey](https://github.com/aaronflorey))
- Cmd+L (Ctrl+L sur Windows/Linux) place le focus sur le champ de saisie de message de l'agent
- Les modèles des fournisseurs se rafraîchissent selon un TTL de fraîcheur ; les Paramètres affichent l'heure de dernière mise à jour et toute erreur de récupération ([#426](https://github.com/getpaseo/paseo/pull/426))
- Option `disallowedTools` dans la configuration de fournisseur pour bloquer des outils spécifiques d'un agent

### Améliorations

- Windows : les agents se lancent de façon fiable depuis les shims `.cmd` de npm, les chemins comportant des espaces et les arguments de configuration JSON — corrige les erreurs de démarrage `spawn EINVAL` ([#454](https://github.com/getpaseo/paseo/pull/454))
- Les invites de permission OpenCode incluent le contexte de l'outil demandeur ([#398](https://github.com/getpaseo/paseo/pull/398) by [@aaronflorey](https://github.com/aaronflorey))
- Les événements de todo et de compaction d'OpenCode s'affichent dans la timeline ([#429](https://github.com/getpaseo/paseo/pull/429) by [@aaronflorey](https://github.com/aaronflorey))
- Les sessions OpenCode s'archivent proprement à la fermeture ([#408](https://github.com/getpaseo/paseo/pull/408) by [@aaronflorey](https://github.com/aaronflorey))
- Les commandes slash d'OpenCode se rétablissent après des délais d'expiration SSE ([#407](https://github.com/getpaseo/paseo/pull/407) by [@aaronflorey](https://github.com/aaronflorey))
- Les outils MCP de Paseo fonctionnent sur les agents archivés, à parité avec la CLI ([#423](https://github.com/getpaseo/paseo/pull/423))
- Les barres de défilement natives correspondent au thème actif dans toutes les vues web ([#399](https://github.com/getpaseo/paseo/pull/399) by [@ethersh](https://github.com/ethersh))

### Corrections

- Les aperçus de fichiers de code peuvent être sélectionnés et copiés sur iOS ([#447](https://github.com/getpaseo/paseo/pull/447) by [@muzhi1991](https://github.com/muzhi1991))
- L'aperçu de fichier n'affiche plus de contenu obsolète lors de la réouverture du même fichier ([#411](https://github.com/getpaseo/paseo/pull/411) by [@muzhi1991](https://github.com/muzhi1991))
- L'explorateur de fichiers se réinitialise lorsque le client se reconnecte après un rafraîchissement de page ([#442](https://github.com/getpaseo/paseo/pull/442) by [@1996fanrui](https://github.com/1996fanrui))
- Les fournisseurs ACP génériques ne reçoivent plus d'arguments de commande dupliqués ([#444](https://github.com/getpaseo/paseo/pull/444) by [@edvardchen](https://github.com/edvardchen))
- Les en-têtes de workspace n'affichent plus d'icône de branche pour les workspaces non-git
- La disposition du commutateur de branches est stable sur mobile
- Les noms de modèles ne se tronquent plus en plein mot dans les lignes du sélecteur
- Les messages apparaissent dans le bon ordre après une reconnexion sur mobile
- Effacer l'attention de l'agent ne génère plus d'erreur en cas de délai d'expiration

## 0.1.56 - 2026-04-14

### Corrections

- Les projets avec des dépôts git vides (encore aucun commit) ne font plus planter l'application au démarrage
- Un seul projet problématique ne peut plus empêcher le reste de vos workspaces de se charger

## 0.1.55 - 2026-04-14

### Ajouts

- Profils de fournisseurs — définissez des fournisseurs personnalisés dans votre configuration Paseo qui apparaissent aux côtés des intégrés. Remplacez le binaire, l'environnement ou les modèles d'un fournisseur intégré, ou créez des fournisseurs entièrement nouveaux. Voir le [guide de configuration](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)
- Prise en charge des agents ACP — ajoutez n'importe quel agent compatible ACP à Paseo avec `extends: "acp"` dans votre configuration de fournisseur. Aucune modification de code nécessaire
- Choisissez le fournisseur et le modèle lors de la création d'agents planifiés
- Option d'effort de réflexion Max pour les modèles Opus 4.6
- Cmd+, (Ctrl+, sur Windows/Linux) ouvre les paramètres

### Améliorations

- Les opérations git sont nettement plus rapides — le statut du workspace, les vérifications de PR et les données de branche utilisent tous un service d'instantané mis en cache partagé au lieu d'invoquer git à chaque requête. Faire tourner plus de 20 workspaces simultanément est désormais fluide
- Prise en charge de Windows — le démon et la CLI s'exécutent nativement sur Windows avec une gestion correcte des guillemets de shell, de la résolution d'exécutables et des chemins
- Les dispositions iPad et tablette fonctionnent correctement sur toutes les tailles d'écran
- La composition IME (saisie chinoise, japonaise, coréenne) ne soumet plus prématurément à l'appui sur Entrée

### Corrections

- Créer un worktree ne le fait plus clignoter brièvement comme un projet autonome avant de le placer sous le bon dépôt
- L'indicateur de création de worktree reste visible tout au long du processus au lieu de disparaître au passage de la souris
- La navigation de workspace se met à jour correctement lors du passage entre workspaces d'un même projet
- L'alignement de l'en-tête de workspace bureau et le sélecteur de modèles ne débordent plus sur les fenêtres étroites
- Les indicateurs de chargement sont visibles en mode clair

## 0.1.54 - 2026-04-12

### Ajouts

- Aperçus d'images en ligne dans les messages d'agents — les captures d'écran et images générées par les agents s'affichent directement dans la conversation au lieu d'apparaître comme des liens markdown bruts

### Améliorations

- Les outils Paseo ne sont plus injectés dans les agents par défaut — inscrivez-vous depuis les Paramètres lorsque vous avez besoin d'orchestration entre agents
- Le fournisseur et le mode de l'agent sont désormais résolus côté serveur, de sorte que les commandes CLI comme `paseo run` utilisent des valeurs par défaut cohérentes sans recherches côté client

### Corrections

- Shift+Entrée insère désormais correctement un saut de ligne dans la saisie de terminal d'agent au lieu de soumettre
- Windows : la configuration MCP n'est plus altérée lors du lancement d'agents Claude
- Le décompte d'avance/retard de branche ne génère plus d'erreur pour les branches sans branche de suivi distante

## 0.1.53 - 2026-04-12

### Ajouts

- Les agents obtiennent automatiquement les outils Paseo — chaque nouvel agent accède aux terminaux, plannings, worktrees et autres agents via MCP. Désactivez-le dans les Paramètres sous « Injecter les outils Paseo »
- Git pull — tirez les changements distants directement depuis l'en-tête du workspace. Promu en action principale lorsque votre branche est en retard sur origin
- Notifications d'agents enfants — les agents parents sont automatiquement notifiés lorsqu'un agent enfant se termine, échoue ou nécessite une approbation de permission
- Rechargement d'agent — `paseo agent reload` redémarre le processus sous-jacent d'un agent depuis la CLI
- Clic du milieu pour fermer les onglets sur bureau
- Raccourci clavier pour parcourir les thèmes

### Améliorations

- Les actions git indisponibles expliquent désormais pourquoi dans un toast au lieu d'être grisées silencieusement
- Le markdown en streaming s'affiche nettement plus vite sur mobile
- La barre latérale, le commutateur de branches et le panneau d'agent ne se re-rendent plus inutilement — perceptible sur les gros workspaces
- Les appels d'outils Paseo dans les timelines d'agents affichent le logo Paseo et des noms lisibles
- Les URL de relais et d'appairage sont retirées des logs du démon

### Corrections

- Les onglets d'agents fermés ne réapparaissent plus après reconnexion
- Les décomptes de badge de notification bureau correspondent sur tous les workspaces
- Le statut du commutateur d'hôtes se synchronise correctement lors du passage entre hôtes

## 0.1.52 - 2026-04-10

### Ajouts

- Sélecteur de thème — choisissez parmi six thèmes dont les variantes sombres Midnight, Claude et Ghostty
- Changement de branche — changez de branche git directement depuis l'en-tête du workspace, avec stash et restauration automatiques des changements non commités
- Téléchargement automatique des mises à jour — les mises à jour bureau se téléchargent silencieusement en arrière-plan afin d'être prêtes à installer quand vous l'êtes

### Corrections

- La disposition réagit désormais correctement lors du redimensionnement de la fenêtre ou de la rotation d'une tablette — auparavant l'application pouvait rester bloquée en disposition mobile sur un grand écran
- Le terminal ne provoque plus de pics de mémoire massifs dus au brassage d'instantanés lors d'une forte sortie
- La saisie dans le terminal fonctionne de façon fiable — les touches spéciales, combinaisons Ctrl et collage sont gérées nativement par l'émulateur de terminal
- Les agents en cours d'initialisation n'affichent plus d'indicateur de chargement comme s'ils tournaient
- La reconnexion à un agent en cours d'exécution fonctionne désormais même lorsque la persistance de session est indisponible
- Les écrans d'erreur sur bureau sont désormais défilables
- La liste des modèles se rafraîchit en arrière-plan lorsque vous ouvrez le sélecteur de modèles
- Les préférences de fonctionnalités des brouillons d'agents (comme le mode réflexion) sont mémorisées entre les sessions

## 0.1.51 - 2026-04-09

### Ajouts

- Pièces jointes d'images pour OpenCode — attachez des captures d'écran et des images aux prompts d'agents OpenCode
- WebStorm — ajouté à la liste « Ouvrir dans l'éditeur » aux côtés de Cursor, VS Code et Zed
- Réglage du comportement d'envoi — choisissez si appuyer sur Entrée pendant qu'un agent tourne interrompt immédiatement ou met votre message en file d'attente

### Corrections

- Le sélecteur de modèles ne plante plus sur iPad
- L'appairage utilise désormais le bon nom d'hôte, corrigeant les échecs de connexion sur certaines configurations réseau
- Les agents OpenCode affichent le bon état de terminal et rafraîchissent les modèles de façon fiable
- Les messages de suivi aux agents qui viennent de terminer un tour fonctionnent désormais correctement
- Les commandes se chargent désormais correctement pour les agents Pi
- La sortie de débogage interne n'apparaît plus dans les timelines d'agents Claude
- L'écran de scan QR épuré avec des visuels simplifiés

## 0.1.50 - 2026-04-07

### Ajouts

- Jauge de fenêtre de contexte — voyez quelle part de la fenêtre de contexte votre agent a utilisée, avec des seuils de couleur à 70 % et 90 %. Fonctionne avec Claude Code, Codex et OpenCode
- Ouvrir dans l'éditeur — passez de n'importe quel workspace directement à Cursor, VS Code, Zed ou votre gestionnaire de fichiers. Paseo mémorise votre choix
- Diffs côte à côte — basculez entre les vues de diff unifiée et en colonnes séparées, avec une option de visibilité des espaces
- Messages parlés — en mode vocal, la parole de l'agent apparaît désormais comme des messages normaux dans la conversation au lieu de sortie d'outil brute
- Actions de plan — les cartes de plan affichent désormais les actions que votre agent prend en charge (par ex. « Implémenter », « Refuser ») au lieu de boutons génériques accepter/rejeter
- Fetch git en arrière-plan — les décomptes d'avance/retard dans le panneau des changements restent à jour automatiquement

### Améliorations

- Les workspaces se chargent instantanément à la connexion au lieu d'attendre une synchronisation complète
- L'explorateur de fichiers et le panneau de diff mémorisent quels dossiers sont dépliés lorsque vous changez d'onglet
- Fermer un onglet de workspace est désormais instantané
- Les Paramètres affichent un bouton Rafraîchir pour les fournisseurs et présentent les détails d'erreur en ligne
- L'action de rechargement d'agent a été éloignée du bouton de fermeture pour éviter les appuis accidentels

### Corrections

- Le mode vocal ne dérive plus vers de fausses détections de parole au cours de longues sessions
- Texte brouillé et superposé sur les cartes de plan
- Le panneau des changements pouvait afficher des diffs obsolètes en travaillant avec des worktrees git
- Redémarrer un agent rapidement pouvait faire planter la session
- Copilot ne s'arrête plus pour des invites de permission en mode autopilote
- Les dialogues de connexion et d'appairage s'affichent désormais correctement sur tablettes
- Les erreurs d'orchestration des agents sont désormais remontées au lieu d'être silencieusement perdues
- Les statistiques de diff ne se réinitialisent plus à zéro lors de la reconnexion

## 0.1.49 - 2026-04-07

### Corrections

- Les modèles et fournisseurs se chargent désormais de façon fiable à la première connexion au lieu d'exiger un rafraîchissement manuel
- Le sélecteur de modèles n'affiche que les modèles du fournisseur propre à l'agent, pas tous les fournisseurs du serveur
- Les listes de modèles restent cohérentes quel que soit l'écran que vous ouvrez en premier

## 0.1.48 - 2026-04-05

### Ajouts

- Diagnostics de fournisseur — touchez un fournisseur dans les Paramètres pour voir le chemin du binaire, la version, le nombre de modèles et le statut d'un coup d'œil. Aide à comprendre pourquoi un type d'agent est indisponible
- Système d'instantané de fournisseur — le démon pousse désormais en temps réel la disponibilité des fournisseurs et les listes de modèles vers l'application, remplaçant l'ancienne approche par sondage. Les modèles et modes se mettent à jour en direct à mesure que les fournisseurs se connectent ou se déconnectent
- Gestion des questions Codex — les agents Codex peuvent désormais poser des questions à l'utilisateur en cours de session (par ex. « quel fichier ? ») et recevoir des réponses en ligne, à parité avec le flux de questions de Claude Code
- Action de rechargement d'onglet — cliquez droit sur un onglet de workspace pour recharger sa liste d'agents sans redémarrer l'application

### Améliorations

- Sélecteur de modèles repensé — groupé par fournisseur avec badges de statut, recherche et de meilleures cibles tactiles sur mobile
- La touche Entrée soumet désormais les réponses des cartes de questions et confirme la dictée, à parité avec le flux clavier attendu
- Suppression des toasts bruyants de cycle de vie d'agent qui se déclenchaient à chaque changement d'état

### Corrections

- L'application bureau résout désormais l'environnement complet du shell de connexion de l'utilisateur au démarrage, corrigeant les outils comme `codex`, `node`, `bun` et `direnv` introuvables lorsque Paseo est lancé depuis le Finder ou le Dock. Les terminaux générés par Paseo héritent désormais du même PATH et des mêmes variables d'environnement qu'une session de terminal normale. Approche adaptée de la résolution éprouvée de l'environnement de shell de VS Code
- Le champ de saisie sur les écrans d'agents en cours d'exécution reçoit désormais correctement le focus clavier
- Alignement et dimensionnement du sélecteur de modèles mobile

## 0.1.47 - 2026-04-05

### Corrections

- TTS vocal dans Electron — sherpa demande désormais des tampons copiés et le pont MCP vocal définit `ELECTRON_RUN_AS_NODE`, évitant les plantages « external buffers not allowed »
- Appairage QR sur bureau — l'analyse de la sortie JSON de la CLI tolère désormais les avertissements de dépréciation de Node dans stdout
- Condition de course de segment STT — l'ID de segment et le tampon audio sont figés avant l'appel de transcription asynchrone, de sorte que des validations rapides ne s'entrelacent plus
- Bouton « Ajouter une connexion » par hôte supprimé — il bloquait les configurations multi-hôtes en limitant les nouvelles connexions à un seul serveur

## 0.1.46 - 2026-04-04

### Corrections

- Activation vocale dans les builds packagés — le modèle Silero VAD est désormais copié hors de l'archive asar d'Electron afin que le code natif puisse le lire
- Version de l'application envoyée dans le hello client de sonde afin que le filtre de version du démon ne masque plus Pi/Copilot des sessions reconnectées
- Schéma `worktreeRoot` rendu rétrocompatible pour les anciens clients et démons qui n'envoient pas le champ
- Avertissement de dépréciation Punycode (DEP0040) supprimé dans les points d'entrée de la CLI et du démon bureau

## 0.1.45 - 2026-04-04

### Ajouts

- Fournisseur d'agent Pi (pi.dev) — connectez Pi comme nouveau type d'agent avec des niveaux de réflexion et la prise en charge des appels d'outils
- Fournisseur d'agent Copilot réactivé après des corrections de compatibilité ACP
- `paseo .` et `paseo <path>` ouvrent l'application bureau avec le projet donné, comme `code .`
- Système de fonctionnalités déclarées par le fournisseur — les fournisseurs peuvent exposer des bascules et sélecteurs dynamiques que l'application affiche automatiquement. Premier client : le mode rapide de Codex
- Mode plan de Codex — démarrez des agents en mode plan uniquement avec une interface de carte de plan dédiée pour revoir les changements proposés avant exécution
- Agents personnalisés et commandes slash OpenCode — les agents définis par l'utilisateur dans opencode.json apparaissent désormais dans le sélecteur de mode, et les commandes slash acceptent des arguments optionnels
- Paramètres d'intégrations bureau — installez la CLI Paseo et les skills d'orchestration directement depuis l'application sans toucher au terminal
- Dialogue de statut du démon dans les paramètres bureau pour des vérifications de santé rapides
- Redémarrage automatique du démon en cas d'incompatibilité de version — l'application bureau détecte lorsque le démon en cours est obsolète et le redémarre automatiquement
- Astuce de configuration et lien paseo.sh sur l'écran d'accueil mobile afin que les nouveaux utilisateurs de l'App Store sachent quoi faire ensuite

### Améliorations

- Le démarrage bureau est plus rapide — les connexions au démon existantes sont mises en course contre le bootstrap afin que l'application soit utilisable plus tôt
- Sections de paramètres réordonnées pour un meilleur regroupement (intégrations et démon ensemble)
- Les projets et workspaces de la barre latérale persistent désormais entre les sessions, avec un menu contextuel pour retirer des projets

### Corrections

- Plantage de la barre latérale lors du changement de thème iOS (interaction Unistyles/Reanimated)
- Plantage Silero VAD causé par le mode de tampon externe dans CircularBuffer
- La fermeture groupée archive désormais correctement les agents stockés au lieu de laisser des orphelins
- Les agents archivés épinglés ne sont plus élagués lors de la fermeture d'onglets
- Famine du flux d'événements OpenCode pendant l'exécution de commandes slash
- Workspaces en double lorsque plusieurs worktrees git partagent la même racine
- Résolution de l'exécutable `gh` pour les utilisateurs bureau dont le shell de connexion définit un PATH différent
- Délai d'expiration de création d'agent porté à 60 s pour gérer les scénarios de premier lancement lents
- Gestion des fournisseurs compatible avec l'avenir afin que les anciens clients d'application ne cassent pas sur de nouveaux types de fournisseurs
- Condition de course de l'écouteur d'événements de saisie dans le hook de barre de défilement web
- Le contenu de l'écran d'ouverture de projet est désormais centré verticalement
- La page de téléchargement du site web récupère la version de release à l'exécution avec validation des ressources, corrigeant les liens obsolètes

## 0.1.44 - 2026-04-03

### Corrections

- L'application bureau arrête désormais proprement le démon avant que la mise à jour automatique ne redémarre
- Fournisseurs claude-acp et copilot désactivés du registre d'agents
- La résolution de portée du focus clavier vérifie désormais plusieurs candidats pour une compatibilité plus large
- L'interruption d'OpenCode atteint désormais la parité d'état de terminal correcte avec les flux d'appels d'outils
- Renforcement de la sécurité contre l'injection de shell, l'évasion par symlink et sur le point de terminaison d'appairage

## 0.1.43 - 2026-04-02

### Ajouts

- Prise en charge de l'agent Copilot via le fournisseur de base ACP — connectez GitHub Copilot comme nouveau type d'agent
- Favoris de modèles recherchables — trouvez et épinglez rapidement vos modèles préférés
- Prise en charge des commandes slash pour les agents OpenCode

### Améliorations

- UX du sélecteur de modèles affinée avec un meilleur comportement de feuille sur mobile
- Le statut de workspace utilise désormais un style d'alerte ambre pour l'état « saisie requise »
- Barre de défilement thématisée sur la saisie de message pour un style cohérent

### Corrections

- Le copier-coller Ctrl+C/V fonctionne désormais correctement dans le terminal sur Windows et Linux
- Les arguments de shell comportant des espaces sont désormais correctement mis entre guillemets sur Windows
- Les modèles Claude avec prise en charge du contexte 1M sont désormais correctement signalés

## 0.1.42 - 2026-04-01

### Corrections

- Correction du lancement de Claude Code qui échouait sur Windows lorsqu'installé dans un chemin comportant des espaces (par ex. `C:\Program Files\...`)

## 0.1.41 - 2026-04-01

### Corrections

- Correction du lancement des agents sous Windows — tous les fournisseurs (Claude, Codex, OpenCode) utilisent désormais le mode shell afin que les shims npm et les wrappers `.cmd` soient résolus correctement
- Correction de la création de terminal sous Windows qui basculait sur un shell Unix au lieu de `cmd.exe`
- Correction de la gestion des chemins dans toute l'application pour prendre en charge les chemins Windows avec lettre de lecteur (`C:\...`) et les chemins UNC (`\\...`)
- Correction de la résolution des exécutables sous Windows pour fonctionner avec `nvm4w` et les gestionnaires de versions Node similaires
- Suppression du flash blanc lors du redimensionnement de la fenêtre en mode sombre en alignant la couleur de fond native de la fenêtre sur le thème
- Correction de la zone de glissement de la barre de titre — l'approche fragile basée sur les événements pointeur est remplacée par le motif CSS statique `app-region: drag` éprouvé de VS Code
- Correction du menu contextuel copier/coller dans l'application desktop
- Correction de l'interface de réaffectation des raccourcis pour afficher les modificateurs maintenus et reconnaître des touches supplémentaires (Tab, Delete, Home, End, Page Up/Down, Insert, F1–F12)
- Suppression de la limite de 40 éléments sur la timeline d'activité pour que les longues sessions d'agent affichent tout leur historique

### Améliorations

- Amélioration du thème en mode clair avec un fond d'espace de travail dédié, des couleurs de poignée de barre de défilement et des ombres plus légères
- La surcouche des contrôles de fenêtre sous Windows/Linux passe de 48px à 29px de hauteur pour une barre de titre plus compacte

## 0.1.40 - 2026-04-01

### Ajouts

- Les onglets d'espace de travail peuvent désormais être fermés par lots

### Améliorations

- Les listes de modèles des fournisseurs sont désormais mises en cache par serveur et par fournisseur, réduisant les recherches de modèles redondantes dans l'interface

### Corrections

- Le contenu de raisonnement d'OpenCode n'apparaît plus dupliqué en tant que texte de l'assistant
- Le démon ne plante plus lorsqu'un binaire Codex est absent ou échoue à démarrer
- L'onglet Archive réconcilie désormais correctement la visibilité des agents après archivage
- Le suivi des différences de fichiers dans les espaces de travail fonctionne désormais correctement sous Linux
- La mise en page iPad s'affiche désormais correctement en mode desktop
- L'outil de mise à jour automatique macOS livre désormais correctement les binaires arm64 et x64 — auparavant, l'architecture compilée en dernier écrasait le manifeste de mise à jour de l'autre

## 0.1.39 - 2026-03-30

### Ajouts

- **Gestion des terminaux depuis la CLI** — le nouveau groupe de commandes `paseo terminal` permet de lister, créer et interagir avec les terminaux d'espace de travail sans quitter votre terminal
- **Icônes de fichiers Material dans l'explorateur** — l'arborescence de l'explorateur de fichiers affiche désormais des icônes spécifiques au langage (TypeScript, JSON, Markdown, etc.) pour repérer les fichiers d'un coup d'œil

### Corrections

- Correction du scintillement du défilement de la barre latérale sous iOS causé par un rognage de débordement redondant
- Centralisation du remplissage des contrôles de fenêtre dans un hook partagé, éliminant les incohérences de mise en page entre plateformes

## 0.1.38 - 2026-03-30

### Corrections

- Correction d'une situation de concurrence au démarrage du démon où l'application pouvait expirer lors de la première connexion parce que le fichier PID annonçait une adresse d'écoute avant que le serveur ne soit prêt
- Correction de la rotation des journaux du démon qui perdait les traces de démarrage — les journaux WebSocket de niveau trace n'incluent plus les charges utiles complètes des messages

## 0.1.37 - 2026-03-29

### Ajouts

- Contrôles de fenêtre personnalisés sous Windows et Linux — la barre de titre native est remplacée par des contrôles en surcouche assortis au design de l'application
- Journalisation de fichiers sur desktop avec electron-log pour faciliter le débogage des problèmes de démon et d'application

### Corrections

- Correction de la propagation défaillante du PATH et de la résolution du binaire Claude sous Windows
- Les erreurs de dictée affichent désormais un toast visible au lieu d'échouer silencieusement

## 0.1.36 - 2026-03-27

### Corrections

- Correction de la gestion des chemins Windows avec lettre de lecteur dans toute la base de code
- Correction d'un hash Nix obsolète grâce à la détection automatique des changements du fichier de verrouillage

### Ajouts

- Ajout de la collecte de métriques et de tests de performance des terminaux

## 0.1.35 - 2026-03-26

### Améliorations

- Démarrage de l'application plus rapide grâce à une redirection immédiate vers l'écran de bienvenue et à l'affichage en ligne de l'état de connexion à l'hôte
- Les suppressions de fichiers par Codex s'affichent désormais correctement comme lignes retirées dans les différences
- Les questions d'OpenCode sont désormais remontées dans l'interface des permissions

### Corrections

- Correction de l'envoi des prompts en file d'attente après la transition en veille
- Remplacement du `mapfile` propre à bash par une boucle `while-read` portable dans le script de chat

### Ajouts

- Ajout de la prise en charge de l'installation sous Nix et NixOS

## 0.1.34 - 2026-03-25

### Ajouts

- Ajout de `paseo archive` comme alias de premier niveau pour `paseo agent archive`
- Ajout de la variable d'environnement `PASEO_AGENT_ID` pour les agents Claude et Codex
- Ajout d'une autocomplétion de commandes repensée avec une carte de détail et un style de menu déroulant
- Liaison des surfaces de téléchargement Android au Google Play Store

### Améliorations

- Les tours autonomes se terminent désormais proprement lors d'une interruption au lieu d'être annulés
- La sélection de la réflexion/du modèle se résout désormais toujours sur une véritable option au lieu d'afficher un choix Défaut générique
- Restauration des préférences de formulaire par fournisseur et suppression du repli sur le modèle Auto
- Amélioration des journaux d'activité de Codex avec des résumés d'appels d'outils plus clairs
- Réduction des rendus inutiles dans le panneau d'agent et la zone de saisie pour une interaction plus fluide
- Amélioration de la lisibilité de la transcription de chat

### Corrections

- Correction de `paseo send --no-wait` qui ne prenait pas effet
- Correction des résultats d'abandon obsolètes contaminant les tours de remplacement après une interruption
- Correction de la gestion des interruptions de Claude et de la fiabilité du réveil autonome
- Correction de la détection des sessions Claude Code imbriquées et des vérifications de disponibilité des fournisseurs
- Correction du cadrage du focus de saisie des agents entre les panneaux
- Correction de l'ordre des instantanés de terminal lors de l'abonnement
- Correction de `chat read --since` pour accepter les identifiants de message
- Correction de la synchronisation du focus du volet clavier avec le panneau actif
- Correction de la sélection du texte de l'assistant sur le web
- Correction des notifications d'agents archivés qui apparaissaient encore dans les salons de chat
- Correction de l'interaction du bouton de pièces jointes d'images dans le compositeur de messages
- Élagage des binaires natifs de mauvaise plateforme dans les builds desktop Electron

## 0.1.33 - 2026-03-23

### Corrections

- Correction de l'application desktop qui ne rouvrait pas après fermeture sous macOS — le démon et les processus d'agent s'enregistraient auprès de Launch Services comme instances de l'application principale, bloquant les lancements suivants
- Correction de la dictée qui ne fonctionnait pas dans l'application desktop packagée — l'autorisation micro était absente de la configuration du runtime durci
- Correction des processus enfants Claude Code fuités lors de la fermeture des agents — le flux de requête du SDK n'était pas correctement arrêté
- Le bouton de test des notifications remonte désormais les erreurs au lieu d'échouer silencieusement

## 0.1.32 - 2026-03-23

### Ajouts

- Raccourcis clavier entièrement réaffectables avec prise en charge des accords — tous les raccourcis sont désormais déclaratifs avec une séparation correcte entre Cmd (Mac) et Ctrl (Windows/Linux)
- Migration de l'application desktop de Tauri vers Electron, avec notarisation macOS, signature de code et prise en charge de Linux Wayland
- Ajout de numéros de ligne et d'un basculement du retour à la ligne dans les aperçus de fichiers
- Ajout d'un encart d'agent archivé avec un bouton de désarchivage pour restaurer les agents directement depuis la vue chat
- Ajout d'indicateurs de type d'espace de travail dans la barre latérale (par ex. worktree vs autonome)
- Extension de la coloration syntaxique des différences pour couvrir davantage de langages
- Ajout d'infobulles de barre d'état pour l'état des projets et des agents

### Améliorations

- Refonte du sélecteur d'onglets mobile en une rangée d'en-tête compacte offrant un accès rapide aux nouveaux agents et terminaux
- Simplification de la création d'espace de travail — les worktrees sont désormais créés en ligne d'une seule action au lieu d'un flux en plusieurs étapes
- L'historique des agents se diffuse désormais depuis le disque à la reconnexion, pour voir les messages passés immédiatement au lieu d'un écran vide
- Nettoyage automatique des espaces de travail obsolètes : les répertoires de worktree supprimés et les espaces de travail entièrement archivés sont élagués automatiquement
- Après l'archivage d'un espace de travail, l'application redirige désormais vers le prochain espace de travail disponible au lieu de vous laisser sur un écran mort
- La réouverture d'un onglet d'agent archivé le maintient désormais ouvert au lieu de le replier en état archivé
- Réduction des rendus inutiles dans l'écran d'espace de travail, la barre latérale et la liste d'agents pour un défilement et une interaction plus fluides
- La liste d'agents ne se rafraîchit plus en arrière-plan lorsque l'écran n'a pas le focus, économisant des ressources
- La répétition des touches sur desktop fonctionne désormais correctement sous macOS
- Les notifications desktop sous macOS sont plus fiables
- Le démarrage du démon ne se bloque plus sur les téléchargements de modèles
- De meilleurs messages d'erreur du démon — les erreurs RPC incluent désormais les détails sous-jacents réels

### Corrections

- Correction des messages utilisateur apparaissant comme sortie de l'assistant dans la timeline lorsque les messages contenaient des blocs de contenu structurés
- Correction du routage des espaces de travail archivés pour que naviguer vers une session archivée ne casse plus l'application
- Correction de l'AppImage Linux qui échouait à se lancer sur les bureaux uniquement Wayland
- Correction des coordonnées de glissement de fenêtre desktop appliquées alors qu'elles ne devraient pas l'être

## 0.1.30 - 2026-03-19

### Ajouts

- Ajout d'onglets de terminal, de contrôles de volet fractionné et d'aperçus de dépôt pour les mises en page d'espace de travail
- Ajout d'un sélecteur de modèle combiné et de visuels de mode d'agent sur les surfaces d'interface clés
- Ajout d'améliorations des métadonnées Open Graph pour des aperçus de partage du site web plus riches

### Améliorations

- Amélioration de la navigation dans les espaces de travail avec un meilleur suivi de l'espace de travail actif et des interactions de volet pilotées au clavier
- Amélioration du comportement de la barre de défilement du terminal, de la gestion du focus des volets et de l'espacement de la barre d'état et de la saisie de messages
- Amélioration de l'affichage des chemins dans le sélecteur de projet et polissage général de l'interface d'espace de travail

### Corrections

- Correction de la fiabilité du démarrage des agents en resserrant la résolution du PATH et en signalant les binaires de fournisseurs manquants dans l'état
- Correction de la synchronisation des routes d'espace de travail, des zones de glissement et des régressions de style de l'en-tête du panneau de différences git
- Correction du défilement horizontal mobile du site web et assurance que le module audio d'espace de travail se compile lors des installs EAS

## 0.1.28 - 2026-03-15

### Ajouts

- Ajout des modes build et plan d'OpenCode
- Ajout de pages de destination du site web pour Claude Code, Codex et OpenCode

### Améliorations

- Amélioration du menu d'actions git pour des actions de dépôt plus fiables
- Amélioration de l'écran des paramètres mobile, des actions de l'en-tête d'espace de travail et de la présentation de l'écran de bienvenue
- Mise à jour du texte du hero du site web et ajout d'une section d'encart de parrainage

### Corrections

- Correction des liens de fichiers de l'assistant pour qu'ils ouvrent les bons fichiers d'espace de travail depuis le chat

## 0.1.27 - 2026-03-13

### Ajouts

- Ajout d'un runtime vocal avec une nouvelle architecture de moteur audio pour les interactions vocales
- Ajout de la prise en charge de l'outil Grep dans le mappage des appels d'outils Claude
- Ajout de la possibilité d'ouvrir les fichiers d'espace de travail directement depuis les messages de chat de l'agent
- Ajout de notifications desktop via un pont natif personnalisé

### Améliorations

- Amélioration du sélecteur d'images, du rendu markdown et des interactions de l'interface
- Amélioration de la détection de l'environnement shell à l'aide de shell-env

### Corrections

- Correction du rendu des liens markdown spécifique à la plateforme
- Correction des chemins de ressources de la CLI de l'AppImage Linux
- Correction du flux de remplacement de Codex tué par des notifications de tour obsolètes

## 0.1.26 - 2026-03-12

### Ajouts

- Ajout d'un comportement desktop à instance unique, de l'accès au téléchargement de l'APK Android et d'un style d'écran de démarrage rafraîchi
- Ajout de binaires Codex et OpenCode fournis dans le serveur pour que la configuration ne dépende plus d'installations globales
- Ajout de la prise en charge de Windows avec une exécution shell multiplateforme améliorée

### Améliorations

- Amélioration du comportement du runtime desktop sous Windows en supprimant les fenêtres de console et en plaçant par défaut les données de l'application dans `~/.paseo`
- Ajout d'un lien Discord dans la navigation du site web

### Corrections

- Correction du démarrage de l'agent Claude desktop depuis le runtime géré et rotation correcte des journaux au redémarrage
- Correction de la route d'accueil pour masquer le chrome du navigateur lorsque c'est approprié
- Correction de la compatibilité Expo Metro en mettant à jour l'import `exclusionList`
- Correction de la sortie shell bruyante interférant avec la recherche d'exécutables
- Correction de la gestion des chemins de ressources Windows en retirant le préfixe de chemin étendu

## 0.1.25 - 2026-03-11

### Corrections

- Correction de l'application desktop qui échouait à démarrer le démon intégré sur les installations macOS neuves. Le DMG n'était pas notarisé et la signature de code retirait les autorisations du runtime Node fourni, amenant Gatekeeper à bloquer l'exécution
- Correction du build de l'AppImage Linux en restaurant le format de bundle AppImage et en retirant les dépendances CUDA d'onnxruntime

## 0.1.24 - 2026-03-10

### Améliorations

- Amélioration de la navigation clavier du centre de commandes et du raccourci de nouvel onglet
- Simplification du pipeline de publication desktop pour des builds plus rapides et plus fiables

## 0.1.21 - 2026-03-10

### Améliorations

- Amélioration de la fiabilité de la publication desktop en corrigeant le chemin de build du runtime géré Windows lors des publications GitHub Actions

### Corrections

- Correction d'un échec de CI de publication desktop causé par un script de build serveur uniquement Unix sur les runners Windows
- Correction de la CI serveur pour compiler la dépendance relay avant d'exécuter les tests, restaurant la couverture de tests E2EE du relay sur des runners propres
- Correction d'un test de refonte Claude qui dépendait de l'installation locale de la CLI Claude

## 0.1.20 - 2026-03-10

### Ajouts

- Ajout d'actions git dans la barre latérale de l'espace de travail avec des statistiques de différences rapides et des contrôles d'archivage
- Ajout de téléchargements rafraîchis sur le site web et d'une présentation de la page d'accueil pour les installations desktop

### Améliorations

- Le packaging de publication desktop reconstruit et valide désormais le runtime géré fourni lors de la CI, améliorant la fiabilité de l'installeur pour les utilisateurs macOS
- Amélioration du rendu des flux desktop et web, polissage des paramètres et compatibilité React 19.1.4

### Corrections

- Correction des régressions d'interruption/redémarrage de Claude et renforcement de la couverture de tests de fumée du démon géré pour les publications desktop

## 0.1.19 - 2026-03-09

### Ajouts

- Ajout d'un flux de publication GitHub en brouillon pour que les mainteneurs puissent téléverser et relire les assets de publication desktop et Android avant de publier la version finale

## 0.1.18 - 2026-03-06

### Ajouts

- Ajout d'un raccourci desktop `Mod+W` pour fermer l'onglet courant

### Améliorations

- Les terminaux nouveaux et nouvellement sélectionnés prennent désormais le focus automatiquement pour que vous puissiez taper immédiatement
- Maintien des espaces de travail et projets nouvellement créés dans un ordre plus stable dans la barre latérale
- Amélioration du nommage des projets pour les remotes GitHub et extension de la découverte d'icônes de projet aux assets `priv/static` de Phoenix
- Mise à jour du lien de téléchargement desktop du site web pour utiliser le DMG macOS universel

### Corrections

- Restauration de la génération automatique des métadonnées d'agent pour les exécutions Claude

## 0.1.17 - 2026-03-06

### Ajouts

- Nouveau modèle de navigation axé sur l'espace de travail avec onglets d'espace de travail, onglets de fichiers et groupes d'onglets triables
- Raccourcis clavier pour la navigation entre espaces de travail et onglets, avec des badges de raccourci dans la barre latérale
- Actions d'archivage au niveau de l'espace de travail avec un flux d'archivage de worktree amélioré et une prise en charge du menu contextuel
- Notifications de tâches dans le chat rendues comme événements d'appel d'outils synthétiques pour un suivi d'état plus clair

### Améliorations

- Les builds desktop sont désormais livrés en binaire macOS universel (Apple Silicon + Intel)
- Routage d'espace de travail et gestion de l'identité des onglets plus fiables à travers les rafraîchissements et les liens profonds
- Meilleur comportement de glisser-déposer dans la barre latérale avec des poignées de glissement explicites et des interactions de listes imbriquées
- Rendu du terminal/des fichiers plus fluide et améliorations de performance du terminal soutenu par WebGL
- Remontée des erreurs de fournisseurs renforcée et gestion mise à jour du modèle/runtime de Claude

### Corrections

- Correction des exécutions d'espace de travail orphelines causées par des routes d'onglets non canoniques
- Correction des problèmes de remontage/restauration de routage des onglets de terminal mobile
- Correction de la fiabilité de la mise à jour du titre/de la branche des métadonnées d'agent
- Correction des problèmes d'ordre de flux/timeline et de synchronisation du curseur dans l'application
- Correction du comportement inversé du défilement à la molette en bordure dans les vues de chat/flux d'outils

## 0.1.16 - 2026-02-22

### Ajouts

- Mettez à jour l'application desktop Paseo et le démon local directement depuis les Paramètres
- Contrôles des permissions micro et notifications dans les Paramètres
- Mode réflexion/raisonnement — les agents peuvent utiliser la réflexion étendue lorsque le fournisseur la prend en charge
- Mode d'exécution autonome — laissez les agents continuer à travailler sans approbation manuelle à chaque étape
- `paseo wait` affiche désormais un instantané de l'activité récente de l'agent pendant l'attente

### Améliorations

- Streaming plus fluide avec moins de scintillement de l'interface et de sauts de défilement pendant les longues exécutions d'agent
- Rendu plus rapide de la liste d'agents de la barre latérale
- L'archivage d'un agent l'arrête désormais d'abord au lieu d'archiver une session à moitié en cours
- Les titres d'agents ne se réinitialisent plus lors du rafraîchissement
- Connexions relay plus fiables

### Corrections

- Correction des tâches d'arrière-plan de Claude désynchronisant le chat
- Correction des messages utilisateur en double apparaissant dans la timeline
- Correction d'un plantage au démarrage causé par une mise à jour du SDK OpenCode
- Correction des notifications « nécessite attention » parasites provenant de l'activité d'agent en arrière-plan

## 0.1.15 - 2026-02-19

### Ajouts

- Ajout d'une page de changelog publique sur le site web pour que les utilisateurs puissent parcourir les notes de version

### Améliorations

- Refonte de l'expérience de prise en main du site web en un flux plus clair en deux étapes
- Simplification de la navigation GitHub du site web et des titres du changelog
- Amélioration de l'UX brouillon/nouvel agent de l'application avec un placeholder de répertoire de travail plus clair et des messages d'état vide
- Activation des interactions de glissement dans des zones auparavant non gérées de l'écran de brouillon desktop
- Masquage des groupes de filtres vides dans la barre latérale gauche

### Corrections

- Correction de la navigation des agents archivés en redirigeant les routes d'agents archivés vers le brouillon
- Correction du comportement en double du message utilisateur `/rewind`

## 0.1.14 - 2026-02-19

### Ajouts

- Ajout de la prise en charge de la commande Claude `/rewind`
- Ajout de l'accès aux commandes slash dans le compositeur d'agent en brouillon
- Ajout de l'autocomplétion de fichiers d'espace de travail `@` dans les prompts de chat
- Ajout de la prise en charge du collage d'images directement dans les pièces jointes de prompt
- Ajout d'aperçus d'images optimistes pour les pièces jointes de messages utilisateur en attente
- Ajout de poignées de défilement en surcouche partagées desktop/web, y compris pour les volets d'aperçu de fichiers

### Améliorations

- Amélioration du flux de worktree après livraison, notamment une meilleure détection des PR fusionnées
- Amélioration du flux de brouillon en activant la barre latérale de l'explorateur immédiatement après la sélection du CWD
- Amélioration des valeurs par défaut des agents de nouveau worktree en préremplissant le CWD sur le dépôt principal
- Amélioration du comportement de l'autocomplétion de commandes desktop pour correspondre aux interactions de combobox
- Amélioration de l'UX de synchronisation git en simplifiant les libellés de synchro et en n'affichant Sync que lorsqu'une branche diverge de l'origine
- Amélioration de l'UX des paramètres et permissions sur desktop
- Amélioration de la visibilité de la barre de défilement, des interactions de glissement, du suivi et du timing d'animation sur web/desktop

### Corrections

- Correction des problèmes de cycle de vie archivage/configuration de worktree, notamment le nettoyage des terminaux et le timing d'archivage
- Correction des collisions de chemins de worktree en hachant le CWD pour des racines de worktree à l'abri des collisions
- Correction du dimensionnement du terminal lors du retour vers une session d'agent
- Correction du risque de fermeture accidentelle de terminal en ajoutant une confirmation pour les commandes shell en cours d'exécution
- Correction de la cohérence de l'état de chargement de l'archivage dans la barre latérale et l'écran d'agent
- Correction de la stabilité du popover d'autocomplétion et du classement des suggestions d'espace de travail
- Correction des délais d'expiration de dictée causés par des segments non finaux en suspens
- Correction de la propriété du verrou serveur lors du lancement en tant que processus enfant en utilisant la propriété par PID parent
- Correction de la fuite de répertoires cachés dans les suggestions de CWD du serveur
- Correction de la cohérence de la charge utile des notifications d'attention d'agent entre les fournisseurs
- Correction de la visibilité du badge de version du démon dans les paramètres lorsque les données de version du démon sont indisponibles

## 0.1.9 - 2026-02-17

### Améliorations

- Unification de la génération de sortie structurée à travers un pipeline unique et partagé de validation de schéma et de nouvelle tentative
- Réutilisation des vérifications de disponibilité des fournisseurs pour la sélection du repli de génération structurée
- Ajout d'un ordonnancement en cascade de la génération structurée pour les métadonnées internes et la génération de texte git : Claude Haiku, puis Codex, puis OpenCode

### Corrections

- Correction de `run --output-schema` de la CLI pour utiliser le chemin de sortie structurée partagé au lieu d'une analyse JSON ad hoc
- Correction des échecs de `run --output-schema` où les fournisseurs renvoyaient un `lastMessage` vide en récupérant depuis la sortie de l'assistant de la timeline
- Correction de la génération des messages de commit internes, des textes de pull request et des métadonnées d'agent pour suivre un pipeline structuré cohérent

## 0.1.8 - 2026-02-17

### Ajouts

- Ajout d'un flux de dialogue de confirmation multiplateforme pour les redémarrages du démon

### Améliorations

- Simplification du bootstrap vocal local et du comportement de verrouillage au démarrage du démon
- Mise à jour du texte du hero du site web pour mettre en avant l'exécution locale

### Corrections

- Correction de la récupération « envoi pendant l'exécution » bloquée dans la gestion des sessions de l'application et du serveur
- Correction de la préservation de l'identité de session Claude lors du rechargement d'agents existants
- Correction du comportement des options de combobox et des interactions associées
- Correction du nettoyage de l'écouteur de dépôt de fichiers desktop pour éviter les erreurs de désabonnement non capturées
- Correction du routage des événements de molette de détail d'outil web aux bordures de défilement

## 0.1.7 - 2026-02-16

### Ajouts

- Amélioration des flux d'espace de travail des agents avec de meilleures suggestions de répertoire
- Ajout de formulaires de demande d'accès aux apps iOS TestFlight et Android sur le site web

### Améliorations

- Unification du comportement de démarrage du démon entre les chemins dev et CLI pour des exécutions locales plus prévisibles
- Amélioration des instructions de téléchargement et de mise à jour de l'application sur le site web

### Corrections

- Prévention d'un flash de position `0,0` initiale du combobox desktop
- Correction des problèmes de sortie de version de la CLI
- Renforcement du chargement du runtime serveur pour les dépendances de synthèse vocale locale

## 0.1.6 - 2026-02-16

### Notes

- Aucun changement produit visible majeur dans cette version corrective

## 0.1.5 - 2026-02-16

### Ajouts

- Ajout de la prise en charge du rattachement de terminal et d'une meilleure gestion des terminaux de worktree
- Ajout de l'aide globale sur les raccourcis clavier dans l'application
- Ajout du filtrage par hôte dans la barre latérale et de contrôles de flux de travail d'agent améliorés

### Améliorations

- Amélioration de la visibilité de la configuration de worktree en diffusant la progression de la configuration
- Amélioration de la fiabilité du streaming de terminal et de la gestion du cycle de vie
- Préservation de l'état des onglets de l'explorateur pour que le contexte survive mieux à la navigation

## 0.1.4 - 2026-02-14

### Ajouts

- Ajout du rapport d'état de la capacité vocale dans le client
- Ajout des téléchargements en arrière-plan des modèles de synthèse vocale locale avec gating au runtime
- Ajout d'un timing de fin de dictée adaptatif basé sur les budgets fournis par le serveur
- Ajout du comportement de reconnexion du relay avec des périodes de grâce et des suggestions de branche

### Améliorations

- Amélioration de la sélection de connexion et de la fiabilité de l'hydratation des agents
- Amélioration du chargement de la timeline avec un comportement de récupération basé sur le curseur
- Amélioration de l'expérience de première exécution en amorçant une connexion localhost par défaut
- Amélioration du rendu du code en ligne en transformant automatiquement les URL en liens

### Corrections

- Correction du comportement de surveillance des différences de checkout Linux pour éviter les surveillances récursives
- Correction du comportement obsolète du minuteur du client relay
- Correction du défilement automatique inutile de l'en-tête de différences git lors du repli

## 0.1.3 - 2026-02-12

### Ajouts

- Ajout d'une commande d'intégration CLI
- Ajout de la prise en charge de `--output-schema` de la CLI pour une sortie d'agent structurée
- Ajout de la prise en charge par la CLI de la mise à jour des métadonnées d'agent pour les noms et libellés
- Ajout de la détection de disponibilité des fournisseurs avec normalisation des identifiants de modèle par défaut hérités

### Améliorations

- Amélioration du retour de rafraîchissement de l'explorateur de fichiers et de la gestion du repli de checkout non résolu
- Ajout d'une meilleure gestion de l'interruption vocale avec une période de grâce au démarrage de la parole
- Amélioration des valeurs par défaut de la CLI pour lister tous les agents non archivés par défaut
- Amélioration de l'UX du site web avec un CTA d'installation plus clair et un accès à la politique de confidentialité

### Corrections

- Correction des problèmes d'entrée du runner dev et du comportement d'initialisation TTS sherpa

## 0.1.2 - 2026-02-11

### Notes

- Aucun changement produit visible majeur dans cette version corrective

## 0.1.1 - 2026-02-11

### Ajouts

- Ligne de version initiale `0.1.x`

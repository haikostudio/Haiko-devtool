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

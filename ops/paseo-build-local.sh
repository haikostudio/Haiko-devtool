#!/usr/bin/env bash
# Build local + publication de l'app web Paseo self-host (app.haikostudio.cloud).
#
# Remplace l'aller-retour GitHub Actions (build-web-selfhost.yml) + paseo-ship-now.sh :
# le serveur construit lui-même le site statique, puis le copie dans le dossier
# servi par Caddy. Aucun commit ni CI requis pour publier — git ne sert plus que
# de sauvegarde (commit/push best-effort), plus de déclencheur de mise en ligne.
#
# Lancé par le démon Paseo (bouton « À déployer »), détaché, sortie -> paseo-ship-now.log.
# À chaque étape on écrit une phase courte dans PHASE_FILE pour que l'app affiche
# la progression : build -> publish -> done (ou error).
#
# ISOLATION PAR INSTANTANÉ (voir bloc « snapshot » plus bas)
# --------------------------------------------------------------------------------
# /root/paseo est un checkout PARTAGÉ : pendant qu'on construit, d'autres agents
# de tâche y écrivent. Construire directement dedans produisait des builds
# « déchirés » (un fichier à moitié réécrit embarqué dans le bundle). On construit
# donc désormais depuis une COPIE FIGÉE, isolée : un git worktree détaché épinglé
# sur le commit exact à publier. Les éditions parallèles n'ont plus aucun effet
# sur le résultat. La copie est supprimée à la fin (succès OU échec).
#
# Ce script est versionné dans le dépôt (ops/paseo-build-local.sh) ; le chemin
# historique /home/paseo/paseo-build-local.sh n'est plus qu'un lanceur qui exec
# celui-ci, pour que la version en service suive toujours le dépôt.
#
# Usage :
#   paseo-build-local.sh            # build complet + publication en ligne
#   paseo-build-local.sh --no-build # sauvegarde seule (commit/push), rien ne part en ligne
set -uo pipefail

REPO_ROOT="/root/paseo"
WWW="/var/www/paseo-app"
PHASE_FILE="/home/paseo/paseo-build-local.phase"
# Commit à partir duquel le démon en service a été compilé (écrit à l'installation
# du dist, lu par le démon au démarrage — voir paseo-deploy.ts).
DAEMON_BUILD_MARKER="/home/paseo/paseo-daemon-built.sha"
REMOTE="fork"
# Isole le build du démon/agents sans le faire mourir de faim : CPU un peu bas
# (nice 10) mais I/O en classe best-effort PRIORITAIRE (-c2 -n0). L'ancienne
# valeur ionice -c3 (idle) ne prenait le disque QUE si rien d'autre ne l'utilisait
# → sur un serveur chargé, le build restait figé des heures. Ne jamais remettre -c3.
NICE=(nice -n 10 ionice -c2 -n0)
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096"

# Le disque du VPS est lent (~19 Mo/s). On fait travailler le cache de construction
# (metro/temp) en MÉMOIRE VIVE (tmpfs /dev/shm) : le disque n'est utilisé qu'à la
# toute fin (écriture du site + copie Caddy). Sans ça, l'assemblage se traîne sur
# les milliers de petites lectures/écritures de cache et se fige.
RAMDIR="/dev/shm/pbuild"
mkdir -p "$RAMDIR/nmcache"
export TMPDIR="$RAMDIR" TEMP="$RAMDIR" TMP="$RAMDIR"

# Dossier de l'instantané figé (copie isolée du code à publier). En RAM pour être
# rapide sur ce disque lent ; nettoyé systématiquement par cleanup() (trap EXIT).
SNAPSHOT_DIR="$RAMDIR/snapshot"
SNAP=""

NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
  esac
done

phase() { printf '%s\n' "$1" > "$PHASE_FILE" 2>/dev/null || true; }
fail()  { phase "error"; echo "!! $1"; exit 1; }

# --- Nettoyage de l'instantané : toujours, succès comme échec --------------------
# La copie figée ne doit jamais s'accumuler (disque/RAM limités). Le trap EXIT la
# supprime quoi qu'il arrive : fin normale, fail(), ou interruption.
cleanup() {
  [ -n "$SNAP" ] || return 0
  git -C "$REPO_ROOT" worktree remove --force "$SNAP" >/dev/null 2>&1 || true
  rm -rf "$SNAP" 2>/dev/null || true
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$REPO_ROOT" || fail "$REPO_ROOT introuvable"

# --- Verrou anti-doublon : un seul build à la fois -----------------------------
# Sans ça, deux clics « Déployer » (ou un build fantôme resté en arrière-plan)
# se terminent dans le désordre et le DERNIER à publier gagne — on a déjà vu un
# vieux build republier une ancienne version par-dessus la bonne. On refuse net.
# Le verrou garantit aussi qu'un seul instantané worktree existe à la fois.
exec 9>"/home/paseo/paseo-build-local.lock"
if ! flock -n 9; then
  echo "==> Un build est déjà en cours — abandon (anti-doublon)."
  # Un autre build détient le verrou et son propre instantané : ne rien nettoyer.
  trap - EXIT
  exit 0
fi

# Cache de construction en RAM (voir RAMDIR plus haut) : lie node_modules/.cache
# vers la mémoire vive pour éviter le disque lent. L'instantané réutilise ce
# node_modules (par lien), il hérite donc du même cache RAM.
if [ ! -L "$REPO_ROOT/node_modules/.cache" ]; then
  rm -rf "$REPO_ROOT/node_modules/.cache" 2>/dev/null || true
  ln -s "$RAMDIR/nmcache" "$REPO_ROOT/node_modules/.cache" 2>/dev/null || true
fi
# IMPORTANT : vider le cache de transformation metro à CHAQUE build.
# Sinon metro réutilise un morceau en cache où l'ancien numéro de version
# (EXPO_PUBLIC_BUILD_SHA) est resté « cuit » → le site sort avec un numéro
# périmé alors que version.json porte le nouveau → la bannière « nouvelle
# version disponible » s'affiche en boucle à chaque refresh. On garde la RAM
# (rapide) mais on repart d'un cache transform propre = numéro toujours correct.
rm -rf "$RAMDIR/metro-cache" "$RAMDIR/nmcache/metro" "$RAMDIR/nmcache/expo" 2>/dev/null || true

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo "==> Build local — branche $BRANCH"

# --- Sauvegarde best-effort (git = filet, jamais un bloqueur de publication) ---
phase "prepare"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "==> Sauvegarde des changements locaux (commit)…"
  git add -A
  git commit --no-verify -m "chore: sauvegarde avant build local" || true
fi
# Re-read HEAD after the save: the published marker and the bundle must refer
# to the commit that is actually being built, including freshly saved changes.
# C'est CE commit qu'on va figer dans l'instantané ci-dessous, et c'est lui
# qu'on écrira dans .deployed-sha — donc il correspond exactement à HEAD du
# checkout vivant, et le démon (isPublicationLive) ne signale rien en attente.
SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "==> Version publiée : $SHA"
# Push best-effort — ne déclenche plus aucune CI (workflow débranché), pure sauvegarde.
git push "$REMOTE" "HEAD:$BRANCH" >/dev/null 2>&1 || echo "   (push ignoré — sauvegarde locale conservée)"

if [ "$NO_BUILD" = "1" ]; then
  echo "==> --no-build : sauvegarde seule, rien n'est publié."
  phase "done"
  exit 0
fi

# --- Instantané figé : copie isolée du code exact à publier --------------------
# On épingle un git worktree détaché sur $SHA. Il ne contient QUE les fichiers
# suivis à ce commit (source figée) ; dist/node_modules sont ignorés par git donc
# absents — on les reconstruit/rebranche ci-dessous. Toute écriture d'un autre
# agent dans /root/paseo après cet instant est désormais SANS EFFET sur le build.
echo "==> Instantané figé du code ($SHA)…"
rm -rf "$SNAPSHOT_DIR" 2>/dev/null || true
git worktree prune >/dev/null 2>&1 || true
if ! git worktree add --detach "$SNAPSHOT_DIR" "$SHA" >/dev/null 2>&1; then
  fail "Impossible de créer l'instantané figé du code — rien n'est publié."
fi
SNAP="$SNAPSHOT_DIR"

# node_modules dans l'instantané : on NE recopie pas (des Go, disque lent). On
# rebranche par liens vers l'installation vivante — les dépendances tierces ne
# sont pas versionnées et personne ne les édite, donc les partager est sûr.
#
# IMPORTANT : chaque dossier node_modules doit être un VRAI dossier peuplé de
# liens PAR ENTRÉE (un lien par paquet), jamais un unique lien vers tout le
# dossier. Metro sait résoudre à travers un lien par-paquet (testé : 4559 modules
# résolus ainsi), mais REFUSE de descendre dans un node_modules qui est lui-même
# un lien (ex. expo-clipboard, présent seulement dans packages/app/node_modules,
# devenait introuvable). On applique donc la même recette au node_modules racine
# ET à chaque node_modules local de paquet.
#
# SEULE subtilité : les liens d'espace de travail @getpaseo/* doivent pointer
# vers les paquets DE L'INSTANTANÉ (source figée), pas vers le checkout vivant.
# On recrée donc ces liens avec leur cible relative (../../packages/NAME), qui
# se résout à l'intérieur de l'instantané. Tout le reste pointe vers le vivant.
link_node_modules() {  # $1 = node_modules source (vivant), $2 = node_modules cible (instantané)
  local src="$1" dst="$2" e name l tgt
  mkdir -p "$dst"
  for e in "$src"/*; do
    name="$(basename "$e")"
    if [ "$name" = "@getpaseo" ]; then
      mkdir -p "$dst/@getpaseo"
      for l in "$e"/*; do
        tgt="$(readlink "$l")"           # ../../packages/NAME (relatif → résout dans l'instantané)
        ln -s "$tgt" "$dst/@getpaseo/$(basename "$l")"
      done
    else
      ln -s "$e" "$dst/$name"
    fi
  done
}
# Metro (le bundler web) crawle NATIVEMENT le node_modules local d'un paquet dont
# il assemble la source, et NE suit PAS les liens qui en sortent (un paquet trouvé
# par lien vers le vivant est jugé « hors projet » → introuvable, ex. expo-clipboard).
# Le node_modules RACINE, lui, se résout très bien par liens (4559 modules testés).
# On COPIE donc pour de vrai les seuls node_modules que Metro parcourt : l'app
# (point d'entrée) et relay (dont la source est aussi embarquée, cf. metro.config).
# Les liens durs sont exclus (fs.protected_hardlinks=1 sur ce serveur les refuse
# entre propriétaires différents) ; copier TOUT node_modules serait trop lourd
# (~2,5 Go sur disque lent). Copier app+relay ≈ 205 Mo, ~1 s depuis le cache.
METRO_REAL_NM=(app relay)
build_snapshot_node_modules() {
  local shopt_dotglob shopt_nullglob p pkg
  shopt_dotglob=$(shopt -p dotglob); shopt_nullglob=$(shopt -p nullglob)
  shopt -s dotglob nullglob
  link_node_modules "$REPO_ROOT/node_modules" "$SNAP/node_modules"
  for p in "$REPO_ROOT"/packages/*/node_modules; do
    pkg="$(basename "$(dirname "$p")")"
    [ -d "$SNAP/packages/$pkg" ] && link_node_modules "$p" "$SNAP/packages/$pkg/node_modules"
  done
  # Remplace les liens par de vraies copies pour les paquets bundlés par Metro.
  for pkg in "${METRO_REAL_NM[@]}"; do
    if [ -d "$REPO_ROOT/packages/$pkg/node_modules" ] && [ -d "$SNAP/packages/$pkg" ]; then
      rm -rf "$SNAP/packages/$pkg/node_modules"
      cp -a "$REPO_ROOT/packages/$pkg/node_modules" "$SNAP/packages/$pkg/node_modules"
    fi
  done
  eval "$shopt_dotglob"; eval "$shopt_nullglob"
}
build_snapshot_node_modules

# dist des paquets : le worktree ne contient QUE les fichiers suivis (dist est
# ignoré par git → absent). Or le typecheck croisé (packages/cli, etc.) a besoin
# des déclarations `.d.ts` des paquets frères. On COPIE donc les dist déjà bâtis
# du checkout vivant dans l'instantané (copie figée, pas lien : sinon build:web
# écrirait DANS le dist vivant). Ces copies ne servent qu'au garde-fou typecheck ;
# le bundle publié, lui, reste 100 % issu de la source figée car build:web
# régénère les dist des dépendances de l'app (highlight/protocol/client/audio)
# depuis cette même source figée.
copy_snapshot_dist() {
  local d pkg
  for d in "$REPO_ROOT"/packages/*/dist; do
    [ -d "$d" ] || continue
    pkg="$(basename "$(dirname "$d")")"
    [ -d "$SNAP/packages/$pkg" ] && cp -a "$d" "$SNAP/packages/$pkg/dist"
  done
}
copy_snapshot_dist

# --- Empreinte du code source (garde-fou anti-build déchiré) -------------------
# Historiquement ce garde-fou servait à détecter que le checkout PARTAGÉ avait
# bougé pendant le build. L'instantané figé le rend théoriquement superflu, mais
# on le CONSERVE, appliqué à l'instantané : il prouve que rien n'a écrit dans la
# source figée pendant la construction (le build n'écrit que dans dist, ignoré
# par git, et regénère packages/app/src/generated qu'on exclut comme avant).
source_fingerprint() {
  { git -C "$SNAP" rev-parse HEAD 2>/dev/null || echo unknown
    git -C "$SNAP" status --porcelain -- . ':(exclude)packages/app/src/generated' 2>/dev/null
  } | sha256sum | cut -d' ' -f1
}
FINGERPRINT_BEFORE="$(source_fingerprint)"
# Sécurité de version : l'instantané doit être exactement le commit à publier.
if [ "$(git -C "$SNAP" rev-parse HEAD 2>/dev/null)" != "$SHA" ]; then
  fail "L'instantané ne pointe pas sur la version attendue — rien n'est publié."
fi

# --- Contrôle des types (filet avant de brûler 5 min de build) ----------------
# Attrape les incohérences de code (symbole disparu, signature cassée) que
# l'assemblage metro, lui, laisse passer sans broncher. S'applique à l'INSTANTANÉ
# figé, pas au code en mutation. Cette phase distincte garde le suivi lisible :
# la vérification du code n'est ni la construction du moteur, ni celle du site.
phase "verify"
echo "==> Vérification du code (typecheck) sur l'instantané…"
if ! ( cd "$SNAP" && "${NICE[@]}" npm run typecheck ); then
  fail "Le code ne compile pas — rien n'est publié."
fi

# --- Construction du DÉMON (côté serveur) -------------------------------------
# Le démon ne lit PAS la source : il exécute /root/paseo/packages/*/dist, compilé.
# Ce script ne construisait que le site web, donc un correctif côté serveur était
# « publié » sans jamais être compilé : le redémarrage de fin de publication
# rechargeait l'ANCIEN dist et le bug corrigé revenait intact (c'est ainsi que les
# cartes ont continué de sauter la colonne « Terminée » des heures après le
# correctif). On compile donc le démon depuis l'instantané figé, puis on le pose
# dans le checkout vivant : le redémarrage de fin de lot applique enfin le code
# qui vient d'être publié. Ne jamais retirer cette étape.
phase "daemon"
echo "==> Construction du démon (build:server) depuis l'instantané…"
if ! ( cd "$SNAP" && "${NICE[@]}" npm run build:server:clean ); then
  fail "La construction du démon a échoué — rien n'est publié."
fi

# --- Construction du site statique (le gros du temps, ~3-5 min) ---------------
# Depuis l'INSTANTANÉ : expo export lit la source figée et build:app-deps
# régénère les dist des paquets (highlight/protocol/client/audio) DANS
# l'instantané, à partir de la même source figée. Rien du checkout vivant.
phase "site"
echo "==> Construction du site (expo export) depuis l'instantané…"
export EXPO_PUBLIC_BUILD_SHA="$SHA"
# Active le bouton « Déconnexion » dans les réglages sur le build auto-hébergé
# (le mur d'auth Caddy expose /auth/logout). Voir docs/selfhost-auth.md.
export EXPO_PUBLIC_SELFHOST_AUTH=1
if ! ( cd "$SNAP" && "${NICE[@]}" npm run build:web --workspace=@getpaseo/app ); then
  fail "La construction a échoué — rien n'est publié."
fi

if [ "$(source_fingerprint)" != "$FINGERPRINT_BEFORE" ]; then
  fail "La source figée a changé pendant la construction (cas anormal) — rien n'est publié. Relancez la publication."
fi

DIST="$SNAP/packages/app/dist"
[ -d "$DIST" ] || fail "Dossier de build introuvable ($DIST)."
# Marqueur de version lu par l'app pour proposer « Nouvelle version — Recharger ».
printf '{"sha":"%s"}\n' "$SHA" > "$DIST/version.json"

# --- Mise en place du démon compilé dans le checkout vivant --------------------
# Le service systemd lance /root/paseo/packages/cli/dist : c'est CE dist qu'il faut
# remplacer pour que le redémarrage de fin de lot serve le code publié.
# On ne réécrit jamais un dist « en place » (le démon tourne encore et importe des
# modules à la demande : un dossier à moitié réécrit le ferait tomber). On dépose
# à côté, puis on échange par renommage — instantané, et les modules déjà chargés
# en mémoire continuent de vivre jusqu'au redémarrage.
DAEMON_PKGS=(highlight relay protocol client server cli)
install_daemon_dist() {
  local pkg src live
  for pkg in "${DAEMON_PKGS[@]}"; do
    src="$SNAP/packages/$pkg/dist"
    live="$REPO_ROOT/packages/$pkg/dist"
    [ -d "$src" ] || { echo "   (dist manquant pour $pkg — ignoré)"; continue; }
    rm -rf "$live.incoming" "$live.previous" 2>/dev/null || true
    cp -a "$src" "$live.incoming" || return 1
    if [ -d "$live" ]; then
      mv "$live" "$live.previous" || return 1
    fi
    mv "$live.incoming" "$live" || return 1
    rm -rf "$live.previous" 2>/dev/null || true
  done
}
echo "==> Installation du démon compilé dans le checkout vivant…"
if ! install_daemon_dist; then
  fail "Impossible d'installer le démon compilé — rien n'est publié."
fi
# Carte d'identité du démon compilé : le démon la lit au démarrage pour savoir
# quelle version il exécute VRAIMENT. Sans elle il ne connaît que le commit
# présent au démarrage, ce qui ment dès que le dist est plus vieux que le code.
printf '%s\n' "$SHA" > "$DAEMON_BUILD_MARKER" 2>/dev/null || true

# --- Publication : copie dans le dossier servi par Caddy ----------------------
phase "publish"
echo "==> Publication vers $WWW…"
# --chmod force des permissions lisibles par Caddy (dossiers 755, fichiers 644),
# sinon rsync -a hérite des perms restrictives et Caddy renvoie des 404.
rsync -a --delete --chmod=D755,F644 "$DIST"/ "$WWW"/ || fail "La copie vers $WWW a échoué."
chmod 755 "$WWW" 2>/dev/null || true
printf '%s\n' "$SHA" > "$WWW/.deployed-sha"

echo "==> Rechargement de Caddy…"
sudo systemctl reload caddy || echo "   (reload Caddy ignoré — les fichiers sont en place)"

phase "done"
echo "==> Terminé. $(find "$WWW" -type f 2>/dev/null | wc -l) fichiers en ligne. https://app.haikostudio.cloud/"
echo "==> Version en ligne : $SHA (instantané figé)."

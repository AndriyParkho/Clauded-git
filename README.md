# Clauded GIT

Issues, worktrees, PR et chats Claude Code dans une seule interface locale. La spec est dans
[SPEC.md](SPEC.md).

## Prérequis

- Node ≥ 22, Claude Code connecté (`claude` dans le PATH), `gh` connecté.
- `npm install` (si `~/.npm` contient des fichiers root : `npm install --cache "$TMPDIR/npmcache"`).

## Lancer

Développement, avec rechargement de l'UI et du serveur :

```bash
npm run dev
# UI : http://127.0.0.1:5173   (serveur API + WebSocket : 127.0.0.1:4747)
```

Sans Vite, UI compilée servie par le serveur :

```bash
npm run build
npm start
# http://127.0.0.1:4747
```

Variables : `PORT` (4747), `CLAUDED_GIT_HOME` (`~/.clauded-git`, base SQLite), `LOG_LEVEL`.

## Issues

La page Issues classe les issues par statut du GitHub Project (champ « Status », dans l'ordre des
colonnes du projet) ; il faut le scope `read:project` sur le token `gh` (`gh auth refresh -s
read:project` sinon). Le détail d'une issue liste son historique : les onglets de l'app (fermer un
onglet l'archive, « Reprendre » le rouvre) et les sessions Claude Code de sa branche, reconnues par
le numéro d'issue dans le nom de branche (`feature/9307-…`) ou par le dossier `.worktrees/issue-<n>`.

## Spec

L'onglet « Spec » ouvre un chat dans un dépôt (ou un dossier, créé au besoin) avec, à côté, le
fichier de spec (`SPEC.md` par défaut) rendu à chaque écriture, ses versions (gardées en base, 200
par spec) et le découpage en issues. Le découpage est écrit par la session dans
`~/.clauded-git/specs/run-<id>.issues.json` ; la création des issues (et de leurs liens sous-issue et
« bloquée par ») est faite par l'app avec `gh`, comme la publication des reviews.

## Pages (artifacts)

Les sessions lancées par l'app n'ont pas l'outil Artifact de l'app Claude. À la place, chaque session
reçoit une consigne (ajoutée au prompt système) : pour un artifact, ou toute page à regarder, elle
écrit un fichier HTML autonome dans `~/.clauded-git/artifacts/<onglet>/`. L'app liste ces pages
au-dessus du chat (« Pages : … ↗ ») et les sert sous `/artifacts/<onglet>/…`, dans un bac à sable
(CSP `sandbox` sans `allow-same-origin`) : leur JavaScript tourne, mais ne peut pas appeler l'API.
Une session déjà ouverte reçoit la consigne à sa prochaine réouverture.

L'API refuse les requêtes dont l'en-tête Origin n'est pas local (`localhost`, `127.0.0.1`) : un site
ouvert dans le navigateur, ou une de ces pages, ne peut pas piloter l'app.

## Implémentation en lot

- Au plus 3 implémentations où Claude travaille (ou attend ta réponse) en même temps, pour toute
  l'app (`CLAUDED_GIT_MAX_PARALLEL` pour changer). Les suivantes attendent en file et partent seules
  dès qu'un onglet termine son tour ; « Lancer quand même » passe outre.
- Une issue sélectionnée qui a elle-même des sous-issues ouvertes n'est pas lancée : on lance ses
  sous-issues à part (« Implémenter ses sous-issues »). Les dépendances qui la touchent, trouvées
  ailleurs que sur GitHub, y sont écrites en « bloquée par » au lancement. Quand on lance ses
  sous-issues, celles qui ne dépendent de rien dans le lot reprennent les « bloquée par » de la
  parente. Ce qui dépend d'une parente attend qu'elle soit fermée.
- Avant d'implémenter, l'app cherche une branche où l'issue a déjà du travail (worktree sorti, branche
  liée, PR ouverte, branche distante au numéro de l'issue ; une branche sans commit ni PR ne compte
  pas). Si elle en trouve une, elle propose d'ouvrir un chat dans son worktree pour faire le point
  (consigne dans la saisie, Claude ne modifie rien), ou de reprendre l'implémentation dessus. Dans un
  lot, ces issues sont écartées sauf si on coche « reprendre ».
- Après avoir ouvert sa PR, la session la relit avec le skill `selfReviewSkill` du profil
  (`code-review:code-review` par défaut, `null` pour s'en passer), corrige et pousse, sans rien
  publier sur GitHub.

## Liens GitHub des onglets

L'en-tête d'un onglet lié à une issue ou une PR montre leurs liens GitHub (issue, PR qui la ferme
ou PR de la branche, issues d'une PR), et les workflows GitHub Actions lancés par leur merge :
dans develop (merge de l'app, retrouvé dans l'historique de `origin/develop`) ou dans la base de la
PR (son commit de merge). État relu à la fin de chaque tour, et toutes les 30 s tant qu'un workflow
tourne.

## Onglets d'un dépôt

Implémentation d'une issue, PR, résolution de conflits et chat ouvert dans un dépôt partagent le même
en-tête : panneaux Diff (brouillons de review en plus pour une PR), issue(s), Branche et PR (checks,
commentaires, « Envoyer les commentaires au chat »), Logs ; menus Commandes (projet du monorepo,
commandes du profil, commande libre), Git (merges de la base et dans develop ; pour un chat, la
branche sortie dans son dossier) et Ouvrir (VS Code, Finder, terminaux, Bruno). Une PR ajoute
« Lancer la review ». Un chat hors dépôt n'a que « Ouvrir ».

« Commit & push » apparaît quand il y a quelque chose à commiter ou à pousser : `git add -A`, message
écrit par un petit modèle (`commitModel` du profil, `haiku` par défaut) d'après le diff et le style
des derniers commits, `git commit` (hooks compris), puis `git push` (`-u` la première fois). La
session n'est pas sollicitée. Sur la branche de base ou d'intégration, l'app demande confirmation.

## Consommation des sessions

- Effort `medium` par défaut (`CLAUDED_GIT_EFFORT` pour changer), au lieu de l'`effortLevel` des
  réglages Claude Code (souvent `high`). Réglable par onglet dans la barre d'état et la palette ;
  appliqué au tour suivant, retenu pour l'onglet.
- Implémentations et résolutions de conflits : seulement les serveurs MCP du `.mcp.json` du dépôt
  (`implementMcp` du profil : `project`, `none` ou `all`). Les chats, PR et specs gardent tout.
- Barre d'état : tokens du contexte (vert, orange dès 80 k, rouge dès 150 k ; seuils en tokens,
  pas en %, la fenêtre pouvant faire 1 M), et au clic ce qui les occupe (skills, CLAUDE.md, prompt
  système, outils, conversation). « Compacter » (`/compact`) proposé dès 80 k ; « Nouvelle
  conversation » (ou `/clear`) pour repartir de zéro dans le même onglet.
- « Envoyer au chat » d'une commande n'envoie que ses 40 dernières lignes et le chemin du log complet
  (`~/.clauded-git/logs/`), que la session ne lit que si besoin ; idem pour les conflits de merge.
- Le prompt système des sessions leur demande de déléguer les recherches larges à un sous-agent
  Explore et de lire gros fichiers et logs par morceaux (pour les nouvelles sessions).

## Profils de dépôt

Au premier usage d'un dépôt, l'app écrit `~/.clauded-git/profiles/<owner>__<name>.json` avec des
valeurs devinées (branche de base, `develop` s'il existe, install et scripts d'après le lockfile).
À ajuster à la main : `branchFormat`, `install`, `copyFiles` (`.env.local`…), `commands` (boutons de
l'onglet d'implémentation), `reviewSkill`, `selfReviewSkill`, `instructions` (ajoutées au prompt
d'implémentation), `implementMcp`, `commitModel`.

## Structure

- `server/` : Fastify + WebSocket, SQLite (`node:sqlite`), Claude Agent SDK.
  - `sessions/manager.ts` : une session Claude par onglet, diffusion des messages, permissions.
  - `repos.ts` : détection des dépôts (remote `origin`), scan d'un dossier, historique des sessions.
  - `github.ts` : issues (GraphQL, sous-issues et parent), branches liées, PR d'une branche.
  - `git.ts` : worktrees, statut, diff contre la base.
  - `implement.ts` : flux « Implémenter » (branche liée, worktree, install, prompt), merges.
  - `jobs.ts` : commandes lancées par l'app (install, tests, merges), sortie diffusée en flux.
  - `profiles.ts` : profil par dépôt.
  - `spec.ts` : page Spec (fichier suivi et versionné, découpage en issues, création sur GitHub).
  - `watch.ts` : surveillance d'un dossier, avec relevé périodique si le système la refuse.
- `web/` : React + Vite. `store.ts` (état), `ws.ts` (WebSocket), `components/chat/` (fil, outils,
  questions, saisie, barre d'état).
- `shared/protocol.ts` : types communs (modèle, messages WebSocket).
- `spike/` : le prototype de validation du SDK (`npm run spike:check -- <repo>`).

## Vérifier

```bash
npm run typecheck
```

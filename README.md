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

## Profils de dépôt

Au premier usage d'un dépôt, l'app écrit `~/.clauded-git/profiles/<owner>__<name>.json` avec des
valeurs devinées (branche de base, `develop` s'il existe, install et scripts d'après le lockfile).
À ajuster à la main : `branchFormat`, `install`, `copyFiles` (`.env.local`…), `commands` (boutons de
l'onglet d'implémentation), `reviewSkill`, `instructions` (ajoutées au prompt d'implémentation).

## Structure

- `server/` : Fastify + WebSocket, SQLite (`node:sqlite`), Claude Agent SDK.
  - `sessions/manager.ts` : une session Claude par onglet, diffusion des messages, permissions.
  - `repos.ts` : détection des dépôts (remote `origin`), scan d'un dossier, historique des sessions.
  - `github.ts` : issues (GraphQL, sous-issues et parent), branches liées, PR d'une branche.
  - `git.ts` : worktrees, statut, diff contre la base.
  - `implement.ts` : flux « Implémenter » (branche liée, worktree, install, prompt), merges.
  - `jobs.ts` : commandes lancées par l'app (install, tests, merges), sortie diffusée en flux.
  - `profiles.ts` : profil par dépôt.
- `web/` : React + Vite. `store.ts` (état), `ws.ts` (WebSocket), `components/chat/` (fil, outils,
  questions, saisie, barre d'état).
- `shared/protocol.ts` : types communs (modèle, messages WebSocket).
- `spike/` : le prototype de validation du SDK (`npm run spike:check -- <repo>`).

## Vérifier

```bash
npm run typecheck
```

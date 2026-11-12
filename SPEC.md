# Clauded GIT — spec (brouillon v0.3)

> Brouillon à itérer ensemble. **[à trancher]** = attend ta décision. **[spike]** = à vérifier dans le
> prototype avant de s'engager. Le reste est décidé ou proposé par défaut.

## 0. Avancement (12 novembre 2026)

- ✅ Spike validé (§4.1).
- ✅ Phase 1, chat : sessions, fil comme Claude Code, historique, consommation (contexte, limites
  5 h / 7 j), messages utilisateur repliés, saisie fixe, commandes slash dès l'ouverture.
- ✅ Phase 1, issues : liste multi-dépôts (assignées, créées, toutes), détail, sous-issues, badge
  d'état local, Chat avec l'issue en brouillon, Implémenter (branche liée `gh issue develop`,
  worktree, install en fond, prompt), onglet avec Ouvrir, Issue, Diff, commandes du profil,
  Merge base, Merge → develop (avec résolution de conflits dans un chat), PR (statut, lien).
- ⏳ À tester en vrai : `Implémenter` de bout en bout, les merges, les profils.
- Suite : phase 2 (PR : liste, review avec brouillons), phase 3 (sous-issues en parallèle), phase 4
  (page Spec).

## 1. Le problème

Aujourd'hui : Claude Code dans VS Code, plus deux orchestrateurs CLI qui lancent Claude en tâche de fond.

- Plusieurs worktrees en parallèle = plusieurs fenêtres ou terminaux. On perd le fil : qui attend quoi,
  quelle branche, quelle PR.
- Les orchestrateurs ne montrent pas ce que fait Claude et ne permettent pas de lui parler pendant
  l'implémentation. Ce n'est **pas** le modèle visé.
- La spec se fait dans un chat linéaire, sans voir le document évoluer.
- La review des PR des collègues se fait à la main, sans aide de Claude.

**Objectif** : une app locale qui couvre l'idée → les issues → la PR → le merge, et aussi la review des PR
des autres. Chaque chat Claude Code s'y ouvre dans le bon contexte (repo, worktree, branche, issue ou
PR), entouré des actions utiles. L'expérience de référence est Claude Code lui-même : tout est visible,
tout est reprenable.

## 2. Décisions prises

| Sujet | Décision |
|---|---|
| Nom | **Clauded GIT**. Commande `clauded-git`. |
| Forme | Web local pour commencer (serveur Node sur la machine, UI dans le navigateur). Electron plus tard si besoin. |
| Moteur de chat | Claude Agent SDK + UI de chat maison. |
| Langage | TypeScript partout. |
| Forges | GitHub seulement pour l'instant (`gh`). GitLab et `glab` mis de côté. |
| Droits de l'agent | Il commit, pousse sur les branches de feature et ouvre la PR en draft (`gh pr create`). Aucune commande git ne lui est interdite. |
| Mise à jour depuis master | **Merge** de `origin/master` dans la branche, comme `gup`. Pas de rebase. |
| Ordre des phases | Issues et implémentation, puis review de PR, puis sous-issues en parallèle, puis page Spec. |
| Permissions | L'app répond oui à toutes les demandes. L'historique des commandes fait foi. |
| Plan mode | Implémentation directe par défaut, plan mode au choix au lancement. |
| Merge dans develop | Push direct sur `develop` (équivalent de `mdev`), via un bouton. |
| Sous-issues dépendantes | Branches empilées. |
| Historique des chats | Toutes les sessions Claude Code du repo, pas seulement celles lancées par l'app. |
| Page Spec | Chat à gauche, `SPEC.md` en direct à droite, annotations, génération des issues. |

## 3. Principes

- **Local** : tourne sur ta machine, avec ton login Claude Code, `gh` et git. Aucun serveur distant.
- **Comme Claude Code** : CLAUDE.md, skills, commandes slash, hooks, MCP et mémoire du repo sont
  chargés comme dans un chat Claude Code classique. Tout ce que fait Claude est visible en direct.
- **Vraies sessions Claude Code** : reprenables dans le terminal ou VS Code (`claude --resume <id>`),
  et inversement.
- **L'app pose le décor, l'agent travaille dedans** : l'app crée le worktree et la branche liée à
  l'issue, lance la session au bon endroit et fournit les boutons. L'agent code, teste, commit, pousse.
- **Aucun worktree ne change de branche**. C'est la règle qui évite tous les conflits entre worktrees
  (voir §6).

## 4. Architecture

```
navigateur (React) ⇄ HTTP + WebSocket ⇄ serveur Node local (localhost)
                                          ├─ Claude Agent SDK (une session par onglet)
                                          ├─ git / worktrees
                                          ├─ gh (issues, PR, reviews)
                                          └─ SQLite (~/.clauded/)
```

- Un process Node local est obligatoire (disque, git, lancer Claude) : il sert aussi l'UI.
- Le SDK est le même moteur que le CLI. Pour qu'il se comporte comme un chat Claude Code classique, la
  session est lancée avec le prompt système Claude Code et **toutes les sources de réglages** (user,
  project, local) : c'est ce qui charge CLAUDE.md, `.claude/skills`, les commandes, les hooks et les
  plugins du repo de travail et de ton compte.
- Un bouton **Terminal** (`claude --resume <id>` dans le bon dossier) couvre ce que l'UI ne gère pas.
- Stack : Node 22, TypeScript, Fastify + WebSocket, React + Vite, rendu markdown + mermaid, SQLite.
- Lancement : la commande `clauded` démarre le serveur et ouvre le navigateur.

**[spike] à vérifier dans le prototype, avant tout le reste :**

1. Le SDK s'authentifie avec ton compte Claude Code (pro et perso) sans clé API.
2. CLAUDE.md, skills et commandes slash du repo sont bien chargés et utilisables.
3. Le mode « tout accepter » fonctionne avec les réglages managés de ta machine (callback de permission
   qui répond oui, plutôt que le mode bypass, qui peut être désactivé par l'entreprise).
4. Ce qui bloque exactement `yarn test` (sandbox : Docker) et `gh api --method POST` (sandbox ou règle
   de permission managée), pour choisir le mécanisme du §7.
5. Reprise d'une session, lecture des transcripts existants pour l'historique.

### 4.1 Spike : résultats (10 novembre 2026)

Code dans `spike/` (voir `spike/README.md`) : `check.ts` (vérifications headless) et `server.ts` +
`public/index.html` (un chat dans le navigateur). Lancé dans wmx-core, SDK `0.3.322`, Claude Code
`2.1.322`. Les 5 points du spike sont validés :

| Point | Résultat |
|---|---|
| Auth | ✅ compte Claude Team Winamax, `firstParty`, sans clé API. `query.accountInfo()` donne email, organisation, abonnement. |
| CLAUDE.md, skills, commandes | ✅ CLAUDE.md du repo cité par Claude ; les 9 skills du repo et `core-pr-review` chargés ; 72 commandes slash ; plugins et MCP de ton compte présents. Les skills `user-invocable: false` n'apparaissent pas dans la liste `init.skills` mais sont bien chargés. |
| Tout accepter | ✅ `canUseTool` est appelé pour Bash et répond `allow`. Pas besoin du mode bypass. |
| Sandbox | **Les sessions SDK ne sont pas sandboxées** : `docker ps` fonctionne depuis l'agent. La sandbox que tu subis vient de l'extension VS Code, pas de tes réglages. `yarn test` passera donc directement. Conséquence : « tout accepter » sans sandbox = l'agent a les mêmes pouvoirs que toi dans un terminal. |
| `gh api` en écriture | ⚠️ refusé aussi dans la session SDK, par `cc-plugin-sec-default`, un plugin de sécurité **intégré à Claude Code** (pas un fichier de ta machine). Il refuse `gh auth*` et `gh api --method POST\|PUT\|PATCH\|DELETE`. `gh pr create` n'est pas concerné a priori ; à confirmer au premier Implémenter, l'app a de toute façon le secours du §5.4. |
| Reprise | ✅ un second `query` avec `resume` retrouve le contexte. |
| Historique | ✅ `listSessions` liste les sessions du repo (y compris celles de VS Code et des worktrees) ; `getSessionMessages` relit leurs messages. L'historique de 5.0 se construit dessus, sans parser les JSONL. |
| Multi-tours | `query({ prompt: AsyncIterable })` garde la session ouverte entre les tours ; c'est ce que fait `server.ts`. |

Coût : 0,92 $ pour 3 tours en Fable 5.1 à l'effort `xhigh` de tes réglages. À prévoir dans la barre
d'état.

Divers : le cache `~/.npm` contient des fichiers root ; `--cache "$TMPDIR/npmcache"` contourne, ou
`sudo chown -R 503:20 ~/.npm` pour de bon. Ma propre session ne peut ni joindre `api.anthropic.com`
ni ouvrir un port : c'est toi qui lances l'app pendant le développement.

## 5. Fonctionnalités

### 5.0 Le chat, cœur de l'app

Le même chat partout (issue, implémentation, PR, spec), qui reproduit Claude Code :

- **Fil en direct** :
  - texte en streaming ;
  - chaque appel d'outil apparaît comme dans Claude Code : fichier lu, recherche, commande Bash avec sa
    sortie, édition avec son diff. Replié par défaut, dépliable ;
  - todos et sous-agents visibles.
- **Interaction** :
  - répondre pendant que Claude travaille (message mis en file) ;
  - Stop ;
  - cartes pour les questions de Claude et la validation de plan. Les permissions ne posent pas de
    question : elles sont acceptées et tracées.
- **Citer pour répondre** (comme dans l'app Claude) : tu sélectionnes un passage d'une réponse ou d'une
  sortie d'outil → « Répondre ». Le passage s'empile au-dessus de la saisie. Plusieurs citations
  possibles, envoyées avec ton message suivant.
- **Contexte attaché** : l'app peut joindre des blocs de contexte à un message (issue, commentaires de
  review, sortie de tests). Ils s'affichent comme une pièce jointe repliée, avec leur taille en tokens,
  pas comme du texte dans la saisie.
- **Réglages par chat** : modèle, effort, plan mode. Contexte utilisé et coût affichés.
- **Historique** : toutes les sessions Claude Code du repo et du worktree (y compris VS Code et
  terminal), par date, avec titre, branche et statut. On les rouvre et on les poursuit. Les sessions
  lancées par l'app sont rattachées à leur issue ou à leur PR.
- Commandes slash et skills disponibles dans la saisie, avec autocomplétion.

### 5.1 Repos et profils

- On ajoute un repo seul, ou un dossier racine (ex. `~/Documents/github`) scanné sur 2–3 niveaux. Le
  remote `origin` donne `owner/repo`. Plusieurs clones du même remote → un seul gardé.
- Chaque repo s'active ou se désactive.
- Auth GitHub : `gh`, déjà connecté.
- **Profil par repo** (fichier TS ou JSON dans `~/.clauded/profiles/`, avec un profil par défaut
  déduit du lockfile) :
  - branche de base (`master`/`main`) et branche d'intégration (`develop`) ;
  - préfixe et format de branche (`feature/<n>-<slug>`) ;
  - install (`yarn install --immutable`) et fichiers locaux à copier dans le worktree (`.env.local`) ;
  - **commandes bouton** : tests, lint, typecheck… (voir §7) ;
  - skill de review (`core-pr-review` pour wmx-core) ;
  - consignes ajoutées aux prompts.

### 5.2 Liste des issues

- Vue type GitHub Issues, multi-repos.
  - Filtres : assignées à moi (défaut), créées par moi, toutes ; ouvertes ou fermées ; labels, repo,
    texte.
  - Arbre parent → sous-issues (sous-issues natives GitHub).
- **Badge d'état local** par issue : chat ouvert, implémentation en cours, attend ta réponse, PR
  ouverte, mergée dans develop.
- Rafraîchissement à la demande, plus un polling léger.

### 5.3 Détail d'une issue

Corps, commentaires, labels, sous-issues, branche liée, PR liées. Actions :

- **Chat** : nouvelle session dans le checkout principal du repo. La saisie contient un prompt court et
  modifiable (« À propos de l'issue #123 : … ») ; le contenu de l'issue est **attaché** comme bloc de
  contexte (voir 5.0).

  Pourquoi attacher plutôt que donner le numéro : si on ne donne que le numéro, Claude lance
  `gh issue view --comments`, et le résultat entre dans le contexte de toute façon, avec les métadonnées
  en plus et un aller-retour de plus. Le bloc attaché est formaté par l'app (plus compact), ne coûte
  pas de tour supplémentaire, et peut être rafraîchi quand de nouveaux commentaires arrivent.
- **Passer en implémentation** depuis un chat : ouvre un onglet d'implémentation avec un résumé du chat.
- **Implémenter** : voir 5.4.
- **Implémenter les sous-issues**, si l'issue est parente : voir 5.5.

### 5.4 Onglet d'implémentation

À l'ouverture, l'app :

1. Crée la **branche liée à l'issue** côté GitHub : `gh issue develop <n> --name <branche> --base <base>`.
   C'est ce qui fait apparaître la branche dans la section *Development* de l'issue (un `git branch`
   local ne le fait pas). Si l'issue a déjà une branche liée (`gh issue develop --list`), l'app la
   reprend.
2. `git fetch`, puis `git worktree add <repo>/.worktrees/issue-<n> <branche>` (branche locale qui suit
   `origin/<branche>`).
3. Copie les fichiers locaux du profil et lance l'install en tâche de fond. La session démarre sans
   attendre ; le statut de l'install est visible dans l'onglet et son résultat est injecté dans le chat
   quand elle se termine.
4. Démarre la session Claude, `cwd` = le worktree, avec le prompt : contexte de l'issue (bloc attaché)
   + consignes : implémenter, vérifier, commit (Conventional Commits, `Refs #n`), pousser, ouvrir la PR
   en draft avec `gh pr create` (`Closes #n`, ce qui la lie aussi à l'issue). Si cette commande se
   révèle bloquée sur ta machine, l'app ouvre la PR à sa place.

```
┌ [Issues] [PR] [Spec] [#123 ●] [#124 ⏸ attend] [#125 ✓] ──────────────────────┐
│ #123 Remise paywall · feature/123-remise-paywall · wmx-core                   │
│ [Ouvrir ▾] [Terminal] [Diff] [Tests] [Lint] [Merge master] [Merge → develop]  │
├─────────────────────────────────────────────┬─────────────────────────────────┤
│ chat : streaming, outils repliés, cartes    │ panneau : issue / diff / PR     │
│ > ta réponse…                        [Stop] │ (checks CI, commentaires)       │
├─────────────────────────────────────────────┴─────────────────────────────────┤
│ opus · high · contexte 34 % · 1,20 $ · install : ok · PR #456 draft           │
└───────────────────────────────────────────────────────────────────────────────┘
```

Boutons :

- **Ouvrir** : VS Code (`code <worktree>`), Finder, terminal.
- **Terminal** : `claude --resume <id>` dans le worktree.
- **Diff** : diff de la branche contre sa base, dans le panneau.
- **Tests / Lint / Typecheck** : commandes du profil, lancées par l'app dans le worktree (hors sandbox,
  donc avec Docker). La sortie s'affiche et un bouton l'envoie au chat (« Corrige ça »).
- **Merge master** : `git fetch origin`, `git merge origin/master`, `git push` dans le worktree. Ce que
  fait `gup`, sans toucher à la branche locale `master` (voir §6). Conflits → envoyés au chat, l'agent
  les résout, commit et pousse.
- **Merge → develop** : voir §6. Conflits → onglet de résolution, puis push via le même bouton.
- **PR** : vue PR dans le panneau (statut, checks CI, commentaires de review), bouton « Envoyer les
  commentaires de review au chat », lien vers GitHub.

**Une session par onglet, du lancement au merge.** Le « début », c'est le premier prompt
d'implémentation ; la « fin », c'est le merge dans develop et la fermeture de l'onglet. Entre les deux,
tes retours, les commentaires de review, les échecs de CI et les conflits de merge partent dans cette
même session, qui garde le contexte de ce qu'elle a fait. Si le contexte devient trop gros : `/compact`,
ou bouton **Nouvelle session dans ce worktree**.

### 5.5 Implémenter toutes les sous-issues

1. L'app récupère les sous-issues et les relations natives « bloquée par ».
2. Claude complète le graphe de dépendances en lecture seule. Tu le vois sous forme de graphe éditable,
   et tu le valides.
3. Chaque sous-issue a son onglet : un chat complet, visible et interactif, dans sa propre session.
   - Limite de concurrence (3 par défaut).
   - Les issues prêtes démarrent tout de suite. Les autres affichent « en attente de #x ».
4. **Branches empilées** : une issue dépendante démarre quand celle dont elle dépend a poussé son
   travail. Sa branche est créée depuis celle-ci (`gh issue develop <enfant> --base <branche-parent>`)
   et sa PR la cible. Quand la PR parente est mergée, GitHub recible la PR enfant sur `master`.
5. Vue d'ensemble : le graphe avec l'état de chaque nœud. Un clic ouvre l'onglet.

### 5.6 PR : lecture, chat et review

Sert pour tes PR et surtout pour celles des collègues que tu dois relire.

- **Liste** : à relire (review demandée), les miennes, toutes les ouvertes ; par repo.
- **Onglet PR** :
  - panneau : description, checks CI, fichiers et diff, commentaires existants ;
  - chat dont le `cwd` est un worktree sur la branche de la PR (`.worktrees/pr-<n>`, ou le worktree de
    l'issue si la PR vient d'un onglet d'implémentation), pour poser des questions sur le code ;
  - bouton **Review** : lance le skill de review du profil (ex. `core-pr-review`) dans le chat.
- **Brouillons de commentaires** :
  - `core-pr-review` écrit déjà la review au format de l'API GitHub (`commit_id`, `body`,
    `comments[]` avec `path`, `line`, `side`, `body`, `start_line`), et ne publie que sur `--post`.
    L'app lui donne le chemin du fichier à écrire et lui demande de ne pas publier ; c'est le format
    commun à tous les skills de review ;
  - dès que le fichier est écrit, les brouillons apparaissent sur le diff, dans le panneau, avec leur
    label (`bloquant`, `à corriger`, `détail`, `question`) ; tu les modifies, les supprimes, en
    ajoutes ;
  - **Publier la review** : l'app envoie les brouillons en un seul appel, hors sandbox, soit comme
    review *pending* sur GitHub (ton habitude : tu relis et soumets là-bas), soit soumise directement
    avec le verdict choisi (commentaire, approbation, demande de changements).

### 5.7 Page Spec

- À gauche, un chat Claude Code, dans un repo existant ou un nouveau dossier.
- À droite, `SPEC.md` rendu en direct : rechargé à chaque écriture, mermaid, diff entre deux versions.
- **Annotations** : tu sélectionnes un passage et tu le commentes. Le commentaire part dans le chat
  comme un retour ciblé (même mécanique que « citer pour répondre »).
- **Générer les issues**, à la fin :
  1. Claude propose un découpage (issue parente, sous-issues, dépendances, critères d'acceptation) ;
  2. tu le corriges dans un tableau ou un graphe éditable ;
  3. l'app crée les issues sur GitHub avec les liens parent/enfant et « bloquée par » ;
  4. **Implémenter tout** lance la suite (5.5).

### 5.8 Transverse

- Notification quand un onglet attend ta réponse ou a fini.
- Au redémarrage de l'app, les onglets et les sessions sont restaurés.
- Après un merge : bouton pour supprimer le worktree et la branche locale.

## 6. Git : worktrees et branches

Les contraintes :

- git refuse d'avoir la même branche dans deux worktrees. `mdev` (`git switch develop`) et `gup`
  échouent donc dès que `develop` ou `master` est déjà sortie ailleurs, et un worktree qui change de
  branche gêne les autres.
- Plusieurs onglets peuvent vouloir merger dans develop en même temps.

La règle proposée : **aucun worktree ne change jamais de branche.**

| Dossier | Branche | Rôle |
|---|---|---|
| checkout principal | `master`, toujours | lecture, `git fetch`, chats « Chat » d'une issue. Jamais utilisé pour développer. |
| `.worktrees/_develop` | `develop`, toujours | les merges dans develop |
| `.worktrees/issue-<n>` | branche de l'issue | développement |
| `.worktrees/pr-<n>` | branche de la PR | lecture et review |

- **Merge → develop** = les commandes de `mdev` sans le `switch`, exécutées dans `_develop` :
  `git pull && git merge <branche> && git push`. Les merges sont sérialisés (un verrou sur
  `_develop`). Rien d'autre ne bouge.
  - Conflit : l'app ouvre un onglet **Résolution de conflit** dont le `cwd` est `_develop` ; l'agent
    résout, puis tu pousses via le même bouton. Si tu préfères résoudre à la main, le bouton reprend
    aussi.
- **Merge master** = `gup` sans la mise à jour de la branche locale `master` :
  `git fetch origin && git merge origin/master && git push origin <branche>`, dans le worktree de
  l'issue.
  - `gup` fait `git fetch origin master:master`, c'est-à-dire qu'il met à jour la branche locale
    `master`. C'est ce que git refuse quand `master` est sortie dans un autre worktree, donc dans le
    checkout principal. En mergeant directement `origin/master`, on obtient le même merge, le même
    commit de merge (seul son message change : « Merge remote-tracking branch 'origin/master' » au
    lieu de « Merge branch 'master' »), le même push, sans toucher à `master`.
  - C'est bien un **merge**, pas un rebase : les commits existants ne sont pas réécrits, pas de push
    forcé, les commentaires de review restent accrochés aux bonnes lignes, et les branches empilées
    dessus ne sont pas invalidées. Un rebase aurait le même but, mais pas ces propriétés.
  - Même mécanique pour une branche empilée qui veut récupérer le travail de sa parente :
    `git merge origin/<branche-parent>`.
- Le checkout principal reste sur `master`. L'app y fait un `git pull --ff-only` quand il est propre,
  pour que ce que tu ouvres dans VS Code soit à jour.

Comparé à ton option « utiliser aussi le checkout principal comme repo de dev quand il est libre » :
c'est moins d'invariants à garder en tête, et une seule règle à expliquer à l'agent.

## 7. Permissions, sandbox et commandes bloquées

- **Permissions** : l'app répond oui à chaque demande via le callback de permission du SDK. Rien n'est
  retiré à l'agent (git compris). Tout est visible dans le fil et dans un onglet **Journal des
  commandes** par session.
- **Sandbox** : les sessions SDK ne sont pas sandboxées (spike, §4.1) : Docker et `yarn test`
  fonctionnent depuis l'agent, comme dans un terminal. Si un jour tu veux un garde-fou, l'option
  `sandbox` du SDK accepte les mêmes clés que les réglages (`enabled`, `excludedCommands`, réseau,
  système de fichiers) ; ce sera un réglage du profil, désactivé par défaut.
- **Boutons** (Tests, Lint, Typecheck, et d'autres définis dans le profil) : l'app exécute la commande
  dans le worktree, affiche la sortie, et un bouton l'envoie au chat. Pour relancer vite sans passer
  par Claude.
- **`gh` en écriture** : `gh auth*` et `gh api --method POST|PUT|PATCH|DELETE` sont refusés à l'agent
  par le plugin de sécurité intégré à Claude Code, dans toutes les sessions. L'app fait donc ces
  écritures elle-même : branche liée à l'issue, review, création de PR en secours. Les cas répétitifs
  deviennent des boutons.
- Le contenu des issues et des PR est passé comme des données, pas comme des instructions.

## 8. Modèle de données

- `repo` : chemin, remote, profil, actif.
- `run` (= un onglet) : repo, type (`chat | implement | pr | merge | spec`), issue ou PR, worktree,
  branche, `session_id`, statut, PR liée, run parent, dépendances.
- `review_draft` : PR, `commit_id`, puis les champs de l'API GitHub (`path`, `line`, `start_line`,
  `side`, `body`), label, statut.
- Les messages ne sont pas dupliqués : ils sont relus depuis les transcripts de session Claude Code.

## 9. Phasage proposé

0. **Spike** : un chat Agent SDK dans le navigateur, dans un repo, avec les 5 vérifications du §4.
1. Repos, liste d'issues, chat d'issue, onglet Implémenter avec ses boutons, merge develop, rebase.
2. PR : liste, onglet, chat, review avec brouillons et publication.
3. Sous-issues en parallèle.
4. Page Spec et génération d'issues.
5. Confort : notifications, « citer pour répondre », Electron si besoin.

## 10. Questions ouvertes

Aucune pour l'instant. Prochaine étape : le spike (§4), puis la phase 1.

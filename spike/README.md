# Spike Clauded GIT

Vérifie, avant de construire l'app, ce que le Claude Agent SDK permet sur ta machine (voir §4 de
`SPEC.md`). Deux outils, à lancer depuis un terminal normal (pas depuis un chat Claude Code), dans
`clauded_git` :

```bash
npm install
```

## 1. Vérifications headless

```bash
npm run spike:check -- ~/Documents/github/wmx-core/monorepo
```

Lance une session Claude dans le repo, puis affiche une ligne par vérification :

| Vérification | Attendu |
| --- | --- |
| auth : compte Claude Code | ton email ou ton abonnement, sans clé API |
| skills du repo et du compte chargés | les dossiers `.claude/skills` du repo et de `~/.claude/skills` sont tous vus par le SDK |
| commandes slash | au moins les commandes de base |
| permissions : callback appelé | l'app a bien été consultée pour les commandes Bash, et a répondu oui |
| CLAUDE.md dans le contexte | Claude cite le CLAUDE.md du repo |
| docker depuis l'agent | ⚠️ attendu si la sandbox bloque le socket Docker |
| gh api POST depuis l'agent | ✅ ou ⚠️ selon ce qui bloque cette commande chez toi |
| reprise de session | un second `query` avec `resume` retrouve le contexte |
| historique | `listSessions` et `getSessionMessages` lisent les sessions existantes du repo |

Le transcript complet est écrit dans `spike/out/check-<date>.jsonl`. Le script coûte un ou deux
tours de modèle.

## 2. Chat dans le navigateur

```bash
npm run spike:web -- ~/Documents/github/wmx-core/monorepo
# puis ouvrir http://127.0.0.1:4747
```

- **Nouvelle session** démarre une session dans le dossier indiqué ; **Reprendre** reprend l'id saisi.
- Le fil affiche le texte en streaming, chaque appel d'outil (repliable, avec sa sortie), les
  messages système et le résultat de chaque tour (coût, durée).
- Les permissions sont acceptées automatiquement et affichées en gris.
- Le panneau de droite reprend les vérifications (compte, skills, commandes, historique du repo).
- Essaie une commande slash (`/core-pr-review`, `/compact`…) et un skill du repo, pour voir ce qui
  passe par le SDK.

`PORT=5000 npm run spike:web -- <repo>` pour changer de port.

# Clauded GIT

## Lancer l'app pour tester

Ta session ne peut pas lancer l'app : le bac à sable interdit d'ouvrir un port local et d'appeler `api.anthropic.com`. Elle ne peut pas non plus joindre `127.0.0.1` avec curl. C'est Andriy qui lance l'instance de test avec `yarn dev:test` :

- UI (Vite, rechargement à chaud) : http://127.0.0.1:5174/. C'est l'URL à utiliser, par exemple avec le MCP `chrome-devtools`, dont le navigateur tourne hors du bac à sable.
- Serveur (API, WebSocket, build `web/dist` s'il existe) : http://127.0.0.1:4848. Ses données sont dans `/tmp/clauded-test`, séparées de l'instance de tous les jours (ports 5173/4747, `~/.clauded-git`).

Le serveur se recharge tout seul (`tsx watch`). Si un changement demande un redémarrage complet, ou si l'instance ne tourne pas, demande à Andriy de lancer ou relancer `yarn dev:test` au lieu d'essayer toi-même. Avant de rendre la main, vérifie au minimum `npx tsc -p .`, `npx tsc -p web` et `npm run build`.

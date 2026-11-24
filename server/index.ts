import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { watchBatches } from './batch.js';
import { HOST, PORT } from './config.js';
import { resetRunStates } from './db.js';
import { jobs } from './jobs.js';
import { reviewWatcher } from './review.js';
import { registerRoutes } from './routes.js';
import { guardOrigin } from './security.js';
import { sessions } from './sessions/manager.js';
import { specWatcher } from './spec.js';
import { registerWebSocket, wireSessionEvents } from './ws.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

resetRunStates();
wireSessionEvents();
guardOrigin(app);

// Les prompts peuvent contenir des images en base64 : plafond large.
await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 * 1024 } });
await registerWebSocket(app);
await registerRoutes(app);

// En production, le serveur sert l'UI compilée ; en dev, Vite la sert et proxifie /api et /ws.
const webDist = fileURLToPath(new URL('../web/dist/', import.meta.url));
if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
        if (request.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'introuvable' });
        return reply.sendFile('index.html');
    });
}

const shutdown = (): void => {
    sessions.closeAll();
    reviewWatcher.stop();
    specWatcher.stop();
    jobs.stopAll();
    void app.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: HOST, port: PORT });
sessions.startAccountPolling();
await reviewWatcher.start();
await specWatcher.start();
watchBatches();
console.log(`Clauded GIT : http://${HOST}:${PORT}${existsSync(webDist) ? '' : '  (UI : lance aussi vite, ou npm run dev)'}`);

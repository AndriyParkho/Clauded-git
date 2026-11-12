import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { HOST, PORT } from './config.js';
import { resetRunStates } from './db.js';
import { registerRoutes } from './routes.js';
import { sessions } from './sessions/manager.js';
import { registerWebSocket, wireSessionEvents } from './ws.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

resetRunStates();
wireSessionEvents();

await app.register(fastifyWebsocket);
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
    void app.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: HOST, port: PORT });
console.log(`Clauded GIT : http://${HOST}:${PORT}${existsSync(webDist) ? '' : '  (UI : lance aussi vite, ou npm run dev)'}`);

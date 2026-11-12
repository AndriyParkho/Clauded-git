import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { getRun, listRepos, listRuns } from './db.js';
import { jobs } from './jobs.js';
import { sessions } from './sessions/manager.js';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

const clients = new Set<WebSocket>();

export function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of clients) {
        if (client.readyState === client.OPEN) client.send(payload);
    }
}

/** Branche les événements du gestionnaire de sessions sur tous les clients connectés. */
export function wireSessionEvents(): void {
    sessions.on('sdk', (runId, message) => broadcast({ type: 'sdk', runId, message }));
    sessions.on('run', (run) => broadcast({ type: 'run', run }));
    sessions.on('ask', (ask) => broadcast({ type: 'ask', ask }));
    sessions.on('askResolved', (runId, requestId) => broadcast({ type: 'askResolved', runId, requestId }));
    sessions.on('permission', (event) => broadcast({ type: 'permission', event }));
    sessions.on('commands', (runId, commands) => broadcast({ type: 'commands', runId, commands }));
    sessions.on('models', (runId, models) => broadcast({ type: 'models', runId, models }));
    sessions.on('usage', (usage) => broadcast({ type: 'usage', usage }));
    jobs.on('job', (job) => broadcast({ type: 'job', job }));
    sessions.on('error', (runId, message) => broadcast(runId === undefined ? { type: 'error', message } : { type: 'error', runId, message }));
}

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
    app.get('/ws', { websocket: true }, (socket: WebSocket) => {
        clients.add(socket);
        const send = (message: ServerMessage): void => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
        };
        send({ type: 'hello', runs: listRuns(), repos: listRepos() });

        socket.on('message', (raw) => {
            let message: ClientMessage;
            try {
                message = JSON.parse(String(raw)) as ClientMessage;
            } catch {
                return;
            }
            void handle(message, send).catch((error: unknown) => send({ type: 'error', runId: message.runId, message: String(error) }));
        });
        socket.on('close', () => clients.delete(socket));
    });
}

async function handle(message: ClientMessage, send: (message: ServerMessage) => void): Promise<void> {
    switch (message.type) {
        case 'prompt':
            await sessions.prompt(message.runId, message.text);
            break;
        case 'interrupt':
            await sessions.interrupt(message.runId);
            break;
        case 'answer':
            sessions.answer(message.runId, message.requestId, { allow: message.allow, updatedInput: message.updatedInput, message: message.message });
            break;
        case 'replay': {
            if (!sessions.isLive(message.runId) && getRun(message.runId)) await sessions.open(message.runId);
            send({ type: 'replay', runId: message.runId, ...sessions.replay(message.runId), jobs: jobs.listForRun(message.runId) });
            break;
        }
        case 'setPermissionMode':
            await sessions.setPermissionMode(message.runId, message.mode);
            break;
        case 'setModel':
            await sessions.setModel(message.runId, message.model);
            break;
    }
}

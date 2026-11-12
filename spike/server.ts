/**
 * Spike web : un seul chat Claude Code dans le navigateur, dans le repo donné.
 *
 *   npm run spike:web -- ~/Documents/github/wmx-core/monorepo
 *   → http://127.0.0.1:4747
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { listSessions, query, type Query, type SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { PromptQueue, sessionOptions } from './common.js';

const PORT = Number(process.env.PORT ?? 4747);
const defaultCwd = resolve(process.argv[2] ?? process.cwd());
const indexHtml = new URL('./public/index.html', import.meta.url);

type ClientMessage =
    | { type: 'start'; cwd?: string; resume?: string }
    | { type: 'prompt'; text: string }
    | { type: 'interrupt' };

interface Session {
    q: Query;
    queue: PromptQueue;
}

const server = createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(await readFile(indexHtml));
        return;
    }
    res.writeHead(404);
    res.end();
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket: WebSocket) => {
    let session: Session | undefined;
    const send = (payload: unknown): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };

    const stop = (): void => {
        if (!session) return;
        session.queue.close();
        session.q.close();
        session = undefined;
    };

    const runChecks = async (q: Query, init: SDKSystemMessage, cwd: string): Promise<void> => {
        try {
            const account = await q.accountInfo();
            const who = [account.email, account.organization, account.subscriptionType, account.tokenSource ?? account.apiKeySource].filter(Boolean).join(' · ');
            send({ type: 'check', name: 'auth : compte Claude Code', status: account.email || account.subscriptionType ? 'ok' : 'warn', detail: who || 'aucune info' });
        } catch (error) {
            send({ type: 'check', name: 'auth : compte Claude Code', status: 'ko', detail: String(error) });
        }
        send({ type: 'check', name: 'skills chargés', status: init.skills.length ? 'ok' : 'warn', detail: init.skills.join(', ') || 'aucun' });
        send({ type: 'check', name: 'commandes slash', status: init.slash_commands.length ? 'ok' : 'ko', detail: `${init.slash_commands.length} commandes` });
        send({ type: 'check', name: 'plugins / MCP', status: 'ok', detail: `${init.plugins.map((p) => p.name).join(', ') || 'aucun plugin'} · ${init.mcp_servers.map((s) => `${s.name}:${s.status}`).join(', ') || 'aucun MCP'}` });
        try {
            const sessions = await listSessions({ dir: cwd, limit: 5 });
            send({
                type: 'check',
                name: 'historique du repo',
                status: sessions.length ? 'ok' : 'warn',
                detail: sessions.map((s) => `${s.sessionId.slice(0, 8)} [${s.gitBranch ?? '?'}] ${(s.customTitle ?? s.summary ?? s.firstPrompt ?? '').slice(0, 60)}`).join('\n') || 'aucune session',
            });
        } catch (error) {
            send({ type: 'check', name: 'historique du repo', status: 'ko', detail: String(error) });
        }
    };

    const start = (cwd: string, resume?: string): void => {
        stop();
        const queue = new PromptQueue();
        const params = {
            cwd,
            includePartialMessages: true,
            onPermission: (tool: string, input: Record<string, unknown>) => send({ type: 'permission', tool, input, decision: 'allow' }),
        };
        const q = query({ prompt: queue, options: sessionOptions(resume ? { ...params, resume } : params) });
        session = { q, queue };
        send({ type: 'cwd', cwd });
        send({ type: 'status', state: 'idle', text: resume ? `reprise de ${resume.slice(0, 8)}…` : 'session démarrée' });

        void (async () => {
            try {
                for await (const message of q) {
                    send({ type: 'sdk', message });
                    if (message.type === 'system' && message.subtype === 'init') void runChecks(q, message, cwd);
                }
                send({ type: 'status', state: 'idle', text: 'session terminée' });
            } catch (error) {
                send({ type: 'error', message: String(error) });
            }
        })();
    };

    send({ type: 'cwd', cwd: defaultCwd });

    socket.on('message', (raw) => {
        let message: ClientMessage;
        try {
            message = JSON.parse(String(raw)) as ClientMessage;
        } catch {
            return;
        }
        switch (message.type) {
            case 'start':
                start(resolve(message.cwd || defaultCwd), message.resume || undefined);
                break;
            case 'prompt':
                if (!session) {
                    start(defaultCwd);
                }
                session?.queue.push(message.text);
                break;
            case 'interrupt':
                void session?.q.interrupt().catch((error: unknown) => send({ type: 'error', message: String(error) }));
                break;
        }
    });

    socket.on('close', stop);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Clauded GIT spike : http://127.0.0.1:${PORT}  (cwd par défaut : ${defaultCwd})`);
});

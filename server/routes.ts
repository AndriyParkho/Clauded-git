import type { FastifyInstance } from 'fastify';
import { basename, resolve } from 'node:path';
import { deleteRepo, deleteRun, getRepo, getRun, insertRun, listRepos, listRuns, listRunsForIssue, updateRepo, updateRun } from './db.js';
import { exec } from './exec.js';
import { diffAgainstBase } from './git.js';
import { getIssue, listIssues } from './github.js';
import { mergeBase, mergeIntegration, runProfileCommand, runWorktreeInfo, startImplement, startIssueChat, startMergeResolution } from './implement.js';
import { jobs } from './jobs.js';
import { loadProfile, profilePath, saveProfile, type Profile } from './profiles.js';
import { addRepo, isDirectory, repoSessions, scanRepos } from './repos.js';
import { sessions } from './sessions/manager.js';
import type { IssueFilter, IssueState, Repo, RepoIssues, RunType } from '../shared/protocol.js';

interface CreateRunBody {
    repoId?: number;
    cwd?: string;
    type?: RunType;
    title?: string;
    sessionId?: string;
}

const ISSUES_TTL_MS = 60_000;
const issuesCache = new Map<string, RepoIssues>();

function expand(path: string): string {
    return path.startsWith('~') ? path.replace('~', process.env.HOME ?? '') : path;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
    const repoOr404 = (id: string, reply: { code: (c: number) => { send: (b: unknown) => unknown } }): Repo | undefined => {
        const repo = getRepo(Number(id));
        if (!repo) reply.code(404).send({ error: 'dépôt introuvable' });
        return repo;
    };

    // ---------------------------------------------------------------------------------------
    // Repos
    // ---------------------------------------------------------------------------------------

    app.get('/api/repos', async () => listRepos());

    app.post<{ Body: { path: string } }>('/api/repos', async (request, reply) => {
        const path = request.body?.path?.trim();
        if (!path) return reply.code(400).send({ error: 'chemin manquant' });
        const expanded = expand(path);
        if (!(await isDirectory(expanded))) return reply.code(400).send({ error: `dossier introuvable : ${expanded}` });
        const result = await addRepo(expanded);
        if (result.status === 'not-a-repo') return reply.code(400).send({ error: `pas un dépôt git : ${expanded}` });
        return result;
    });

    app.post<{ Body: { root: string } }>('/api/repos/scan', async (request, reply) => {
        const root = request.body?.root?.trim();
        if (!root) return reply.code(400).send({ error: 'dossier manquant' });
        const expanded = expand(root);
        if (!(await isDirectory(expanded))) return reply.code(400).send({ error: `dossier introuvable : ${expanded}` });
        const found = await scanRepos(expanded);
        const added: Repo[] = [];
        const existing: Repo[] = [];
        for (const path of found) {
            const result = await addRepo(path);
            if (result.status === 'added') added.push(result.repo);
            else if (result.status === 'exists') existing.push(result.repo);
        }
        return { found, added, existing };
    });

    app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/repos/:id', async (request, reply) => {
        const repo = updateRepo(Number(request.params.id), { ...(request.body?.enabled !== undefined ? { enabled: request.body.enabled } : {}) });
        if (!repo) return reply.code(404).send({ error: 'dépôt introuvable' });
        return repo;
    });

    app.delete<{ Params: { id: string } }>('/api/repos/:id', async (request) => {
        deleteRepo(Number(request.params.id));
        return { ok: true };
    });

    app.get<{ Params: { id: string } }>('/api/repos/:id/sessions', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && repoSessions(repo);
    });

    app.get<{ Params: { id: string } }>('/api/repos/:id/profile', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && { path: profilePath(repo), profile: await loadProfile(repo) };
    });

    app.put<{ Params: { id: string }; Body: Profile }>('/api/repos/:id/profile', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        if (!repo) return;
        await saveProfile(repo, request.body);
        return { path: profilePath(repo), profile: await loadProfile(repo) };
    });

    // ---------------------------------------------------------------------------------------
    // Issues
    // ---------------------------------------------------------------------------------------

    app.get<{ Querystring: { repoId?: string; filter?: IssueFilter; state?: IssueState; refresh?: string } }>('/api/issues', async (request) => {
        const filter = request.query.filter ?? 'assigned';
        const state = request.query.state ?? 'open';
        const repos = request.query.repoId ? [getRepo(Number(request.query.repoId))].filter((r): r is Repo => Boolean(r)) : listRepos().filter((r) => r.enabled && r.host === 'github.com');
        const results: RepoIssues[] = [];
        await Promise.all(
            repos.map(async (repo) => {
                const key = `${repo.id}:${filter}:${state}`;
                const cached = issuesCache.get(key);
                if (cached && !request.query.refresh && Date.now() - new Date(cached.fetchedAt).getTime() < ISSUES_TTL_MS) {
                    results.push(cached);
                    return;
                }
                let entry: RepoIssues;
                try {
                    entry = { repoId: repo.id, issues: await listIssues(repo, filter, state), fetchedAt: new Date().toISOString() };
                    issuesCache.set(key, entry);
                } catch (error) {
                    entry = { repoId: repo.id, issues: cached?.issues ?? [], error: String(error), fetchedAt: new Date().toISOString() };
                }
                results.push(entry);
            }),
        );
        return results.sort((a, b) => a.repoId - b.repoId);
    });

    app.get<{ Params: { id: string; number: string } }>('/api/repos/:id/issues/:number', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        if (!repo) return;
        const number = Number(request.params.number);
        return { issue: await getIssue(repo, number), runs: listRunsForIssue(repo.id, number) };
    });

    app.post<{ Params: { id: string; number: string } }>('/api/repos/:id/issues/:number/chat', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && startIssueChat(repo, Number(request.params.number));
    });

    app.post<{ Params: { id: string; number: string }; Body: { planMode?: boolean } }>('/api/repos/:id/issues/:number/implement', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && startImplement(repo, Number(request.params.number), { planMode: Boolean(request.body?.planMode) });
    });

    // ---------------------------------------------------------------------------------------
    // Runs (onglets)
    // ---------------------------------------------------------------------------------------

    app.get('/api/runs', async () => listRuns());

    app.post<{ Body: CreateRunBody }>('/api/runs', async (request, reply) => {
        const body = request.body ?? {};
        const repo = body.repoId !== undefined ? getRepo(body.repoId) : undefined;
        if (body.repoId !== undefined && !repo) return reply.code(404).send({ error: 'dépôt introuvable' });
        const cwd = resolve(expand(body.cwd ?? repo?.path ?? process.cwd()));
        if (!(await isDirectory(cwd))) return reply.code(400).send({ error: `dossier introuvable : ${cwd}` });
        const run = insertRun({
            repoId: repo?.id ?? null,
            type: body.type ?? 'chat',
            cwd,
            title: body.title ?? (body.sessionId ? 'Session reprise' : `Chat · ${repo?.name ?? basename(cwd)}`),
            sessionId: body.sessionId ?? null,
        });
        await sessions.open(run.id);
        return getRun(run.id);
    });

    app.post<{ Params: { id: string } }>('/api/runs/:id/open', async (request, reply) => {
        const run = getRun(Number(request.params.id));
        if (!run) return reply.code(404).send({ error: 'onglet introuvable' });
        return sessions.open(run.id);
    });

    app.post<{ Params: { id: string } }>('/api/runs/:id/close', async (request, reply) => {
        const run = getRun(Number(request.params.id));
        if (!run) return reply.code(404).send({ error: 'onglet introuvable' });
        sessions.close(run.id);
        return getRun(run.id);
    });

    app.patch<{ Params: { id: string }; Body: { title?: string } }>('/api/runs/:id', async (request, reply) => {
        const run = updateRun(Number(request.params.id), { ...(request.body?.title ? { title: request.body.title } : {}) });
        if (!run) return reply.code(404).send({ error: 'onglet introuvable' });
        return run;
    });

    app.delete<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
        const id = Number(request.params.id);
        sessions.close(id);
        deleteRun(id);
        return { ok: true };
    });

    // ---------------------------------------------------------------------------------------
    // Actions d'un onglet d'implémentation
    // ---------------------------------------------------------------------------------------

    const runAndRepo = (id: string, reply: { code: (c: number) => { send: (b: unknown) => unknown } }): { run: ReturnType<typeof getRun>; repo: Repo | undefined } => {
        const run = getRun(Number(id));
        if (!run) {
            reply.code(404).send({ error: 'onglet introuvable' });
            return { run: undefined, repo: undefined };
        }
        const repo = run.repoId !== null ? getRepo(run.repoId) : undefined;
        if (!repo) reply.code(400).send({ error: 'onglet sans dépôt' });
        return { run, repo };
    };

    app.get<{ Params: { id: string } }>('/api/runs/:id/worktree', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && runWorktreeInfo(repo, run);
    });

    app.get<{ Params: { id: string } }>('/api/runs/:id/diff', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        if (!run || !repo) return;
        const base = run.baseBranch ?? (await loadProfile(repo)).baseBranch;
        return diffAgainstBase(run.cwd, base);
    });

    app.get<{ Params: { id: string } }>('/api/runs/:id/jobs', async (request) => jobs.listForRun(Number(request.params.id)));

    app.post<{ Params: { id: string }; Body: { app: 'vscode' | 'finder' | 'terminal' | 'iterm' } }>('/api/runs/:id/open-in', async (request, reply) => {
        const run = getRun(Number(request.params.id));
        if (!run) return reply.code(404).send({ error: 'onglet introuvable' });
        const commands = {
            vscode: ['code', [run.cwd]],
            finder: ['open', [run.cwd]],
            terminal: ['open', ['-a', 'Terminal', run.cwd]],
            iterm: ['open', ['-a', 'iTerm', run.cwd]],
        } as const;
        const [file, args] = commands[request.body?.app ?? 'vscode'];
        const result = await exec(file, [...args]);
        if (result.code !== 0) return reply.code(500).send({ error: result.stderr.trim() || `${file} a échoué` });
        return { ok: true };
    });

    app.post<{ Params: { id: string }; Body: { name: string } }>('/api/runs/:id/command', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && runProfileCommand(repo, run, request.body.name);
    });

    app.post<{ Params: { id: string } }>('/api/runs/:id/merge-base', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && mergeBase(repo, run);
    });

    app.post<{ Params: { id: string } }>('/api/runs/:id/merge-integration', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && mergeIntegration(repo, run);
    });

    app.post<{ Params: { id: string }; Body: { jobId: string } }>('/api/runs/:id/resolve-merge', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        if (!run || !repo) return;
        const job = jobs.get(request.body.jobId);
        if (!job) return reply.code(404).send({ error: 'job introuvable' });
        return startMergeResolution(repo, run, job);
    });
}

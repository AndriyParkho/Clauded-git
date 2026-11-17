import type { FastifyInstance } from 'fastify';
import { basename, resolve } from 'node:path';
import { cancelItem, forceStart, startBatch, type BatchRequest } from './batch.js';
import { archiveRun, deleteDraft, deleteRepo, getRepo, getRun, insertDraft, insertRun, listBatchItems, listRepos, listRuns, saveReviewRow, updateDraft, updateRepo, updateRun } from './db.js';
import { brunoState, switchBruno } from './bruno.js';
import { listCleanup, startCleanup } from './cleanup.js';
import { analyzeDependencies } from './dependencies.js';
import { diffAgainstBase } from './git.js';
import { listIssues, pullRequestForBranch } from './github.js';
import { issueBranch, issueDetail, mergeBaseInto, mergeIntegration, pullBranch, resumeIssueSession, runInstall, runMergeSource, runProfileCommand, runBase, runProjects, runShell, runWorktreeInfo, startImplement, startIssueChat, startMergeResolution } from './implement.js';
import { jobs } from './jobs.js';
import { openIn } from './open.js';
import { openPr, prDetail, sendReviewComments, startReview } from './pr.js';
import { loadProfile, profilePath, saveProfile, type Profile } from './profiles.js';
import { getPull, listPulls, pullDiff } from './pulls.js';
import { addRepo, isDirectory, repoSessions, scanRepos } from './repos.js';
import { importReviewFile, publishReview, reviewState } from './review.js';
import { sessions } from './sessions/manager.js';
import { listSkills } from './skills.js';
import { broadcast } from './ws.js';
import type { IssueFilter, IssueState, OpenApp, PullFilter, Repo, RepoIssues, RepoPulls, ReviewDraft, ReviewEvent, ReviewState, RunType } from '../shared/protocol.js';

interface CreateRunBody {
    repoId?: number;
    cwd?: string;
    type?: RunType;
    title?: string;
    sessionId?: string;
}

const ISSUES_TTL_MS = 60_000;
const issuesCache = new Map<string, RepoIssues>();
const pullsCache = new Map<string, RepoPulls>();

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

    /**
     * Première page des issues de chaque dépôt (cache 60 s). Avec `more=1` et `repoId`, charge la
     * page suivante du dépôt et l'ajoute à l'entrée en cache, qui cumule donc les pages chargées.
     */
    app.get<{ Querystring: { repoId?: string; filter?: IssueFilter; state?: IssueState; refresh?: string; more?: string } }>('/api/issues', async (request, reply) => {
        const filter = request.query.filter ?? 'assigned';
        const state = request.query.state ?? 'open';
        const more = Boolean(request.query.more);
        if (more && !request.query.repoId) return reply.code(400).send({ error: 'repoId requis pour charger la suite' });
        const repos = request.query.repoId ? [getRepo(Number(request.query.repoId))].filter((r): r is Repo => Boolean(r)) : listRepos().filter((r) => r.enabled && r.host === 'github.com');
        const results: RepoIssues[] = [];
        await Promise.all(
            repos.map(async (repo) => {
                const key = `${repo.id}:${filter}:${state}`;
                const cached = issuesCache.get(key);
                const fresh = cached !== undefined && Date.now() - new Date(cached.fetchedAt).getTime() < ISSUES_TTL_MS;
                if (cached && !more && !request.query.refresh && fresh) {
                    results.push(cached);
                    return;
                }
                const after = more ? (cached?.nextCursor ?? null) : null;
                if (more && (!cached || !after)) {
                    results.push(cached ?? { repoId: repo.id, issues: [], nextCursor: null, fetchedAt: new Date().toISOString() });
                    return;
                }
                let entry: RepoIssues;
                try {
                    const page = await listIssues(repo, filter, state, after);
                    const previous = more && cached ? cached.issues.filter((i) => !page.issues.some((p) => p.number === i.number)) : [];
                    entry = { repoId: repo.id, issues: [...previous, ...page.issues], nextCursor: page.nextCursor, fetchedAt: new Date().toISOString() };
                    issuesCache.set(key, entry);
                } catch (error) {
                    entry = { repoId: repo.id, issues: cached?.issues ?? [], nextCursor: cached?.nextCursor ?? null, error: String(error), fetchedAt: new Date().toISOString() };
                }
                results.push(entry);
            }),
        );
        return results.sort((a, b) => a.repoId - b.repoId);
    });

    app.get<{ Params: { id: string; number: string } }>('/api/repos/:id/issues/:number', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && issueDetail(repo, Number(request.params.number));
    });

    app.post<{ Params: { id: string; number: string }; Body: { sessionId: string } }>('/api/repos/:id/issues/:number/resume', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        if (!repo) return;
        if (!request.body?.sessionId) return reply.code(400).send({ error: 'sessionId manquant' });
        return resumeIssueSession(repo, Number(request.params.number), request.body.sessionId);
    });

    app.post<{ Body: { path: string; app: OpenApp } }>('/api/open-in', async (request, reply) => {
        if (!request.body?.path) return reply.code(400).send({ error: 'chemin manquant' });
        try {
            await openIn(request.body.path, request.body.app ?? 'vscode');
        } catch (error) {
            return reply.code(400).send({ error: String(error instanceof Error ? error.message : error) });
        }
        return { ok: true };
    });

    app.post<{ Params: { id: string; number: string } }>('/api/repos/:id/issues/:number/chat', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && startIssueChat(repo, Number(request.params.number));
    });

    app.post<{ Params: { id: string; number: string }; Body: { planMode?: boolean; opId?: string } }>('/api/repos/:id/issues/:number/implement', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && startImplement(repo, Number(request.params.number), { planMode: Boolean(request.body?.planMode), opId: request.body?.opId });
    });

    // Plusieurs issues : dépendances, puis lancement en lot (attente et stacked PR pour les dépendantes).
    app.post<{ Params: { id: string }; Body: { issues: number[]; claude?: boolean } }>('/api/repos/:id/issues/dependencies', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        if (!repo) return;
        const issues = (request.body?.issues ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (issues.length === 0) return reply.code(400).send({ error: 'aucune issue' });
        return analyzeDependencies(repo, issues, { claude: Boolean(request.body.claude) });
    });

    app.post<{ Params: { id: string }; Body: BatchRequest }>('/api/repos/:id/issues/batch', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        if (!repo) return;
        try {
            return await startBatch(repo, { issues: request.body.issues ?? [], dependencies: request.body.dependencies ?? [], planMode: Boolean(request.body.planMode), opId: request.body.opId });
        } catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/batch', async () => listBatchItems());

    // Nettoyage des worktrees et branches qui ne servent plus.
    app.get<{ Params: { id: string } }>('/api/repos/:id/cleanup', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && listCleanup(repo);
    });

    app.post<{ Params: { id: string }; Body: { ids: string[] } }>('/api/repos/:id/cleanup', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && startCleanup(repo, request.body?.ids ?? []);
    });

    // Environnement Bruno : sur quel checkout il pointe, et bascule.
    app.get<{ Params: { id: string } }>('/api/repos/:id/bruno', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && brunoState(repo);
    });

    app.post<{ Params: { id: string }; Body: { path: string } }>('/api/repos/:id/bruno', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        if (!repo) return;
        try {
            return await switchBruno(repo, request.body?.path ?? '');
        } catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.post<{ Params: { id: string; number: string } }>('/api/repos/:id/batch/:number/start', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && forceStart(repo, Number(request.params.number));
    });

    app.delete<{ Params: { id: string; number: string } }>('/api/repos/:id/batch/:number', async (request) => {
        cancelItem(Number(request.params.id), Number(request.params.number));
        return { ok: true };
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

    /** Fermer un onglet l'archive : il disparaît de la barre mais reste dans l'historique de son issue. */
    app.delete<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
        const id = Number(request.params.id);
        sessions.close(id);
        archiveRun(id);
        sessions.notifyRun(id); // l'UI retire les onglets archivés
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

    app.get<{ Params: { id: string } }>('/api/runs/:id/projects', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && runProjects(repo, run);
    });

    app.post<{ Params: { id: string }; Body: { name: string; project?: string } }>('/api/runs/:id/command', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && runProfileCommand(repo, run, request.body.name, request.body.project);
    });

    app.post<{ Params: { id: string }; Body: { command: string; project?: string } }>('/api/runs/:id/exec', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && runShell(run, request.body.command, request.body.command, request.body.project);
    });

    app.post<{ Params: { id: string } }>('/api/runs/:id/install', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && runInstall(repo, run);
    });

    app.post<{ Params: { id: string } }>('/api/jobs/:id/stop', async (request, reply) => {
        if (!jobs.stop(request.params.id)) return reply.code(409).send({ error: 'cette commande ne tourne plus' });
        return { ok: true };
    });

    app.post<{ Params: { id: string } }>('/api/runs/:id/merge-base', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && mergeBaseInto(repo, await runMergeSource(repo, run), await runBase(repo, run), run.id);
    });

    /** Merge de master dans la branche d'une issue ou d'une PR, hors onglet (pages Issues et PR). */
    app.post<{ Params: { id: string }; Body: { issueNumber?: number; prNumber?: number } }>('/api/repos/:id/merge-base', async (request, reply) => {
        const repo = getRepo(Number(request.params.id));
        if (!repo) return reply.code(404).send({ error: 'dépôt introuvable' });
        const { issueNumber, prNumber } = request.body;
        if (prNumber !== undefined) {
            const pull = await getPull(repo, prNumber);
            if (pull.isCrossRepository) return reply.code(400).send({ error: `la PR #${prNumber} vient d'un fork : sa branche n'est pas sur origin` });
            return mergeBaseInto(repo, { branch: pull.headRefName, issueNumber: null, prNumber }, pull.baseRefName, 0);
        }
        if (issueNumber !== undefined) return mergeBaseInto(repo, { branch: await issueBranch(repo, issueNumber), issueNumber, prNumber: null }, (await loadProfile(repo)).baseBranch, 0);
        return reply.code(400).send({ error: 'issueNumber ou prNumber requis' });
    });

    /** Merge dans develop de la branche d'un onglet (implémentation, PR, ou chat d'issue). */
    app.post<{ Params: { id: string } }>('/api/runs/:id/merge-integration', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && mergeIntegration(repo, await runMergeSource(repo, run), run.id);
    });

    /** Merge dans develop de la branche d'une issue ou d'une PR, hors onglet (pages Issues et PR). */
    app.post<{ Params: { id: string }; Body: { issueNumber?: number; prNumber?: number } }>('/api/repos/:id/merge-integration', async (request, reply) => {
        const repo = getRepo(Number(request.params.id));
        if (!repo) return reply.code(404).send({ error: 'dépôt introuvable' });
        const { issueNumber, prNumber } = request.body;
        if (prNumber !== undefined) return mergeIntegration(repo, { branch: await pullBranch(repo, prNumber), issueNumber: null, prNumber }, 0);
        if (issueNumber !== undefined) return mergeIntegration(repo, { branch: await issueBranch(repo, issueNumber), issueNumber, prNumber: null }, 0);
        return reply.code(400).send({ error: 'issueNumber ou prNumber requis' });
    });

    app.post<{ Params: { id: string } }>('/api/jobs/:id/resolve-merge', async (request, reply) => {
        const job = jobs.get(request.params.id);
        if (!job) return reply.code(404).send({ error: 'job introuvable' });
        return startMergeResolution(job);
    });

    /** La PR d'un onglet : celle qu'il relit, ou celle de sa branche (onglet d'implémentation). */
    app.get<{ Params: { id: string } }>('/api/runs/:id/pull', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        if (!run || !repo) return;
        const number = run.prNumber ?? (run.branch ? (await pullRequestForBranch(repo, run.branch).catch(() => undefined))?.number : undefined);
        if (number === undefined) return { pull: null };
        return { pull: await getPull(repo, number) };
    });

    app.post<{ Params: { id: string } }>('/api/runs/:id/review', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        if (!run || !repo) return;
        await startReview(repo, run);
        return { ok: true };
    });

    app.post<{ Params: { id: string } }>('/api/runs/:id/review-comments', async (request, reply) => {
        const { run, repo } = runAndRepo(request.params.id, reply);
        return run && repo && sendReviewComments(repo, run);
    });

    // ---------------------------------------------------------------------------------------
    // Pull requests et review
    // ---------------------------------------------------------------------------------------

    app.get<{ Querystring: { repoId?: string; filter?: PullFilter; refresh?: string } }>('/api/pulls', async (request) => {
        const filter = request.query.filter ?? 'review';
        const repos = request.query.repoId ? [getRepo(Number(request.query.repoId))].filter((r): r is Repo => Boolean(r)) : listRepos().filter((r) => r.enabled && r.host === 'github.com');
        const results = await Promise.all(
            repos.map(async (repo): Promise<RepoPulls> => {
                const key = `${repo.id}:${filter}`;
                const cached = pullsCache.get(key);
                if (cached && !request.query.refresh && Date.now() - new Date(cached.fetchedAt).getTime() < ISSUES_TTL_MS) return cached;
                try {
                    const entry: RepoPulls = { repoId: repo.id, pulls: await listPulls(repo, filter), fetchedAt: new Date().toISOString() };
                    pullsCache.set(key, entry);
                    return entry;
                } catch (error) {
                    return { repoId: repo.id, pulls: cached?.pulls ?? [], error: String(error), fetchedAt: new Date().toISOString() };
                }
            }),
        );
        return results.sort((a, b) => a.repoId - b.repoId);
    });

    app.get<{ Params: { id: string; number: string } }>('/api/repos/:id/pulls/:number', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && prDetail(repo, Number(request.params.number));
    });

    app.get<{ Params: { id: string; number: string } }>('/api/repos/:id/pulls/:number/diff', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && { patch: await pullDiff(repo, Number(request.params.number)) };
    });

    /** Skills et commandes que les sessions du dépôt peuvent appeler (pour choisir le skill de review). */
    app.get<{ Params: { id: string } }>('/api/repos/:id/skills', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && listSkills(repo.path);
    });

    app.post<{ Params: { id: string; number: string }; Body: { review?: boolean; opId?: string } }>('/api/repos/:id/pulls/:number/open', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        return repo && openPr(repo, Number(request.params.number), { review: Boolean(request.body?.review), opId: request.body?.opId });
    });

    const reviewRoute = async (id: string, number: string, reply: Parameters<typeof repoOr404>[1], change?: (repo: Repo, pr: number) => void | Promise<void>): Promise<ReviewState | undefined> => {
        const repo = repoOr404(id, reply);
        if (!repo) return undefined;
        const pr = Number(number);
        // Un fichier écrit pendant que le serveur était arrêté est importé à la première lecture.
        await importReviewFile(repo, pr).catch(() => undefined);
        if (change) await change(repo, pr);
        const state = reviewState(repo, pr);
        if (change) broadcast({ type: 'review', review: state });
        return state;
    };

    app.get<{ Params: { id: string; number: string } }>('/api/repos/:id/pulls/:number/review', async (request, reply) => reviewRoute(request.params.id, request.params.number, reply));

    app.patch<{ Params: { id: string; number: string }; Body: { body?: string; event?: ReviewEvent } }>('/api/repos/:id/pulls/:number/review', async (request, reply) =>
        reviewRoute(request.params.id, request.params.number, reply, (repo, pr) => {
            const body = request.body ?? {};
            saveReviewRow(repo.id, pr, { ...(body.body !== undefined ? { body: body.body } : {}), ...(body.event ? { event: body.event } : {}) });
        }),
    );

    app.post<{ Params: { id: string; number: string }; Body: Omit<ReviewDraft, 'id' | 'source'> }>('/api/repos/:id/pulls/:number/review/drafts', async (request, reply) => {
        const draft = request.body;
        if (!draft?.path || typeof draft.line !== 'number') return reply.code(400).send({ error: 'path et line requis' });
        return reviewRoute(request.params.id, request.params.number, reply, (repo, pr) => {
            insertDraft(repo.id, pr, { path: draft.path, line: draft.line, startLine: draft.startLine ?? null, side: draft.side === 'LEFT' ? 'LEFT' : 'RIGHT', body: draft.body ?? '', label: draft.label ?? null, source: 'me' });
        });
    });

    app.patch<{ Params: { id: string; number: string; draftId: string }; Body: Partial<Pick<ReviewDraft, 'body' | 'label' | 'line' | 'startLine' | 'side'>> }>('/api/repos/:id/pulls/:number/review/drafts/:draftId', async (request, reply) =>
        reviewRoute(request.params.id, request.params.number, reply, () => updateDraft(Number(request.params.draftId), request.body ?? {})),
    );

    app.delete<{ Params: { id: string; number: string; draftId: string } }>('/api/repos/:id/pulls/:number/review/drafts/:draftId', async (request, reply) =>
        reviewRoute(request.params.id, request.params.number, reply, () => deleteDraft(Number(request.params.draftId))),
    );

    app.post<{ Params: { id: string; number: string } }>('/api/repos/:id/pulls/:number/review/publish', async (request, reply) => {
        const repo = repoOr404(request.params.id, reply);
        if (!repo) return;
        try {
            const state = await publishReview(repo, Number(request.params.number));
            broadcast({ type: 'review', review: state });
            return state;
        } catch (error) {
            return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        }
    });
}

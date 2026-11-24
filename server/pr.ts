import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findImplementRunByBranch, findPrRun, getRun, insertRun, listRunsForPr } from './db.js';
import { addWorktree, ensureWorktreesExcluded, git, gitOk, listWorktrees, worktreeStatus } from './git.js';
import { pullRequestForBranch } from './github.js';
import { loadProfile, type Profile } from './profiles.js';
import { Progress } from './progress.js';
import { getPull, openThreadsAsPrompt } from './pulls.js';
import { reviewFile, reviewPrompt } from './review.js';
import { chatBranch } from './implement.js';
import { sessions } from './sessions/manager.js';
import type { PullDetail, PullDetailResponse, Repo, Run } from '../shared/protocol.js';

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/** Branche locale de la PR : sa branche, ou `pr-<n>` pour une PR venue d'un fork. */
function localBranch(pull: PullDetail): string {
    return pull.isCrossRepository ? `pr-${pull.number}` : pull.headRefName;
}

/** Avance un worktree propre jusqu'au dernier commit de la PR (sans jamais forcer). */
async function fastForward(path: string, pull: PullDetail): Promise<void> {
    if ((await worktreeStatus(path)).dirty) return;
    const fetched = pull.isCrossRepository ? await git(path, ['fetch', 'origin', `pull/${pull.number}/head`]) : await git(path, ['fetch', 'origin', pull.headRefName]);
    if (fetched.code !== 0) return;
    await git(path, ['merge', '--ff-only', pull.isCrossRepository ? 'FETCH_HEAD' : `origin/${pull.headRefName}`]);
}

/**
 * Le worktree où relire la PR : celui où sa branche est déjà sortie (onglet d'implémentation de
 * l'issue, par exemple), sinon `.worktrees/pr-<n>`, créé pour l'occasion. Mis à jour s'il est propre.
 */
export async function prWorktree(repo: Repo, profile: Profile, pull: PullDetail, progress = new Progress(undefined)): Promise<{ path: string; branch: string }> {
    const branch = localBranch(pull);
    const checkedOut = (await listWorktrees(repo.path)).find((w) => w.branch === branch);
    if (checkedOut) {
        progress.skip(STEPS.fetch, STEPS.add);
        progress.step(STEPS.update, checkedOut.path);
        await fastForward(checkedOut.path, pull).catch(() => undefined);
        return { path: checkedOut.path, branch };
    }
    progress.skip(STEPS.update);
    const path = join(repo.path, profile.worktreesDir, `pr-${pull.number}`);
    await ensureWorktreesExcluded(repo.path);
    await mkdir(dirname(path), { recursive: true });
    if (pull.isCrossRepository) {
        progress.step(STEPS.fetch, `git fetch origin pull/${pull.number}/head`);
        await gitOk(repo.path, ['fetch', 'origin', `+pull/${pull.number}/head:${branch}`]);
        progress.step(STEPS.add, `git worktree add ${path}`);
        await gitOk(repo.path, ['worktree', 'add', path, branch]);
    } else {
        await addWorktree(repo.path, branch, path, (step) => (step === 'fetch' ? progress.step(STEPS.fetch, `git fetch origin ${branch}`) : progress.step(STEPS.add, `git worktree add ${path}`)));
    }
    return { path, branch };
}

/** Étapes affichées sous le loader pendant l'ouverture d'une PR. */
const STEPS = {
    pull: 'Lecture de la PR sur GitHub',
    update: 'Mise à jour du worktree existant',
    fetch: 'Récupération de la branche',
    add: 'Création du worktree (sortie des fichiers)',
    session: 'Démarrage de la session Claude',
    review: 'Envoi de la demande de review',
};

export async function prDetail(repo: Repo, number: number): Promise<PullDetailResponse> {
    const pull = await getPull(repo, number);
    const branch = localBranch(pull);
    // La branche peut être sortie dans le worktree de l'issue (implémentation) ou dans `pr-<n>`.
    const found = (await listWorktrees(repo.path).catch(() => [])).find((w) => w.branch === branch);
    return { pull, runs: listRunsForPr(repo.id, number), worktree: found ? { path: found.path, branch: found.branch } : null };
}

/** Lance la review (skill du profil) dans un onglet PR déjà ouvert. */
export async function startReview(repo: Repo, run: Run, progress = new Progress(undefined)): Promise<void> {
    if (run.prNumber === null) throw new Error('cet onglet n\'est pas un onglet de PR');
    const [pull, profile] = await Promise.all([getPull(repo, run.prNumber), loadProfile(repo)]);
    await fastForward(run.cwd, pull).catch(() => undefined);
    await sessions.open(run.id);
    progress.step(STEPS.review, profile.reviewSkill ? `skill /${profile.reviewSkill}` : 'review générique (aucun skill choisi)');
    await sessions.prompt(run.id, reviewPrompt(repo, pull, profile, reviewFile(repo, run.prNumber)));
}

/**
 * Ouvre (ou rouvre) l'onglet d'une PR : worktree sur sa branche, session Claude dedans. Avec
 * `review`, la review démarre tout de suite.
 */
export async function openPr(repo: Repo, number: number, options: { review: boolean; opId?: string | undefined }): Promise<Run> {
    const progress = new Progress(options.opId);
    return progress.run(async () => {
        const run = await openPrRun(repo, number, progress, options.review);
        if (options.review) await startReview(repo, run, progress);
        return getRun(run.id) ?? run;
    });
}

/**
 * Onglet d'implémentation sorti sur la branche de la PR (ma PR, ouverte depuis son issue) : c'est le
 * même travail, on y revient plutôt que d'ouvrir une seconde session sur la branche.
 */
async function implementRunForPr(repo: Repo, number: number): Promise<Run | undefined> {
    const pull = await getPull(repo, number);
    const run = findImplementRunByBranch(repo.id, localBranch(pull));
    return run?.worktree && (await exists(run.worktree)) ? run : undefined;
}

async function openPrRun(repo: Repo, number: number, progress: Progress, review: boolean): Promise<Run> {
    // Une review veut un contexte neuf (relecture à froid) : elle garde son propre onglet.
    const own = review ? undefined : await implementRunForPr(repo, number);
    if (own) {
        progress.plan([STEPS.session]);
        progress.step(STEPS.session, own.title);
        await sessions.open(own.id);
        return getRun(own.id) ?? own;
    }
    const existing = findPrRun(repo.id, number);
    let run: Run;
    if (existing && (await exists(existing.cwd))) {
        progress.plan([STEPS.session, ...(review ? [STEPS.review] : [])]);
        run = existing;
        progress.step(STEPS.session);
        await sessions.open(run.id);
    } else {
        progress.plan([STEPS.pull, STEPS.update, STEPS.fetch, STEPS.add, STEPS.session, ...(review ? [STEPS.review] : [])]);
        progress.step(STEPS.pull);
        const [pull, profile] = await Promise.all([getPull(repo, number), loadProfile(repo)]);
        const worktree = await prWorktree(repo, profile, pull, progress);
        run = insertRun({
            repoId: repo.id,
            type: 'pr',
            cwd: worktree.path,
            title: `PR #${number} ${pull.title}`.slice(0, 60),
            prNumber: number,
            branch: worktree.branch,
            baseBranch: pull.baseRefName,
            worktree: worktree.path,
        });
        progress.step(STEPS.session);
        await sessions.open(run.id);
    }
    return run;
}

/** Envoie au chat d'un onglet les commentaires de review non résolus de la PR de sa branche. */
export async function sendReviewComments(repo: Repo, run: Run): Promise<{ sent: number }> {
    const branch = run.branch ?? (await chatBranch(repo, run));
    const number = run.prNumber ?? (branch ? (await pullRequestForBranch(repo, branch))?.number : undefined);
    if (number === undefined) throw new Error('pas de PR pour cet onglet');
    const pull = await getPull(repo, number);
    const prompt = openThreadsAsPrompt(pull);
    if (!prompt) return { sent: 0 };
    await sessions.prompt(run.id, prompt);
    return { sent: pull.threads.filter((t) => !t.isResolved).length };
}

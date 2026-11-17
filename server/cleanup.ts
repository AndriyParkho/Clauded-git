import { basename, resolve } from 'node:path';
import { archiveRun, listRuns } from './db.js';
import { dependencyStatuses } from './dependencies.js';
import { git, gitOk, listWorktrees, type Worktree } from './git.js';
import { gh, repoSlug } from './github.js';
import { jobs } from './jobs.js';
import { loadProfile } from './profiles.js';
import { sessions } from './sessions/manager.js';
import type { CleanupItem, CleanupList, DependencyStatus, JobInfo, Repo, Run } from '../shared/protocol.js';

interface PrSummary {
    number: number;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    headRefName: string;
}

interface LocalBranch {
    name: string;
    /** `[gone]` : la branche distante suivie a été supprimée (souvent au merge de la PR). */
    gone: boolean;
}

async function localBranches(repoPath: string): Promise<LocalBranch[]> {
    const out = await gitOk(repoPath, ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)', 'refs/heads']);
    return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [name = '', upstream = '', track = ''] = line.split('\t');
            return { name, gone: upstream !== '' && track.includes('gone') };
        });
}

/** Dernière PR de chaque branche (une ouverte passe avant les autres). */
async function pullsByBranch(repo: Repo): Promise<Map<string, PrSummary>> {
    const list = await gh<PrSummary[]>(['pr', 'list', '--repo', repoSlug(repo), '--state', 'all', '--limit', '500', '--json', 'number,state,headRefName']);
    const map = new Map<string, PrSummary>();
    for (const pr of list) {
        const known = map.get(pr.headRefName);
        if (!known || (pr.state === 'OPEN' && known.state !== 'OPEN')) map.set(pr.headRefName, pr);
    }
    return map;
}

/** Numéro d'issue d'une branche : onglet d'implémentation qui l'utilise, sinon le numéro dans son nom (`feature/9307-…`). */
function issueOfBranch(branch: string | null, runs: Run[]): number | null {
    if (!branch) return null;
    const run = runs.find((r) => r.branch === branch && r.issueNumber !== null);
    if (run) return run.issueNumber;
    const match = /(?:^|\/)(\d+)(?:[-_/]|$)/.exec(branch);
    return match ? Number(match[1]) : null;
}

/** Onglets (non archivés) qui travaillent dans ce worktree. */
function runsIn(path: string, runs: Run[]): Run[] {
    const root = resolve(path);
    return runs.filter((r) => [r.worktree, r.cwd].some((p) => p !== null && (resolve(p) === root || resolve(p).startsWith(`${root}/`))));
}

/**
 * Worktrees et branches locales qui semblent ne plus servir : PR mergée (ou fermée), issue liée
 * fermée, branche déjà dans la base, branche distante supprimée. Une PR encore ouverte, les branches
 * de base/intégration et la branche du checkout principal ne sont jamais proposées.
 */
export async function listCleanup(repo: Repo): Promise<CleanupList> {
    const profile = await loadProfile(repo);
    const base = profile.baseBranch;
    await git(repo.path, ['fetch', 'origin', '--prune']);
    await git(repo.path, ['worktree', 'prune']);

    const mainBranch = (await git(repo.path, ['branch', '--show-current'])).stdout.trim();
    const protectedBranches = new Set([base, profile.integrationBranch, mainBranch].filter((b): b is string => Boolean(b)));
    const worktrees = (await listWorktrees(repo.path)).filter((w) => resolve(w.path) !== resolve(repo.path));
    const branches = await localBranches(repo.path);
    const gone = new Set(branches.filter((b) => b.gone).map((b) => b.name));
    const runs = listRuns();
    const pulls = await pullsByBranch(repo).catch(() => new Map<string, PrSummary>());

    // Unités : chaque worktree (avec sa branche), puis chaque branche locale sortie nulle part.
    const checkedOut = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null));
    const units: Array<{ worktree: Worktree | null; branch: string | null }> = [
        ...worktrees.map((w) => ({ worktree: w, branch: w.branch })),
        ...branches.filter((b) => !checkedOut.has(b.name) && b.name !== mainBranch).map((b) => ({ worktree: null, branch: b.name })),
    ];

    // Issues/PR liées, lues en une requête : `pr-<n>` est un worktree de PR, sinon le numéro vient de la branche.
    const numberOf = (unit: (typeof units)[number]): { issue: number | null; pr: number | null } => {
        const dir = unit.worktree ? basename(unit.worktree.path) : '';
        const prDir = /^pr-(\d+)$/.exec(dir);
        if (prDir) return { issue: null, pr: Number(prDir[1]) };
        const issueDir = /^issue-(\d+)$/.exec(dir);
        return { issue: issueOfBranch(unit.branch, runs) ?? (issueDir ? Number(issueDir[1]) : null), pr: null };
    };
    const numbers = units.flatMap((u) => Object.values(numberOf(u)).filter((n): n is number => n !== null));
    const statuses = await dependencyStatuses(repo, numbers, { runPrs: false }).catch(() => new Map<number, DependencyStatus>());

    // Branche entrée dans la base par un merge (pas par création : une branche neuve est aussi « ancêtre »).
    let firstParent: Set<string> | undefined;
    const mergedByGit = async (branch: string): Promise<boolean> => {
        const tip = (await git(repo.path, ['rev-parse', '--verify', `refs/heads/${branch}`])).stdout.trim();
        if (!tip || (await git(repo.path, ['merge-base', '--is-ancestor', tip, `origin/${base}`])).code !== 0) return false;
        firstParent ??= new Set((await git(repo.path, ['rev-list', '--first-parent', '--max-count=50000', `origin/${base}`])).stdout.split('\n'));
        return !firstParent.has(tip);
    };

    const items: CleanupItem[] = [];
    let kept = 0;
    for (const unit of units) {
        const { branch, worktree } = unit;
        if (branch && protectedBranches.has(branch)) {
            kept++;
            continue;
        }
        const numbers = numberOf(unit);
        const prFromDir = numbers.pr !== null ? statuses.get(numbers.pr) : undefined;
        const pr: CleanupItem['pr'] = prFromDir ? { number: prFromDir.number, state: prFromDir.state } : branch && pulls.get(branch) ? { number: pulls.get(branch)!.number, state: pulls.get(branch)!.state } : null;
        const issueStatus = numbers.issue !== null ? statuses.get(numbers.issue) : undefined;
        const issue = issueStatus?.kind === 'issue' ? { number: issueStatus.number, title: issueStatus.title, state: issueStatus.state === 'OPEN' ? ('OPEN' as const) : ('CLOSED' as const) } : null;
        if (pr?.state === 'OPEN') {
            kept++;
            continue;
        }

        const reasons: string[] = [];
        if (pr?.state === 'MERGED') reasons.push(`PR #${pr.number} mergée`);
        if (issue?.state === 'CLOSED') reasons.push(`issue #${issue.number} fermée`);
        if (pr?.state === 'CLOSED' && (reasons.length > 0 || numbers.pr !== null)) reasons.push(`PR #${pr.number} fermée sans merge`);
        if (branch && (await mergedByGit(branch))) reasons.push(`déjà mergée dans ${base}`);
        if (branch && gone.has(branch)) reasons.push('branche distante supprimée');
        if (worktree && !branch && basename(worktree.path) === '_merge') reasons.push('worktree temporaire de merge');
        if (reasons.length === 0) {
            kept++;
            continue;
        }

        const warnings: string[] = [];
        let risky = false;
        if (worktree) {
            const status = (await git(worktree.path, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean);
            if (status.length > 0) {
                warnings.push(`${status.length} fichier${status.length > 1 ? 's' : ''} modifié${status.length > 1 ? 's' : ''} ou non suivi${status.length > 1 ? 's' : ''} : perdu${status.length > 1 ? 's' : ''}`);
                risky = true;
            }
            const tabs = runsIn(worktree.path, runs);
            if (tabs.length > 0) warnings.push(`onglet${tabs.length > 1 ? 's' : ''} ${tabs.map((t) => `« ${t.title} »`).join(', ')} fermé${tabs.length > 1 ? 's' : ''} et archivé${tabs.length > 1 ? 's' : ''}`);
        }
        if (branch) {
            const unpushed = Number((await git(repo.path, ['rev-list', '--count', `refs/heads/${branch}`, '--not', '--remotes'])).stdout.trim() || 0);
            if (unpushed > 0) {
                warnings.push(`${unpushed} commit${unpushed > 1 ? 's' : ''} jamais poussé${unpushed > 1 ? 's' : ''} : perdu${unpushed > 1 ? 's' : ''}`);
                risky = true;
            }
        }
        items.push({ id: worktree ? `wt:${worktree.path}` : `br:${branch}`, worktree: worktree?.path ?? null, branch, issue, pr, reasons, warnings, safe: !risky });
    }
    return { items, kept, base };
}

const running = new Map<number, JobInfo>();

/**
 * Supprime en tâche de fond (un job, dont la sortie se consulte en direct) les éléments choisis,
 * relus juste avant : un élément qui n'est plus candidat est ignoré. Pour chacun : onglets du
 * worktree fermés et archivés, `git worktree remove` (forcé s'il reste des modifications,
 * l'utilisateur les a vues), puis `git branch -D` (une PR squashée n'est pas « mergée » pour git).
 * Une erreur n'arrête pas les suivants. Les branches distantes ne sont pas touchées.
 */
export function startCleanup(repo: Repo, ids: string[]): JobInfo {
    const current = running.get(repo.id);
    if (current && jobs.get(current.id)?.status === 'running') return jobs.get(current.id) ?? current;
    const job = jobs.task(0, `Nettoyage de ${repo.name ?? repo.path}`, async (log) => {
        log(`$ vérification des ${ids.length} éléments (git fetch --prune, PR et issues sur GitHub)`);
        const fresh = new Map((await listCleanup(repo)).items.map((item) => [item.id, item]));
        let removed = 0;
        const failed: string[] = [];
        for (const id of ids) {
            const item = fresh.get(id);
            const name = id.replace(/^(wt|br):/, '').replace(`${repo.path}/`, '');
            if (!item) {
                log(`\n— ${name} : ignoré, n'est plus à nettoyer`);
                continue;
            }
            log(`\n— ${name}`);
            try {
                if (item.worktree) {
                    for (const run of runsIn(item.worktree, listRuns())) {
                        sessions.close(run.id);
                        archiveRun(run.id);
                        sessions.notifyRun(run.id);
                        log(`  onglet « ${run.title} » fermé et archivé`);
                    }
                    // Modifications vues dans la liste (et cochées quand même) : suppression forcée.
                    const dirty = (await git(item.worktree, ['status', '--porcelain'])).stdout.trim() !== '';
                    const args = ['worktree', 'remove', ...(dirty ? ['--force'] : []), item.worktree];
                    log(`  $ git ${args.join(' ').replace(`${repo.path}/`, '')}`);
                    await gitOk(repo.path, args);
                }
                if (item.branch) {
                    log(`  $ git branch -D ${item.branch}`);
                    const out = await gitOk(repo.path, ['branch', '-D', item.branch]);
                    if (out.trim()) log(`  ${out.trim()}`);
                }
                removed++;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(`  ✗ ${message}`);
                failed.push(name);
            }
        }
        await git(repo.path, ['worktree', 'prune']);
        log(`\nTerminé : ${removed} supprimé${removed > 1 ? 's' : ''}${failed.length ? `, ${failed.length} en échec (${failed.join(', ')})` : ''}.`);
        return failed.length === 0;
    });
    running.set(repo.id, job);
    return job;
}

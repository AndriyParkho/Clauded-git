import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { exec, execOrThrow, type ExecResult } from './exec.js';

export function git(cwd: string, args: string[]): Promise<ExecResult> {
    return exec('git', ['-C', cwd, ...args]);
}

export function gitOk(cwd: string, args: string[]): Promise<string> {
    return execOrThrow('git', ['-C', cwd, ...args]);
}

/** Branche par défaut du remote (`master` ou `main`), via `origin/HEAD` puis par tâtonnement. */
export async function defaultBranch(repoPath: string): Promise<string> {
    const head = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head.code === 0) return head.stdout.trim().replace(/^origin\//, '');
    for (const candidate of ['master', 'main']) {
        if (await remoteBranchExists(repoPath, candidate)) return candidate;
    }
    return 'master';
}

export async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
    return (await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).code === 0;
}

export async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
    return (await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

export interface Worktree {
    path: string;
    head: string;
    branch: string | null;
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
    const output = await gitOk(repoPath, ['worktree', 'list', '--porcelain']);
    const worktrees: Worktree[] = [];
    let current: Partial<Worktree> = {};
    for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) current = { path: line.slice(9), branch: null };
        else if (line.startsWith('HEAD ')) current.head = line.slice(5);
        else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
        else if (line === '' && current.path) {
            worktrees.push({ path: current.path, head: current.head ?? '', branch: current.branch ?? null });
            current = {};
        }
    }
    if (current.path) worktrees.push({ path: current.path, head: current.head ?? '', branch: current.branch ?? null });
    return worktrees;
}

/** Ajoute `/.worktrees/` aux exclusions locales du clone (rien à commiter). */
export async function ensureWorktreesExcluded(repoPath: string): Promise<void> {
    const commonDir = resolve(repoPath, (await gitOk(repoPath, ['rev-parse', '--git-common-dir'])).trim());
    const excludeFile = join(commonDir, 'info', 'exclude');
    const existing = await readFile(excludeFile, 'utf8').catch(() => '');
    if (!existing.split('\n').some((line) => line.trim() === '/.worktrees/')) await appendFile(excludeFile, `${existing.endsWith('\n') || existing === '' ? '' : '\n'}/.worktrees/\n`);
}

/**
 * Crée (ou retrouve) un worktree sur une branche. La branche distante doit exister ; la branche
 * locale est créée en la suivant si besoin.
 */
export async function addWorktree(repoPath: string, branch: string, path: string, onStep?: (step: 'fetch' | 'add') => void): Promise<{ created: boolean }> {
    const existing = (await listWorktrees(repoPath)).find((w) => resolve(w.path) === resolve(path));
    if (existing) {
        if (existing.branch !== branch) throw new Error(`${path} existe déjà sur la branche ${existing.branch ?? '(détachée)'}, pas ${branch}`);
        return { created: false };
    }
    const elsewhere = (await listWorktrees(repoPath)).find((w) => w.branch === branch);
    if (elsewhere) throw new Error(`la branche ${branch} est déjà sortie dans ${elsewhere.path}`);
    onStep?.('fetch');
    await gitOk(repoPath, ['fetch', 'origin', branch]);
    onStep?.('add');
    if (await localBranchExists(repoPath, branch)) await gitOk(repoPath, ['worktree', 'add', path, branch]);
    else await gitOk(repoPath, ['worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]);
    return { created: true };
}

export async function removeWorktree(repoPath: string, path: string, options: { deleteBranch?: string; force?: boolean } = {}): Promise<void> {
    await gitOk(repoPath, ['worktree', 'remove', ...(options.force ? ['--force'] : []), path]);
    if (options.deleteBranch) await git(repoPath, ['branch', '-D', options.deleteBranch]);
}

export interface WorktreeStatus {
    branch: string | null;
    dirty: boolean;
    changedFiles: number;
    ahead: number;
    behind: number;
    hasUpstream: boolean;
    conflicted: string[];
}

export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
    const branch = (await git(path, ['branch', '--show-current'])).stdout.trim() || null;
    const porcelain = (await git(path, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean);
    const conflicted = (await git(path, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    const counts = await git(path, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    const [behind, ahead] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
    return { branch, dirty: porcelain.length > 0, changedFiles: porcelain.length, ahead: ahead ?? 0, behind: behind ?? 0, hasUpstream: counts.code === 0, conflicted };
}

/** Diff de la branche contre sa base distante (ce que verra la PR). */
export async function diffAgainstBase(path: string, base: string): Promise<{ stat: string; patch: string }> {
    const range = `origin/${base}...HEAD`;
    const stat = await git(path, ['diff', '--stat', range]);
    const patch = await git(path, ['diff', range]);
    if (stat.code !== 0) throw new Error(stat.stderr.trim());
    return { stat: stat.stdout, patch: patch.stdout };
}

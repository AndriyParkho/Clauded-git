import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { findRepoByPath, findRepoByRemote, insertRepo } from './db.js';
import { exec } from './exec.js';
import type { Repo, SessionHistoryItem } from '../shared/protocol.js';
import { memo } from './memo.js';

export interface RemoteInfo {
    host: string;
    owner: string;
    name: string;
}

/**
 * Lit `owner/name` et l'hôte d'une URL de remote git, quelle que soit sa forme :
 * `git@github.com:o/n.git`, `git@github.com-perso:o/n.git` (alias SSH), `https://github.com/o/n`,
 * `ssh://git@github.com/o/n.git`.
 */
export function parseRemote(url: string): RemoteInfo | undefined {
    const trimmed = url.trim().replace(/\.git$/, '');
    const scp = trimmed.match(/^[\w.-]+@([\w.-]+):(.+)$/);
    const full = trimmed.match(/^(?:ssh|https?|git):\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/);
    const match = scp ?? full;
    if (!match) return undefined;
    const [, rawHost, path] = match;
    const parts = (path ?? '').split('/').filter(Boolean);
    if (parts.length < 2 || !rawHost) return undefined;
    // Un alias SSH comme `github.com-perso` pointe vers github.com.
    const host = rawHost.startsWith('github.com') ? 'github.com' : rawHost.startsWith('gitlab.com') ? 'gitlab.com' : rawHost;
    return { host, owner: parts[0] as string, name: parts.slice(1).join('/') };
}

export interface RepoInspection {
    path: string;
    remote: string | null;
    info: RemoteInfo | undefined;
    branch: string | null;
}

/** Racine git, remote `origin` et branche courante d'un dossier. */
export async function inspectRepo(path: string): Promise<RepoInspection | undefined> {
    const top = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel']);
    if (top.code !== 0) return undefined;
    const root = top.stdout.trim();
    const remote = await exec('git', ['-C', root, 'remote', 'get-url', 'origin']);
    const branch = await exec('git', ['-C', root, 'branch', '--show-current']);
    const url = remote.code === 0 ? remote.stdout.trim() : null;
    return { path: root, remote: url, info: url ? parseRemote(url) : undefined, branch: branch.code === 0 ? branch.stdout.trim() || null : null };
}

const SKIPPED_DIRS = new Set(['node_modules', '.worktrees', '.git', 'dist', 'build', '.cache', 'Library']);

/** Cherche les dépôts git sous un dossier (profondeur limitée), sans descendre dans un dépôt trouvé. */
export async function scanRepos(root: string, depth = 3): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, level: number): Promise<void> => {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        if (entries.some((e) => e.name === '.git')) {
            found.push(dir);
            return;
        }
        if (level >= depth) return;
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
            await walk(join(dir, entry.name), level + 1);
        }
    };
    await walk(resolve(root), 0);
    return found.sort();
}

export type AddRepoResult = { status: 'added' | 'exists'; repo: Repo } | { status: 'not-a-repo'; path: string };

/** Enregistre un dépôt. Un second clone du même remote n'est pas ajouté. */
export async function addRepo(path: string): Promise<AddRepoResult> {
    const inspection = await inspectRepo(resolve(path));
    if (!inspection) return { status: 'not-a-repo', path };
    const existing = findRepoByPath(inspection.path) ?? (inspection.info ? findRepoByRemote(inspection.info.host, inspection.info.owner, inspection.info.name) : undefined);
    if (existing) return { status: 'exists', repo: existing };
    const repo = insertRepo({
        path: inspection.path,
        remote: inspection.remote,
        host: inspection.info?.host ?? null,
        owner: inspection.info?.owner ?? null,
        name: inspection.info?.name ?? basename(inspection.path),
    });
    return { status: 'added', repo };
}

export async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

/** Sessions Claude Code d'un dépôt (checkout principal et worktrees), les plus récentes d'abord. */
export function repoSessions(repo: Repo, limit = 50): Promise<SessionHistoryItem[]> {
    // Lit les transcripts sur le disque (worktrees compris) : gardé 15 s, appels simultanés partagés.
    return memo(`sessions:${repo.id}:${limit}`, 15_000, () => readRepoSessions(repo, limit));
}

async function readRepoSessions(repo: Repo, limit: number): Promise<SessionHistoryItem[]> {
    const sessions = await listSessions({ dir: repo.path, includeWorktrees: true, limit });
    return sessions.map((s) => ({
        sessionId: s.sessionId,
        summary: s.summary,
        ...(s.firstPrompt !== undefined ? { firstPrompt: s.firstPrompt } : {}),
        ...(s.customTitle !== undefined ? { customTitle: s.customTitle } : {}),
        ...(s.gitBranch !== undefined ? { gitBranch: s.gitBranch } : {}),
        ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
        lastModified: s.lastModified,
    }));
}

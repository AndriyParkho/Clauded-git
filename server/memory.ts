import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getRepo, getRun } from './db.js';
import { exec } from './exec.js';
import { sessions } from './sessions/manager.js';
import type { MemoryFile, MemoryInfo } from '../shared/protocol.js';

/**
 * Fenêtre `/memory` : `/memory` est un menu interactif du terminal, sans équivalent dans le SDK.
 * L'app liste à la place les fichiers de mémoire de l'onglet : ceux que la session a chargés, plus
 * les emplacements habituels (même vides) pour pouvoir les créer ou les ouvrir.
 */

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

/** Dossier de projet de Claude Code pour un chemin : `/a/b_c.d` → `-a-b-c-d`. */
const projectSlug = (path: string): string => resolve(path).replace(/[^a-zA-Z0-9]/g, '-');

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

function scopeOf(path: string, autoDirs: string[]): MemoryFile['scope'] {
    if (autoDirs.some((dir) => path.startsWith(dir))) return 'auto';
    return path.startsWith(CLAUDE_HOME) ? 'user' : 'project';
}

export async function memoryInfo(runId: number): Promise<MemoryInfo> {
    const run = getRun(runId);
    if (!run) throw new Error('onglet introuvable');
    const repo = run.repoId !== null ? getRepo(run.repoId) : undefined;
    // Un worktree a son propre dossier de projet ; celui du dépôt principal est listé aussi.
    const roots = [...new Set([run.cwd, ...(repo ? [repo.path] : [])])];
    const autoDirs = roots.map((root) => join(CLAUDE_HOME, 'projects', projectSlug(root), 'memory'));

    const candidates = [join(CLAUDE_HOME, 'CLAUDE.md'), ...roots.flatMap((root) => [join(root, 'CLAUDE.md'), join(root, '.claude', 'CLAUDE.md'), join(root, 'CLAUDE.local.md')])];
    for (const dir of autoDirs) {
        const entries = await readdir(dir).catch(() => [] as string[]);
        candidates.push(join(dir, 'MEMORY.md'), ...entries.filter((e) => e.endsWith('.md') && e !== 'MEMORY.md').map((e) => join(dir, e)));
    }

    const loaded = new Map((await sessions.loadedMemoryFiles(runId)).map((f) => [resolve(f.path), f.tokens]));
    const paths = [...new Set([...loaded.keys(), ...candidates.map((p) => resolve(p))])];
    const files = await Promise.all(
        paths.map(async (path): Promise<MemoryFile> => {
            const tokens = loaded.get(path);
            return { path, scope: scopeOf(path, autoDirs), exists: tokens !== undefined || (await exists(path)), ...(tokens !== undefined ? { tokens } : {}) };
        }),
    );
    // Emplacements absents : seulement ceux du dossier de l'onglet (pour les créer), pas ceux du dépôt principal.
    const primary = new Set([join(CLAUDE_HOME, 'CLAUDE.md'), join(roots[0] ?? '', 'CLAUDE.md'), join(roots[0] ?? '', 'CLAUDE.local.md'), join(autoDirs[0] ?? '', 'MEMORY.md')].map((p) => resolve(p)));
    const shown = files.filter((f) => f.exists || primary.has(f.path));
    return { runId, files: shown, autoDir: autoDirs[0] ?? '' };
}

/** Ouvre un fichier de la liste dans VS Code (créé vide s'il n'existe pas) ; rien d'autre n'est ouvrable. */
export async function openMemoryFile(runId: number, path: string): Promise<void> {
    const target = resolve(path);
    const { files } = await memoryInfo(runId);
    if (!files.some((f) => f.path === target)) throw new Error(`fichier hors de la mémoire de l'onglet : ${path}`);
    if (!(await exists(target))) {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, '', { flag: 'wx' }).catch(() => undefined);
    }
    const result = await exec('code', [target]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'code a échoué');
}

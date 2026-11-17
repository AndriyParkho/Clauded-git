import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { exec } from './exec.js';
import { listWorktrees } from './git.js';
import { loadProfile } from './profiles.js';
import type { BrunoState, Repo } from '../shared/protocol.js';

// La commande du profil (`bru-use {path}`) est une fonction du `.zshrc` : elle tourne dans un zsh
// interactif, le chemin passé en argument (`{path}` devient `"$1"`, sans souci de guillemets).
const TIMEOUT_MS = 30_000;

function zsh(script: string, args: string[] = []): ReturnType<typeof exec> {
    return exec('zsh', ['-i', '-c', script, 'zsh', ...args], { timeoutMs: TIMEOUT_MS });
}

/** Dernier dossier choisi par dépôt, quand on ne peut pas relire `$BRU_DIR`. */
const lastSwitched = new Map<number, string>();
let bruDir: Promise<string | null> | undefined;

/** `$BRU_DIR` du `.zshrc` (dossier de collection que Bruno ouvre), lu une fois. */
function brunoDir(): Promise<string | null> {
    bruDir ??= zsh('print -r -- "${BRU_DIR:-}"').then((r) => r.stdout.trim().split('\n').at(-1)?.trim() || null);
    return bruDir;
}

const real = (path: string): Promise<string> => realpath(path).catch(() => path);

/**
 * Le dépôt ou worktree sur lequel Bruno pointe : `$BRU_DIR/bruno.json` est un lien vers la
 * collection d'un checkout ; c'est le plus profond des checkouts du dépôt qui la contient.
 */
async function activeCheckout(repo: Repo): Promise<string | null> {
    const dir = await brunoDir();
    if (!dir) return lastSwitched.get(repo.id) ?? null;
    const collection = await realpath(join(dir, 'bruno.json')).catch(() => null);
    if (!collection) return lastSwitched.get(repo.id) ?? null;
    const checkouts = [repo.path, ...(await listWorktrees(repo.path).catch(() => [])).map((w) => w.path)];
    let best: { path: string; length: number } | null = null;
    for (const path of new Set(checkouts)) {
        const root = await real(path);
        if (collection.startsWith(root + sep) && root.length > (best?.length ?? 0)) best = { path, length: root.length };
    }
    return best?.path ?? null;
}

export async function brunoState(repo: Repo): Promise<BrunoState> {
    const { bruno } = await loadProfile(repo);
    return { command: bruno, active: bruno ? await activeCheckout(repo) : null };
}

/** Fait pointer Bruno sur un checkout du dépôt (principal ou worktree) avec la commande du profil. */
export async function switchBruno(repo: Repo, path: string): Promise<BrunoState & { output: string }> {
    const { bruno } = await loadProfile(repo);
    if (!bruno) throw new Error('pas de commande Bruno dans le profil du dépôt (champ « bruno »)');
    const checkouts = [repo.path, ...(await listWorktrees(repo.path)).map((w) => w.path)];
    const wanted = await real(path);
    let checkout: string | undefined;
    for (const candidate of checkouts) if ((await real(candidate)) === wanted) checkout = candidate;
    if (!checkout) throw new Error(`${path} n'est ni le dépôt ni un de ses worktrees`);
    path = checkout;
    const result = await zsh(bruno.replaceAll('{path}', '"$1"'), [path]);
    // Un zsh interactif sans terminal peut bavarder sur stderr : seule la sortie de la commande compte.
    const output = result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
    if (result.code !== 0) throw new Error(output || result.stderr.trim() || `${bruno} a échoué (code ${result.code})`);
    lastSwitched.set(repo.id, path);
    return { command: bruno, active: (await activeCheckout(repo)) ?? path, output };
}

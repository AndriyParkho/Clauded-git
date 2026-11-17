import { listRepos } from './db.js';
import { exec } from './exec.js';
import { listWorktrees } from './git.js';
import type { OpenApp } from '../shared/protocol.js';

const COMMANDS: Record<OpenApp, (path: string) => [file: string, args: string[]]> = {
    vscode: (path) => ['code', [path]],
    finder: (path) => ['open', [path]],
    terminal: (path) => ['open', ['-a', 'Terminal', path]],
    iterm: (path) => ['open', ['-a', 'iTerm', path]],
};

/** Un chemin est ouvrable s'il est un dépôt connu ou l'un de ses worktrees (rien d'autre). */
async function isKnownPath(path: string): Promise<boolean> {
    for (const repo of listRepos()) {
        if (repo.path === path) return true;
        const worktrees = await listWorktrees(repo.path).catch(() => []);
        if (worktrees.some((w) => w.path === path)) return true;
    }
    return false;
}

/** Ouvre un dossier dans VS Code, le Finder, Terminal ou iTerm. */
export async function openIn(path: string, app: OpenApp): Promise<void> {
    if (!(await isKnownPath(path))) throw new Error(`dossier inconnu de l'app : ${path}`);
    const [file, args] = (COMMANDS[app] ?? COMMANDS.vscode)(path);
    const result = await exec(file, args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${file} a échoué`);
}

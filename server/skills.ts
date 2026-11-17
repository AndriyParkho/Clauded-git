import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SkillInfo } from '../shared/protocol.js';

const CLAUDE_DIR = join(homedir(), '.claude');

/** `description:` du frontmatter d'un SKILL.md ou d'une commande (première ligne). */
function description(text: string): string {
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    const line = /^description:\s*(.*)$/m.exec(front)?.[1] ?? '';
    return line.replace(/^["']|["']$/g, '').trim();
}

async function readText(path: string): Promise<string | null> {
    return readFile(path, 'utf8').catch(() => null);
}

async function dirs(path: string): Promise<string[]> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
}

/** Skills (`skills/<nom>/SKILL.md`) et commandes (`commands/<nom>.md`) d'un dossier `.claude` ou d'un plugin. */
async function scan(root: string, source: SkillInfo['source'], prefix = ''): Promise<SkillInfo[]> {
    const found: SkillInfo[] = [];
    for (const name of await dirs(join(root, 'skills'))) {
        const text = await readText(join(root, 'skills', name, 'SKILL.md'));
        if (text !== null) found.push({ name: `${prefix}${name}`, description: description(text), source });
    }
    const commands = await readdir(join(root, 'commands')).catch(() => [] as string[]);
    for (const file of commands.filter((f) => f.endsWith('.md'))) {
        const text = await readText(join(root, 'commands', file));
        if (text !== null) found.push({ name: `${prefix}${basename(file, '.md')}`, description: description(text), source });
    }
    return found;
}

/** Plugins installés et non désactivés dans `~/.claude/settings.json`, avec leur dossier. */
async function plugins(): Promise<Array<{ name: string; path: string }>> {
    const installed = JSON.parse((await readText(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'))) ?? '{}') as { plugins?: Record<string, Array<{ installPath?: string }>> };
    const settings = JSON.parse((await readText(join(CLAUDE_DIR, 'settings.json'))) ?? '{}') as { enabledPlugins?: Record<string, boolean> };
    return Object.entries(installed.plugins ?? {})
        .filter(([key]) => settings.enabledPlugins?.[key] !== false)
        .flatMap(([key, entries]) => {
            const path = entries[0]?.installPath;
            return path ? [{ name: key.split('@')[0] ?? key, path }] : [];
        });
}

/**
 * Skills et commandes qu'une session Claude Code lancée dans le dépôt pourra appeler : ceux du
 * dépôt, de l'utilisateur et des plugins. Lu sur le disque, sans ouvrir de session.
 */
export async function listSkills(repoPath: string): Promise<SkillInfo[]> {
    const lists = await Promise.all([
        scan(join(repoPath, '.claude'), 'project'),
        scan(CLAUDE_DIR, 'user'),
        plugins()
            .then((list) => Promise.all(list.map((p) => scan(p.path, 'plugin', `${p.name}:`))))
            .then((all) => all.flat())
            .catch(() => []),
    ]);
    const seen = new Set<string>();
    return lists.flat().filter((s) => !seen.has(s.name) && seen.add(s.name));
}

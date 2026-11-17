import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { git } from './git.js';

/**
 * Projets d'un dépôt : les dossiers où lancer lint, tests et typecheck. Dans un monorepo, ce sont
 * les workspaces déclarés (`package.json` → `workspaces`, `pnpm-workspace.yaml`) ; sinon, les
 * dossiers qui ont leur propre manifeste. La racine (`.`) est toujours proposée.
 */
export interface ProjectsInfo {
    projects: string[];
    /** Projets touchés par la branche (diff contre la base + modifications locales), du plus touché au moins touché. */
    touched: Array<{ path: string; files: number }>;
    /** Le projet proposé par défaut : le plus touché, sinon la racine. */
    suggested: string;
}

const MANIFESTS = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml'];

/** Motif de workspace (`packages/**`, `apps/*`) → expression régulière sur un chemin de dossier. */
function globToRegExp(pattern: string): RegExp {
    const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
    let source = '';
    for (let i = 0; i < clean.length; i++) {
        const c = clean[i]!;
        if (c === '*' && clean[i + 1] === '*') {
            // `x/**` : x et tout ce qu'il y a dessous.
            source += '.*';
            i++;
            if (clean[i + 1] === '/') i++;
        } else if (c === '*') source += '[^/]*';
        else if (c === '?') source += '[^/]';
        else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source.replace(/\/\.\*$/, '(/.*)?')}$`);
}

async function workspacePatterns(root: string): Promise<{ include: RegExp[]; exclude: RegExp[] } | null> {
    const patterns: string[] = [];
    try {
        const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] | { packages?: string[] } };
        const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
        patterns.push(...ws);
    } catch {
        // pas de package.json à la racine
    }
    try {
        const yaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
        for (const match of yaml.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)) patterns.push(match[1]!);
    } catch {
        // pas de pnpm-workspace.yaml
    }
    if (patterns.length === 0) return null;
    return {
        include: patterns.filter((p) => !p.startsWith('!')).map(globToRegExp),
        exclude: patterns.filter((p) => p.startsWith('!')).map((p) => globToRegExp(p.slice(1))),
    };
}

/** Tous les dossiers de projet du worktree (chemins relatifs, `.` en tête). */
export async function listProjects(root: string): Promise<string[]> {
    // Les manifestes suivis par git : rapide, et sans node_modules ni fichiers générés.
    const listed = await git(root, ['ls-files', '--', ...MANIFESTS.flatMap((m) => [m, `**/${m}`])]);
    const dirs = new Set(
        listed.stdout
            .split('\n')
            .filter(Boolean)
            .map((file) => dirname(file))
            .filter((dir) => dir !== '.'),
    );
    const workspaces = await workspacePatterns(root);
    const projects = [...dirs].filter((dir) => !workspaces || (workspaces.include.some((re) => re.test(dir)) && !workspaces.exclude.some((re) => re.test(dir))));
    return ['.', ...projects.sort((a, b) => a.localeCompare(b))];
}

/** Le projet qui contient ce fichier : le plus long préfixe parmi les projets (hors racine). */
function projectOf(file: string, projects: string[]): string {
    let best = '.';
    for (const project of projects) {
        if (project !== '.' && (file === project || file.startsWith(`${project}/`)) && project.length > best.length) best = project;
    }
    return best;
}

/** Projets du worktree, ceux que la branche touche, et celui à proposer par défaut. */
export async function projectsInfo(root: string, base: string): Promise<ProjectsInfo> {
    const projects = await listProjects(root);
    const committed = await git(root, ['diff', '--name-only', `origin/${base}...HEAD`]);
    const local = await git(root, ['status', '--porcelain']);
    const files = new Set([
        ...committed.stdout.split('\n').filter(Boolean),
        // `XY chemin` ou `XY ancien -> nouveau`
        ...local.stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '')),
    ]);
    const counts = new Map<string, number>();
    for (const file of files) {
        const project = projectOf(file, projects);
        counts.set(project, (counts.get(project) ?? 0) + 1);
    }
    const touched = [...counts.entries()].map(([path, n]) => ({ path, files: n })).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
    // La racine ne gagne que si rien d'autre n'est touché (un fichier de config racine ne doit pas l'emporter).
    const suggested = touched.find((t) => t.path !== '.')?.path ?? '.';
    return { projects, touched, suggested };
}

/** Le dossier absolu d'un projet du worktree ; refuse ce qui sort du worktree ou n'existe pas. */
export async function projectDir(root: string, project: string | undefined): Promise<string> {
    if (!project || project === '.') return root;
    const clean = normalize(project);
    if (isAbsolute(clean) || clean === '..' || clean.startsWith(`..${sep}`)) throw new Error(`projet invalide : ${project}`);
    const path = join(root, clean);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`le dossier ${project} n'existe pas dans ${root}`);
    return path;
}

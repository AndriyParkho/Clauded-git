import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { defaultBranch, remoteBranchExists } from './git.js';
import type { Repo } from '../shared/protocol.js';

/**
 * Profil d'un dépôt : ce que l'app doit savoir pour y travailler. Fichier JSON éditable dans
 * `~/.clauded-git/profiles/<owner>__<name>.json`, créé avec des valeurs devinées au premier usage.
 */
export interface Profile {
    /** Branche de départ des issues et cible des PR (`master`, `main`). */
    baseBranch: string;
    /** Branche d'intégration où l'on merge pour tester (`develop`), ou null. */
    integrationBranch: string | null;
    /** Nom de branche d'une issue : `{n}` numéro, `{slug}` titre simplifié. */
    branchFormat: string;
    /** Dossier des worktrees, relatif au dépôt. */
    worktreesDir: string;
    /** Commande d'installation lancée en tâche de fond dans un nouveau worktree. */
    install: string | null;
    /** Fichiers ignorés par git à copier du checkout principal vers le worktree (`.env.local`…). */
    copyFiles: string[];
    /** Commandes des boutons de l'onglet d'implémentation, par libellé. */
    commands: Record<string, string>;
    /** Skill de review des PR (`core-pr-review`), ou null. */
    reviewSkill: string | null;
    /**
     * Skill que la session d'implémentation lance sur sa propre PR avant de rendre la main
     * (`code-review:code-review`), ou null pour s'en passer.
     */
    selfReviewSkill: string | null;
    /** Consignes ajoutées au prompt d'implémentation. */
    instructions: string;
    /**
     * Commande zsh (fonctions du `.zshrc` comprises) qui fait pointer Bruno sur un checkout :
     * `{path}` = le dépôt ou le worktree choisi. Null : pas de bouton Bruno.
     */
    bruno: string | null;
}

const PROFILES_DIR = join(DATA_DIR, 'profiles');

export function profilePath(repo: Repo): string {
    const name = `${repo.owner ?? 'local'}__${(repo.name ?? 'repo').replace(/[^\w.-]/g, '_')}.json`;
    return join(PROFILES_DIR, name);
}

async function exists(path: string): Promise<boolean> {
    try {
        await readFile(path);
        return true;
    } catch {
        return false;
    }
}

/** Valeurs devinées depuis le dépôt : branches, gestionnaire de paquets, scripts disponibles. */
async function guessProfile(repo: Repo): Promise<Profile> {
    const base = await defaultBranch(repo.path);
    const integration = (await remoteBranchExists(repo.path, 'develop')) ? 'develop' : null;

    let packageManager: 'yarn' | 'pnpm' | 'npm' | null = null;
    if (await exists(join(repo.path, 'yarn.lock'))) packageManager = 'yarn';
    else if (await exists(join(repo.path, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (await exists(join(repo.path, 'package-lock.json'))) packageManager = 'npm';

    const commands: Record<string, string> = {};
    let install: string | null = null;
    if (packageManager) {
        install = { yarn: 'yarn install', pnpm: 'pnpm install --frozen-lockfile', npm: 'npm ci' }[packageManager];
        const run = packageManager === 'npm' ? 'npm run' : packageManager;
        try {
            const pkg = JSON.parse(await readFile(join(repo.path, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
            const scripts = pkg.scripts ?? {};
            if (scripts.test) commands.Tests = `${run} test`;
            if (scripts.lint) commands.Lint = `${run} lint`;
            if (scripts.tsc) commands.Typecheck = `${run} tsc`;
            else if (scripts.typecheck) commands.Typecheck = `${run} typecheck`;
        } catch {
            // pas de package.json lisible
        }
    }

    return {
        baseBranch: base,
        integrationBranch: integration,
        branchFormat: 'feature/{n}-{slug}',
        worktreesDir: '.worktrees',
        install,
        copyFiles: [],
        commands,
        reviewSkill: null,
        selfReviewSkill: 'code-review:code-review',
        instructions: '',
        // Une collection Bruno dans le dépôt : la fonction `bru-use` du .zshrc la bascule.
        bruno: (await stat(join(repo.path, 'bruno')).then((s) => s.isDirectory()).catch(() => false)) ? 'bru-use {path}' : null,
    };
}

export async function loadProfile(repo: Repo): Promise<Profile> {
    const path = profilePath(repo);
    try {
        const stored = JSON.parse(await readFile(path, 'utf8')) as Partial<Profile>;
        return { ...(await guessProfile(repo)), ...stored };
    } catch {
        const profile = await guessProfile(repo);
        await saveProfile(repo, profile);
        return profile;
    }
}

export async function saveProfile(repo: Repo, profile: Profile): Promise<void> {
    await mkdir(PROFILES_DIR, { recursive: true });
    await writeFile(profilePath(repo), `${JSON.stringify(profile, null, 4)}\n`);
}

/** `feature/{n}-{slug}` → `feature/123-remise-paywall`. */
export function branchName(profile: Profile, issueNumber: number, title: string): string {
    const slug = title
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
        .replace(/-+$/, '');
    return profile.branchFormat.replace('{n}', String(issueNumber)).replace('{slug}', slug || 'issue');
}

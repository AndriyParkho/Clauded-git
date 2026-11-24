import { query } from '@anthropic-ai/claude-agent-sdk';
import { git, worktreeStatus } from './git.js';
import { jobs } from './jobs.js';
import { loadProfile } from './profiles.js';
import { sessions } from './sessions/manager.js';
import type { JobInfo, Repo, Run } from '../shared/protocol.js';

/** Au-delà, le diff donné au modèle est coupé (le `--stat` reste complet). */
const DIFF_LIMIT = 24_000;
const MESSAGE_TIMEOUT_MS = 60_000;

function strip(text: string): string {
    return text
        .trim()
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```$/, '')
        .trim();
}

/**
 * Message de commit écrit par un petit modèle (Haiku par défaut), sans outils ni réglages : il ne
 * voit que le diff indexé et les derniers messages du dépôt, dont il reprend la langue et le style.
 */
async function commitMessage(cwd: string, model: string, issueNumber: number | null): Promise<string> {
    const [stat, diff, recent] = await Promise.all([git(cwd, ['diff', '--cached', '--stat']), git(cwd, ['diff', '--cached']), git(cwd, ['log', '-8', '--format=%s'])]);
    const patch = diff.stdout.length > DIFF_LIMIT ? `${diff.stdout.slice(0, DIFF_LIMIT)}\n… (diff coupé)` : diff.stdout;
    const prompt = [
        'Écris le message de commit de ces changements.',
        '- Conventional Commits (`feat: …`, `fix: …`, `refactor: …`, `chore: …`), titre de 72 caractères au plus, à l\'impératif.',
        '- Même langue et même style que les derniers commits du dépôt ci-dessous.',
        '- Un corps court (quelques puces) seulement si le titre ne suffit pas.',
        ...(issueNumber !== null ? [`- Termine le corps par la ligne \`Refs #${issueNumber}\`.`] : []),
        '- Réponds uniquement par le message, sans bloc de code ni commentaire.',
        '',
        'Derniers commits :',
        recent.stdout.trim() || '(aucun)',
        '',
        'Fichiers :',
        stat.stdout.trim(),
        '',
        'Diff :',
        patch,
    ].join('\n');

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MESSAGE_TIMEOUT_MS);
    try {
        const q = query({
            prompt,
            options: {
                cwd,
                model,
                tools: [],
                settingSources: [],
                mcpServers: {},
                strictMcpConfig: true,
                maxTurns: 1,
                abortController: abort,
                systemPrompt: 'Tu écris des messages de commit git clairs et concis.',
                env: { ...process.env, CLAUDECODE: undefined },
            },
        });
        for await (const message of q) {
            if (message.type !== 'result') continue;
            if (message.subtype !== 'success') throw new Error(`génération interrompue (${message.subtype})`);
            const text = strip(message.result);
            if (!text) throw new Error('message vide');
            return text;
        }
        throw new Error('pas de réponse');
    } finally {
        clearTimeout(timer);
    }
}

/**
 * « Commit & push » : indexe tout ce qui est modifié dans le dossier de l'onglet, commit avec un
 * message écrit par un petit modèle, puis pousse la branche (avec `-u` la première fois). Pour les
 * fois où la session a oublié, sans relancer un tour du modèle principal. Refuse la branche de base
 * et celle d'intégration, sauf `allowProtected`.
 */
export async function commitAndPush(repo: Repo, run: Run, options: { allowProtected?: boolean } = {}): Promise<JobInfo> {
    if (run.state === 'running') throw new Error('Claude travaille encore dans cet onglet : attends la fin du tour.');
    const [status, profile] = await Promise.all([worktreeStatus(run.cwd), loadProfile(repo)]);
    const branch = status.branch;
    if (!branch) throw new Error('HEAD détaché : pas de branche à pousser.');
    if (status.conflicted.length > 0) throw new Error(`merge en cours avec des conflits : ${status.conflicted.join(', ')}`);
    if (!options.allowProtected && (branch === profile.baseBranch || branch === profile.integrationBranch)) {
        throw new Error(`protected:${branch}`);
    }
    if (!status.dirty && status.hasUpstream && status.ahead === 0) throw new Error('Rien à commiter ni à pousser.');

    return jobs.task(run.id, 'Commit & push', async (log) => {
        const step = async (args: string[]): Promise<boolean> => {
            log(`$ git ${args.join(' ')}`);
            const result = await git(run.cwd, args);
            const output = `${result.stdout}${result.stderr}`.trim();
            if (output) log(output);
            return result.code === 0;
        };

        if (status.dirty) {
            if (!(await step(['add', '-A']))) return false;
            log(`Message de commit écrit par ${profile.commitModel}…`);
            let message: string;
            try {
                message = await commitMessage(run.cwd, profile.commitModel, run.issueNumber);
            } catch (error) {
                message = `chore: mise à jour de ${branch}${run.issueNumber !== null ? `\n\nRefs #${run.issueNumber}` : ''}`;
                log(`(génération impossible : ${error instanceof Error ? error.message : String(error)} ; message par défaut)`);
            }
            log(`\n${message}\n`);
            // Les hooks du dépôt (lint-staged…) tournent comme d'habitude : un échec arrête tout.
            if (!(await step(['commit', '-m', message]))) return false;
        }
        const pushed = status.hasUpstream ? await step(['push']) : await step(['push', '-u', 'origin', branch]);
        if (pushed) sessions.notifyRun(run.id);
        return pushed;
    });
}

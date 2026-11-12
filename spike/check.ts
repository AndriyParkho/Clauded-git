/**
 * Spike headless : vérifie, dans un repo donné, ce dont Clauded GIT a besoin du Claude Agent SDK.
 *
 *   npm run spike:check -- ~/Documents/github/wmx-core/monorepo
 *
 * Vérifications : authentification avec le compte Claude Code, chargement de CLAUDE.md et des skills
 * du repo et du compte, permissions acceptées par l'app, ce que donnent `docker ps` et
 * `gh api --method POST` depuis l'agent, reprise de session, lecture de l'historique des sessions.
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getSessionMessages, listSessions, query, type SDKMessage, type SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { sessionOptions, summarizeInput } from './common.js';

type Status = 'ok' | 'ko' | 'warn';
const report: Array<{ name: string; status: Status; detail: string }> = [];
const ICONS: Record<Status, string> = { ok: '✅', ko: '❌', warn: '⚠️ ' };

function check(name: string, status: Status, detail = ''): void {
    report.push({ name, status, detail });
    console.log(`${ICONS[status]} ${name}${detail ? ` — ${detail}` : ''}`);
}

const cwd = resolve(process.argv[2] ?? process.cwd());
const outDir = new URL('./out/', import.meta.url);
await mkdir(outDir, { recursive: true });
const transcript = new URL(`./out/check-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`, import.meta.url);

async function record(message: SDKMessage): Promise<void> {
    await appendFile(transcript, `${JSON.stringify(message)}\n`);
}

/** Skills invocables d'un dossier `.claude/skills` : un SKILL.md, sans `user-invocable: false`. */
async function listSkillDirs(dir: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        const names: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const skill = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined);
            if (skill === undefined || /^user-invocable:\s*false/m.test(skill)) continue;
            names.push(entry.name);
        }
        return names;
    } catch {
        return [];
    }
}

function textOf(message: SDKMessage): string {
    if (message.type !== 'assistant') return '';
    return message.message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
}

function parseJson(text: string): Record<string, unknown> | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

console.log(`Repo : ${cwd}`);
console.log(`Transcript : ${transcript.pathname}\n`);

const abortController = new AbortController();
const timer = setTimeout(() => abortController.abort(), 10 * 60_000);

// ---------------------------------------------------------------------------------------------
// Tour 1 : nouvelle session, init, compte, skills, outils, sandbox
// ---------------------------------------------------------------------------------------------

const PROMPT_1 = [
    'Tu participes à un test technique. Fais exactement les étapes suivantes, sans rien d\'autre :',
    '1. Si un CLAUDE.md est chargé dans ton contexte, note le titre ou la première ligne de ce fichier ; sinon null.',
    '2. Lance avec Bash : `docker ps` et note la première ligne de sortie ou d\'erreur.',
    '3. Lance avec Bash : `gh api --method POST /markdown -f text=ok` et note la sortie ou l\'erreur.',
    '4. Liste les noms des skills dont tu disposes.',
    'Réponds uniquement avec un objet JSON de la forme',
    '{"claudeMd": string | null, "docker": string, "ghPost": string, "skills": string[]}',
].join('\n');

const permissions: string[] = [];
let init: SDKSystemMessage | undefined;
let sessionId: string | undefined;
let answer = '';

const q1 = query({
    prompt: PROMPT_1,
    options: sessionOptions({
        cwd,
        maxTurns: 8,
        abortController,
        onPermission: (tool, input) => permissions.push(`${tool} ${summarizeInput(input)}`),
    }),
});

try {
    for await (const message of q1) {
        await record(message);
        if (message.type === 'system' && message.subtype === 'init') {
            init = message;
            sessionId = message.session_id;
            console.log(`Session ${sessionId} · Claude Code ${message.claude_code_version} · modèle ${message.model} · mode ${message.permissionMode}`);

            try {
                const account = await q1.accountInfo();
                const who = [account.email, account.organization, account.subscriptionType, account.tokenSource ?? account.apiKeySource, account.apiProvider]
                    .filter(Boolean)
                    .join(' · ');
                check('auth : compte Claude Code', account.email || account.subscriptionType ? 'ok' : 'warn', who || 'aucune info de compte');
            } catch (error) {
                check('auth : compte Claude Code', 'ko', String(error));
            }

            const repoSkills = await listSkillDirs(join(cwd, '.claude', 'skills'));
            const userSkills = await listSkillDirs(join(homedir(), '.claude', 'skills'));
            const loaded = new Set(message.skills);
            const missing = [...repoSkills, ...userSkills].filter((s) => !loaded.has(s));
            check(
                'skills du repo et du compte chargés',
                missing.length === 0 ? 'ok' : 'warn',
                `${message.skills.length} skills vus par le SDK, ${repoSkills.length} dans le repo, ${userSkills.length} chez toi${missing.length ? ` ; absents : ${missing.join(', ')}` : ''}`,
            );
            check('commandes slash', message.slash_commands.length > 0 ? 'ok' : 'ko', `${message.slash_commands.length} commandes, ex. ${message.slash_commands.slice(0, 8).join(', ')}`);
            check('plugins', 'ok', message.plugins.map((p) => p.name).join(', ') || 'aucun');
            check('serveurs MCP', 'ok', message.mcp_servers.map((s) => `${s.name}:${s.status}`).join(', ') || 'aucun');
        }
        if (message.type === 'assistant') answer += textOf(message);
        if (message.type === 'result') {
            if (message.subtype === 'success') {
                check('tour 1 terminé', 'ok', `${message.num_turns} tours · ${(message.duration_ms / 1000).toFixed(0)} s · ${message.total_cost_usd.toFixed(3)} $`);
            } else {
                check('tour 1 terminé', 'ko', `${message.subtype} : ${message.errors.join(' | ')}`);
            }
        }
    }
} catch (error) {
    check('tour 1', 'ko', String(error));
}

if (!init) {
    check('init', 'ko', 'aucun message init : le SDK n\'a pas démarré (voir le transcript)');
}

check('permissions : callback de l\'app appelé', permissions.length > 0 ? 'ok' : 'warn', permissions.length ? permissions.join(' ; ') : 'jamais appelé (tout était déjà auto-accepté par les réglages ?)');

const parsed = parseJson(answer);
if (parsed) {
    check('CLAUDE.md dans le contexte', parsed.claudeMd ? 'ok' : 'warn', String(parsed.claudeMd ?? 'non vu par Claude'));
    const docker = String(parsed.docker ?? '');
    check('docker depuis l\'agent', /permission denied|cannot connect|operation not permitted|refus/i.test(docker) ? 'warn' : 'ok', docker);
    const ghPost = String(parsed.ghPost ?? '');
    const ghDenied = /refus|hook error|denied|not permitted/i.test(ghPost);
    check('gh api POST depuis l\'agent', !ghDenied && /<p>|ok/i.test(ghPost) ? 'ok' : 'warn', ghPost);
    check('skills vus par Claude', 'ok', Array.isArray(parsed.skills) ? parsed.skills.join(', ') : '?');
} else {
    check('réponse JSON du tour 1', 'warn', `réponse non parsée : ${answer.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------------------------
// Tour 2 : reprise de la session
// ---------------------------------------------------------------------------------------------

if (sessionId) {
    let resumed = '';
    try {
        const q2 = query({
            prompt: 'Sans rien relancer, rappelle en une phrase ce que je t\'ai demandé au tour précédent.',
            options: sessionOptions({ cwd, resume: sessionId, maxTurns: 1, abortController }),
        });
        for await (const message of q2) {
            await record(message);
            if (message.type === 'assistant') resumed += textOf(message);
            if (message.type === 'result' && message.subtype !== 'success') check('reprise : tour 2', 'ko', message.errors.join(' | '));
        }
        check('reprise de session (--resume)', /docker|markdown|json|skill/i.test(resumed) ? 'ok' : 'warn', resumed.slice(0, 200));
    } catch (error) {
        check('reprise de session (--resume)', 'ko', String(error));
    }
}

// ---------------------------------------------------------------------------------------------
// Historique : sessions existantes du repo
// ---------------------------------------------------------------------------------------------

try {
    const sessions = await listSessions({ dir: cwd, limit: 10 });
    const mine = sessions.find((s) => s.sessionId === sessionId);
    check(
        'historique : listSessions',
        sessions.length > 0 ? 'ok' : 'warn',
        `${sessions.length} sessions ; la nôtre ${mine ? 'est listée' : 'n\'est pas listée'} ; dernières : ${sessions
            .slice(0, 3)
            .map((s) => `[${s.gitBranch ?? '?'}] ${(s.customTitle ?? s.summary ?? s.firstPrompt ?? '').slice(0, 50)}`)
            .join(' | ')}`,
    );
    const other = sessions.find((s) => s.sessionId !== sessionId);
    if (other) {
        const messages = await getSessionMessages(other.sessionId, { dir: cwd, limit: 5 });
        check('historique : getSessionMessages', messages.length > 0 ? 'ok' : 'warn', `${messages.length} messages lus dans ${other.sessionId}`);
    }
} catch (error) {
    check('historique', 'ko', String(error));
}

clearTimeout(timer);

console.log('\nRésumé :');
for (const { name, status, detail } of report) console.log(`  ${ICONS[status]} ${name}${status !== 'ok' && detail ? ` — ${detail}` : ''}`);
if (sessionId) console.log(`\nPour reprendre cette session dans le terminal : cd ${cwd} && claude --resume ${sessionId}`);

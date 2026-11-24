import { join, resolve, sep } from 'node:path';
import type { EffortLevel, HookCallbackMatcher, HookEvent, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { artifactsDir } from '../artifacts.js';
import type { InvestigationEnv, Run } from '../../shared/protocol.js';

/**
 * Comportement d'un chat selon son intention (voir `RunIntent`) : consigne ajoutée au prompt
 * système, garde-fous (lecture seule, serveurs MCP de l'environnement), effort par défaut.
 */

/** Rapport d'une investigation : dans le dossier d'artifacts de l'onglet (affiché par l'app, seul endroit où la session peut écrire). */
export function reportPath(runId: number): string {
    return join(artifactsDir(runId), 'investigation.md');
}

export const ENV_LABEL: Record<InvestigationEnv, string> = { prod: 'prod', prelive: 'prelive' };

/** Effort par défaut d'un nouvel onglet selon son intention. */
export function intentEffort(intent: Run['intent']): EffortLevel | null {
    return intent === 'question' ? 'low' : null;
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Un serveur MCP propre à un environnement : `aws-cloudwatch-prelive`, `grafana_prelive`… */
const PRELIVE = /[-_]prelive$/i;

/** Nom tel qu'il apparaît dans les noms d'outils (`mcp__<serveur>__<outil>`). */
const normalize = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Serveur MCP à bloquer pour une investigation dans `env` : en prod, les serveurs `*-prelive` ; en
 * prelive, les serveurs qui ont un jumeau `*-prelive` (ceux sans jumeau, comme la doc, restent permis).
 */
export function blockedForEnv(server: string, env: InvestigationEnv, servers: string[]): boolean {
    if (env === 'prod') return PRELIVE.test(server);
    if (PRELIVE.test(server)) return false;
    return servers.some((s) => PRELIVE.test(s) && normalize(s).replace(PRELIVE, '').toLowerCase() === normalize(server).toLowerCase());
}

function deny(reason: string): HookJSONOutput {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function inside(path: string, dir: string): boolean {
    const target = resolve(path);
    return target === dir || target.startsWith(dir + sep);
}

/**
 * Garde-fous d'une session en lecture seule (investigation, question) : écriture permise seulement
 * dans le dossier d'artifacts de l'onglet, et pour une investigation, seulement les serveurs MCP de
 * son environnement. Un hook plutôt que `canUseTool` : il s'applique même quand les réglages du
 * compte autorisent déjà l'outil.
 */
export function intentHooks(run: Run, mcpServers: () => Promise<string[]>): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
    if (!run.intent) return undefined;
    const artifacts = resolve(artifactsDir(run.id));
    const env = run.intent === 'investigation' ? (run.env ?? 'prod') : null;
    return {
        PreToolUse: [
            {
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== 'PreToolUse') return {};
                        const tool = input.tool_name;
                        if (WRITE_TOOLS.has(tool)) {
                            const args = (input.tool_input ?? {}) as { file_path?: string; notebook_path?: string };
                            const path = args.file_path ?? args.notebook_path;
                            if (path && inside(path, artifacts)) return {};
                            return deny(`Onglet en lecture seule (${run.intent}) : tu ne modifies pas le code. Écris seulement dans ${artifacts}/ (rapport, pages). Propose les changements dans ta réponse ou dans le rapport.`);
                        }
                        if (env && tool.startsWith('mcp__')) {
                            const server = input.mcp_server?.name ?? tool.slice(5).split('__')[0] ?? '';
                            if (blockedForEnv(server, env, await mcpServers().catch(() => []))) {
                                return deny(`Investigation en ${env} : le serveur MCP « ${server} » est celui d'un autre environnement. Utilise ${env === 'prod' ? 'le serveur sans suffixe -prelive' : 'son jumeau -prelive'}.`);
                            }
                        }
                        return {};
                    },
                ],
            },
        ],
    };
}

/** Consigne ajoutée au prompt système selon l'intention de l'onglet. */
export function intentInstructions(run: Run): string | undefined {
    if (run.intent === 'question') {
        return [
            '# Question sur le code',
            '',
            "Cet onglet sert à comprendre le code, pas à le modifier. Réponds en lisant (Read, Grep, Glob, sous-agent Explore pour les recherches larges), avec des références `fichier:ligne`. Réponses courtes et directes.",
            "Ne modifie aucun fichier du dépôt (Edit et Write sont bloqués, sauf dans le dossier d'artifacts) et ne lance aucune commande qui change quelque chose.",
        ].join('\n');
    }
    if (run.intent !== 'investigation') return undefined;
    const env = run.env ?? 'prod';
    const link = run.issueNumber !== null ? ` lié à l'issue #${run.issueNumber}` : run.prNumber !== null ? ` lié à la PR #${run.prNumber}` : '';
    const mcp =
        env === 'prod'
            ? 'Serveurs MCP : ceux de prod (les serveurs `*-prelive` sont bloqués).'
            : "Serveurs MCP : ceux de prelive (`*-prelive`) ; un serveur qui a un jumeau `*-prelive` est bloqué, ceux sans jumeau restent utilisables.";
    return [
        `# Investigation (environnement : ${env})`,
        '',
        `Cet onglet sert à investiguer un problème${link} dans l'environnement **${env}**. Tu cherches à comprendre, tu ne corriges pas :`,
        "- Lecture seule : ne modifie aucun fichier du dépôt (Edit et Write sont bloqués, sauf dans le dossier d'artifacts), et ne lance aucune commande qui change un état (déploiement, écriture en base, redémarrage, push, migration, purge…). Si une telle action te semble nécessaire, propose-la sans l'exécuter.",
        `- Sources : logs, métriques, alarmes, traces, puis le code du dépôt pour relier ce que tu observes au comportement. ${mcp}`,
        '- Méthode : énonce tes hypothèses, cherche des preuves pour ou contre (requêtes et extraits de logs horodatés), construis une chronologie. Distingue ce qui est établi de ce qui est supposé. Borne tes requêtes dans le temps pour garder les résultats courts.',
        `- Rapport : quand tu as conclu, ou quand on te le demande, écris-le en Markdown dans \`${reportPath(run.id)}\` (réécris le même fichier pour le mettre à jour). Un titre \`# …\` qui résume le problème en une ligne (il peut devenir le titre d'une issue), puis : Contexte, Constat (avec les preuves), Cause (ou hypothèses restantes), Impact, Correctif proposé (fichiers et changements, sans les appliquer), Pour vérifier. Il sera publié sur GitHub : ni secret, ni donnée personnelle.`,
    ].join('\n');
}

import type { ReactElement } from 'react';
import { Menu } from '../Menu';
import type { ContextPart, UsageInfo } from '../../../../shared/protocol';

/**
 * Seuils en tokens, pas en % : la fenêtre va de 200 k à 1 M selon le modèle, alors que le coût d'une
 * requête suit le nombre de tokens envoyés (tout le contexte, à chaque appel d'outil).
 * - sous 80 k : rien à faire ;
 * - dès 80 k : compacter à la fin de la phase en cours (exploration finie, avant de coder…) ;
 * - dès 150 k : compacter maintenant, ou `/clear` si la suite n'a rien à voir.
 */
export const COMPACT_SOON = 80_000;
export const COMPACT_NOW = 150_000;

const PART_LABELS: Record<string, string> = {
    system_prompt: 'Prompt système',
    system_tools: 'Outils intégrés',
    mcp_tools: 'Outils MCP',
    mcp_instructions: 'Instructions MCP',
    custom_agents: 'Sous-agents',
    memory_files: 'CLAUDE.md et mémoire',
    skills: 'Skills',
    messages: 'Conversation',
};
const PART_HINTS: Record<string, string> = {
    system_prompt: 'Prompt de Claude Code et consignes de l\'app (pages, économie de contexte)',
    system_tools: 'Définitions des outils (Read, Edit, Bash, Agent…)',
    mcp_tools: 'Outils MCP chargés (les autres sont différés : seul leur nom est listé)',
    mcp_instructions: 'Texte d\'instructions fourni par chaque serveur MCP',
    custom_agents: 'Description des sous-agents disponibles',
    memory_files: 'CLAUDE.md du compte et du dépôt, mémoire automatique',
    skills: 'Nom et description de chaque skill disponible',
    messages: 'Tes messages, les réponses, les appels d\'outils et leurs résultats',
};

export function formatTokens(tokens: number): string {
    if (tokens < 1000) return `${tokens}`;
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1).replace('.', ',')} M`;
    return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0).replace('.', ',')} k`;
}

function level(tokens: number): 'ok' | 'soon' | 'now' {
    return tokens >= COMPACT_NOW ? 'now' : tokens >= COMPACT_SOON ? 'soon' : 'ok';
}

const label = (part: ContextPart): string => PART_LABELS[part.id] ?? part.name;

/**
 * Tokens dans le contexte de la session, bien visibles dans la barre d'état ; au clic, ce qui les
 * occupe (fixe : prompt système, outils, CLAUDE.md… ; variable : la conversation) et quoi faire.
 */
export function ContextGauge({ usage, idle, onCompact, onClear }: { usage: UsageInfo | undefined; idle: boolean; onCompact: () => void; onClear: () => void }): ReactElement | null {
    const context = usage?.context;
    if (!context) return null;
    const state = level(context.tokens);
    const parts = context.parts ?? [];
    const messages = parts.find((p) => p.id === 'messages')?.tokens ?? 0;
    const fixed = Math.max(0, context.tokens - messages);
    const biggest = Math.max(1, ...parts.map((p) => p.tokens));
    const advice =
        state === 'now'
            ? 'Compacte maintenant (ou repars de zéro si la suite n\'a rien à voir) : chaque requête renvoie tout ce contexte.'
            : state === 'soon'
              ? 'Compacte à la fin de la phase en cours (exploration finie, avant de coder, après une PR).'
              : `Rien à faire. Compacter devient utile vers ${formatTokens(COMPACT_SOON)}.`;

    return (
        <Menu
            className="context-gauge statusbar-more"
            align="right"
            small
            closeOnClick={false}
            title={`${context.tokens.toLocaleString('fr-FR')} tokens envoyés à chaque requête — cliquer pour le détail`}
            label={
                <span className={`context-pill context-${state}`}>
                    <span className="context-bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, (context.tokens / COMPACT_NOW) * 100)}%` }} />
                    </span>
                    <strong>{formatTokens(context.tokens)}</strong> tokens
                </span>
            }
        >
            <div className="context-detail">
                <div className="context-total">
                    <strong>{context.tokens.toLocaleString('fr-FR')}</strong> tokens dans le contexte
                    <span className="muted">
                        {' '}
                        sur {formatTokens(context.max)} ({Math.round(context.percent)} %)
                    </span>
                </div>
                <div className="muted context-split">
                    fixe {formatTokens(fixed)} · conversation {formatTokens(messages)}
                    {context.autoCompactAt ? ` · compaction auto à ${formatTokens(context.autoCompactAt)}` : ''}
                </div>
                <ul className="context-parts">
                    {parts.map((part) => (
                        <li key={part.id} title={PART_HINTS[part.id] ?? part.name}>
                            <span className="context-part-name">{label(part)}</span>
                            <span className="context-part-bar">
                                <span className={part.id === 'messages' ? 'is-messages' : ''} style={{ width: `${(part.tokens / biggest) * 100}%` }} />
                            </span>
                            <span className="context-part-tokens mono">{formatTokens(part.tokens)}</span>
                        </li>
                    ))}
                </ul>
                {context.memoryFiles && context.memoryFiles.length > 0 && (
                    <details className="context-files">
                        <summary className="muted">Fichiers d'instructions chargés ({context.memoryFiles.length})</summary>
                        {context.memoryFiles.map((file) => (
                            <div key={file.path} className="mono">
                                {file.path.replace(/^\/Users\/[^/]+/, '~')} · {formatTokens(file.tokens)}
                            </div>
                        ))}
                    </details>
                )}
                <div className={`context-advice context-${state}`}>{advice}</div>
                <div className="context-actions">
                    <button className="small" disabled={!idle} onClick={onCompact} title="Résume la conversation (/compact) : garde les décisions, les fichiers touchés et ce qui reste à faire">
                        Compacter
                    </button>
                    <button className="small" disabled={!idle} onClick={onClear} title="Nouvelle conversation dans cet onglet (/clear), pour une tâche sans lien">
                        Nouvelle conversation
                    </button>
                </div>
            </div>
        </Menu>
    );
}

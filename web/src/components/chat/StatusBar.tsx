import type { ReactElement } from 'react';
import { useState } from 'react';
import { stateDot } from '../Tabs';
import { Menu } from '../Menu';
import { COMPACT_SOON, ContextGauge } from './ContextGauge';
import { send } from '../../ws';
import { api } from '../../api';
import { useStore } from '../../store';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, ModelChoice, Run, UsageInfo } from '../../../../shared/protocol';

const FALLBACK_MODELS: ModelChoice[] = [
    { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' },
    { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' },
    { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: '' },
    { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: '' },
];
/** Niveaux d'effort, du plus économe au plus coûteux. */
export const EFFORTS: Record<EffortLevel, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
/** Effort des onglets qui n'en ont pas choisi (voir DEFAULT_EFFORT côté serveur). */
const DEFAULT_EFFORT: EffortLevel = 'medium';

/** Niveaux proposés pour le modèle de l'onglet (tous si on ne sait pas encore lesquels il accepte). */
export function effortChoices(model: ModelChoice | undefined): EffortLevel[] {
    return model?.efforts?.length ? model.efforts : (Object.keys(EFFORTS) as EffortLevel[]);
}

const MODES: Array<{ value: PermissionMode; label: string }> = [
    { value: 'default', label: 'normal (tout accepté par l\'app)' },
    { value: 'acceptEdits', label: 'éditions acceptées' },
    { value: 'plan', label: 'plan mode' },
    { value: 'bypassPermissions', label: 'bypass' },
];

/**
 * Copie la commande qui reprend cette session dans un terminal (`claude --resume`), pour continuer
 * la conversation hors de l'app. À lancer une fois l'onglet fermé : deux processus sur la même session
 * écriraient dans le même transcript.
 */
function CopyResume({ command }: { command: string }): ReactElement {
    const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const copy = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(command);
            setState('copied');
        } catch {
            setState('failed');
        }
        setTimeout(() => setState('idle'), 2000);
    };
    return (
        <button role="menuitem" data-keep-open="1" onClick={() => void copy()} title={`Reprendre cette session dans un terminal (fermer l'onglet avant).\nCopie : ${command}`}>
            {state === 'copied' ? 'Commande copiée ✓' : state === 'failed' ? 'Copie impossible' : 'Copier « claude --resume »'}
        </button>
    );
}

interface Props {
    run: Run;
    models: ModelChoice[];
    permissions: number;
    usage: UsageInfo | undefined;
}

export function StatusBar({ run, models, permissions, usage }: Props): ReactElement {
    const choices = models.length > 0 ? models : FALLBACK_MODELS;
    const list = run.model && !choices.some((m) => m.value === run.model) ? [{ value: run.model, displayName: run.model, description: '' }, ...choices] : choices;
    const resumeCommand = run.sessionId ? `cd ${run.cwd} && claude --resume ${run.sessionId}` : '';
    const context = usage?.context;
    const notify = useStore((s) => s.notify);
    const modelInfo = list.find((m) => m.value === run.model);
    const efforts = effortChoices(modelInfo);
    const effort = run.effort ?? DEFAULT_EFFORT;
    // Modèle sans effort réglable (Haiku…) : rien à choisir.
    const noEffort = modelInfo !== undefined && models.length > 0 && !modelInfo.efforts;
    const idle = run.state === 'idle';
    const compact = (): void => send({ type: 'prompt', runId: run.id, text: '/compact' });
    const clear = async (): Promise<void> => {
        if (!window.confirm("Repartir d'une conversation vide dans cet onglet ? La précédente reste reprenable depuis l'historique de l'issue ou du dépôt.")) return;
        try {
            await api.resetRun(run.id);
        } catch (error) {
            notify(String(error), run.id);
        }
    };

    return (
        <div className="statusbar">
            <span className="status-state">
                {stateDot(run.state)} {run.state}
            </span>
            <select value={run.model ?? ''} onChange={(e) => send({ type: 'setModel', runId: run.id, model: e.target.value })} title="Modèle">
                {!run.model && <option value="">modèle…</option>}
                {list.map((model) => (
                    <option key={model.value} value={model.value} title={model.description}>
                        {model.displayName}
                    </option>
                ))}
            </select>
            {!noEffort && (
                <select
                    value={effort}
                    onChange={(e) => send({ type: 'setEffort', runId: run.id, effort: e.target.value as EffortLevel })}
                    title={`Effort (réflexion) : medium suffit pour la plupart des tâches ; high et au-delà consomment nettement plus.${run.effort ? '' : '\nValeur par défaut de l\'app.'}`}
                    aria-label="Effort"
                >
                    {efforts.map((level) => (
                        <option key={level} value={level}>
                            effort {EFFORTS[level]}
                        </option>
                    ))}
                </select>
            )}
            <select value={run.permissionMode ?? 'default'} onChange={(e) => send({ type: 'setPermissionMode', runId: run.id, mode: e.target.value as PermissionMode })} title="Mode de permission">
                {MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                        {mode.label}
                    </option>
                ))}
            </select>
            <span className="muted status-perms" title="Commandes et outils acceptés automatiquement dans cette session">
                {permissions} permissions
            </span>
            <span className="spacer" />
            <ContextGauge usage={usage} idle={idle} onCompact={compact} onClear={() => void clear()} />
            {context && context.tokens >= COMPACT_SOON && idle && (
                <button className="link small-text" onClick={compact} title="Résume la conversation (/compact) : les requêtes suivantes renvoient beaucoup moins de tokens">
                    compacter
                </button>
            )}
            <span className="muted" title="Coût de la session">
                {run.costUsd.toFixed(2)} $
            </span>
            {run.lastError && (
                <span className="error" title={run.lastError}>
                    erreur
                </span>
            )}
            <Menu icon="more" title="Plus d'actions sur la session" align="right" className="statusbar-more" small>
                <button role="menuitem" disabled={run.state === 'closed'} onClick={() => send({ type: 'mcp', runId: run.id, action: 'status' })} title="État des serveurs MCP de la session (comme /mcp)">
                    Serveurs MCP…
                </button>
                <button role="menuitem" disabled={!idle} onClick={compact} title="Résume la conversation pour alléger les requêtes suivantes (comme /compact). À faire à la fin d'une phase, par exemple entre l'exploration et le code.">
                    Compacter la conversation
                </button>
                <button role="menuitem" disabled={run.state === 'running' || run.state === 'waiting'} onClick={() => void clear()} title="Nouvelle conversation dans le même onglet (comme /clear), pour une tâche sans lien avec la précédente">
                    Nouvelle conversation
                </button>
                {resumeCommand && <CopyResume command={resumeCommand} />}
            </Menu>
        </div>
    );
}

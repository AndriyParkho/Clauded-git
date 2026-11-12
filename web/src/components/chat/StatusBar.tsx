import type { ReactElement } from 'react';
import { stateDot } from '../Tabs';
import { send } from '../../ws';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ModelChoice, Run, UsageInfo } from '../../../../shared/protocol';

const FALLBACK_MODELS: ModelChoice[] = [
    { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' },
    { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' },
    { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: '' },
    { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: '' },
];
const MODES: Array<{ value: PermissionMode; label: string }> = [
    { value: 'default', label: 'normal (tout accepté par l\'app)' },
    { value: 'acceptEdits', label: 'éditions acceptées' },
    { value: 'plan', label: 'plan mode' },
    { value: 'bypassPermissions', label: 'bypass' },
];

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
    const contextClass = context ? (context.percent >= 85 ? 'error' : context.percent >= 65 ? 'warn' : '') : '';

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
            <select value={run.permissionMode ?? 'default'} onChange={(e) => send({ type: 'setPermissionMode', runId: run.id, mode: e.target.value as PermissionMode })} title="Mode de permission">
                {MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                        {mode.label}
                    </option>
                ))}
            </select>
            <span className="muted" title="Commandes et outils acceptés automatiquement dans cette session">
                {permissions} permissions
            </span>
            <span className="spacer" />
            {context && (
                <span className={`muted ${contextClass}`} title={`${context.tokens.toLocaleString('fr-FR')} / ${context.max.toLocaleString('fr-FR')} tokens`}>
                    contexte {Math.round(context.percent)} %
                </span>
            )}
            <span className="muted" title="Coût de la session">
                {run.costUsd.toFixed(2)} $
            </span>
            {resumeCommand && (
                <button className="small" onClick={() => void navigator.clipboard?.writeText(resumeCommand)} title={`Copier : ${resumeCommand}`}>
                    Terminal
                </button>
            )}
            {run.lastError && (
                <span className="error" title={run.lastError}>
                    erreur
                </span>
            )}
        </div>
    );
}

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { ProgressStep } from '../../../shared/protocol';

/**
 * Lance une opération longue côté serveur (ouverture d'une PR, implémentation) derrière un loader
 * qui bloque l'interface et affiche ses étapes, diffusées par le serveur sous `opId`. En cas
 * d'échec le loader reste ouvert avec l'erreur, et l'erreur est relancée.
 */
export async function withProgress<T>(title: string, work: (opId: string) => Promise<T>): Promise<T> {
    const opId = crypto.randomUUID();
    useStore.setState({ progress: { opId, title, steps: [] } });
    try {
        const result = await work(opId);
        useStore.setState((s) => (s.progress?.opId === opId ? { progress: null } : {}));
        return result;
    } catch (error) {
        useStore.setState((s) => {
            if (s.progress?.opId !== opId) return {};
            const failed = s.progress.steps.some((step) => step.state === 'failed');
            // Échec avant toute étape (serveur injoignable…) : une étape pour porter le message.
            const steps: ProgressStep[] = failed ? s.progress.steps : [...s.progress.steps.map((step) => (step.state === 'running' ? { ...step, state: 'failed' as const, detail: String(error) } : step))];
            if (!steps.some((step) => step.state === 'failed')) steps.push({ label: 'Échec', state: 'failed', detail: String(error) });
            return { progress: { ...s.progress, steps, error: String(error) } };
        });
        throw error;
    }
}

function seconds(since: string | undefined, now: number): string {
    if (!since) return '';
    const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

const ICONS: Record<ProgressStep['state'], string> = { pending: '○', running: '', done: '✓', failed: '✗' };

/** Le loader des opérations longues : par-dessus toute l'app, rien n'est cliquable dessous. */
export function ProgressOverlay(): ReactElement | null {
    const progress = useStore((s) => s.progress);
    const [now, setNow] = useState(() => Date.now());
    const failed = progress?.error !== undefined;
    const current = useRef<HTMLLIElement>(null);
    const runningLabel = progress?.steps.find((s) => s.state === 'running' || s.state === 'failed')?.label;

    // Longue liste (lot de 20 issues…) : l'étape en cours reste visible.
    useEffect(() => {
        current.current?.scrollIntoView({ block: 'nearest' });
    }, [runningLabel]);

    useEffect(() => {
        if (!progress || failed) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [progress, failed]);

    if (!progress) return null;
    const close = (): void => useStore.setState({ progress: null });
    const steps = progress.steps.length > 0 ? progress.steps : [{ label: 'Envoi de la demande au serveur', state: 'running' as const }];

    return (
        <div className={`progress-overlay ${failed ? 'failed' : ''}`} role="alertdialog" aria-busy={!failed} aria-label={progress.title}>
            <div className="progress-card">
                <div className="progress-title">
                    {failed ? <span className="progress-icon failed">✗</span> : <span className="spinner" />}
                    <span>{progress.title}</span>
                </div>
                {steps.length > 6 && (
                    <div className="muted progress-summary">
                        {steps.filter((s) => s.state === 'done').length} / {steps.length} étapes
                    </div>
                )}
                <ol className="progress-steps">
                    {steps.map((step) => (
                        <li key={step.label} ref={step.label === runningLabel ? current : undefined} className={`progress-step ${step.state}`}>
                            <span className="progress-icon">{step.state === 'running' ? <span className="spinner small" /> : ICONS[step.state]}</span>
                            <span className="progress-label">
                                {step.label}
                                {step.detail && <span className="progress-detail">{step.detail}</span>}
                            </span>
                            <span className="progress-time">{step.state === 'running' ? seconds(step.startedAt, now) : ''}</span>
                        </li>
                    ))}
                </ol>
                {failed ? (
                    <div className="progress-actions">
                        <button onClick={close}>Fermer</button>
                    </div>
                ) : (
                    <div className="muted progress-hint">La création d'un worktree sur un gros dépôt peut prendre une minute.</div>
                )}
            </div>
        </div>
    );
}

import type { ReactElement } from 'react';
import { useState } from 'react';
import { create } from 'zustand';
import { api } from '../api';
import { useStore } from '../store';
import { showRun } from '../ui';
import { Modal } from './Modal';
import { repoLabel } from './Tabs';
import type { InvestigationEnv, RunIntent } from '../../../shared/protocol';

/** Ce qui ouvre le dialogue : l'intention, et ce qui est déjà connu (dépôt, issue ou PR d'où l'on part). */
export interface NewIntentRequest {
    intent: RunIntent;
    repoId?: number;
    issueNumber?: number;
    prNumber?: number;
}

export const useNewIntent = create<{ request: NewIntentRequest | null; open: (request: NewIntentRequest) => void; close: () => void }>((set) => ({
    request: null,
    open: (request) => set({ request }),
    close: () => set({ request: null }),
}));

/** Ouvre le dialogue de création d'un chat avec intention, avec ce qu'on sait déjà. */
export function openNewIntent(request: NewIntentRequest): void {
    useNewIntent.getState().open(request);
}

const ENVS: Array<{ value: InvestigationEnv; label: string; hint: string }> = [
    { value: 'prod', label: 'Prod', hint: 'serveurs MCP sans suffixe -prelive' },
    { value: 'prelive', label: 'Prelive', hint: 'serveurs MCP -prelive' },
];

type LinkKind = 'none' | 'issue' | 'pr';

function Form({ request, onClose }: { request: NewIntentRequest; onClose: () => void }): ReactElement {
    const repos = useStore((s) => s.repos);
    const enabled = repos.filter((r) => r.enabled);
    const activeRepo = useStore((s) => s.runs.find((r) => r.id === s.activeRunId)?.repoId ?? null);
    const [intent, setIntent] = useState<RunIntent>(request.intent);
    const [repoId, setRepoId] = useState<number | null>(request.repoId ?? activeRepo ?? enabled[0]?.id ?? null);
    const [env, setEnv] = useState<InvestigationEnv>('prod');
    const [kind, setKind] = useState<LinkKind>(request.issueNumber !== undefined ? 'issue' : request.prNumber !== undefined ? 'pr' : 'none');
    const [number, setNumber] = useState(String(request.issueNumber ?? request.prNumber ?? ''));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const parsed = Number(number.replace(/^#/, '').trim());
    const validNumber = kind === 'none' || (Number.isInteger(parsed) && parsed > 0);

    const submit = async (): Promise<void> => {
        if (repoId === null || !validNumber) return;
        setBusy(true);
        setError(undefined);
        try {
            const { run, draft } = await api.intentChat(repoId, {
                intent,
                ...(intent === 'investigation' ? { env } : {}),
                ...(kind === 'issue' ? { issueNumber: parsed } : kind === 'pr' ? { prNumber: parsed } : {}),
            });
            const store = useStore.getState();
            store.upsertRun(run);
            if (draft) store.setDraft(run.id, draft);
            showRun(run.id);
            onClose();
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form
            className={`new-intent-form ${intent === 'investigation' ? `intent-investigation env-${env}` : 'intent-question'}`}
            onSubmit={(e) => {
                e.preventDefault();
                void submit();
            }}
        >
            <div className="choices" role="radiogroup" aria-label="Type de chat">
                <button type="button" className={intent === 'investigation' ? 'on' : ''} aria-pressed={intent === 'investigation'} onClick={() => setIntent('investigation')} title="Logs, métriques, comportement en prod ou prelive ; lecture seule, se termine par un rapport">
                    Investigation
                </button>
                <button type="button" className={intent === 'question' ? 'on' : ''} aria-pressed={intent === 'question'} onClick={() => setIntent('question')} title="Comprendre le code ; lecture seule, effort bas">
                    Question sur le code
                </button>
            </div>

            <label className="field">
                <span className="muted">Dépôt</span>
                <select value={repoId ?? ''} onChange={(e) => setRepoId(Number(e.target.value))}>
                    {enabled.map((repo) => (
                        <option key={repo.id} value={repo.id}>
                            {repoLabel(repo)}
                        </option>
                    ))}
                </select>
            </label>

            {intent === 'investigation' && (
                <div className="field">
                    <span className="muted">Environnement</span>
                    <div className="choices" role="radiogroup" aria-label="Environnement">
                        {ENVS.map((e) => (
                            <button key={e.value} type="button" className={env === e.value ? 'on' : ''} aria-pressed={env === e.value} onClick={() => setEnv(e.value)} title={e.hint}>
                                {e.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className="field">
                <span className="muted">Lié à (facultatif : le chat tourne dans son worktree s'il existe{intent === 'investigation' ? ', et le rapport y sera publié' : ''})</span>
                <div className="link-row">
                    <select value={kind} onChange={(e) => setKind(e.target.value as LinkKind)} aria-label="Lien">
                        <option value="none">Rien (problème général)</option>
                        <option value="issue">Issue</option>
                        <option value="pr">PR</option>
                    </select>
                    {kind !== 'none' && <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="numéro" inputMode="numeric" aria-label="Numéro" autoFocus />}
                </div>
            </div>

            {error && <div className="error">{error}</div>}
            <div className="batch-actions">
                <span className="spacer" />
                <button type="button" onClick={onClose}>
                    Annuler
                </button>
                <button type="submit" className="primary" disabled={busy || repoId === null || !validNumber}>
                    {busy ? 'Ouverture…' : intent === 'investigation' ? "Lancer l'investigation" : 'Ouvrir le chat'}
                </button>
            </div>
        </form>
    );
}

/** Dialogue « Nouvelle investigation » / « Nouvelle question », monté une fois dans l'app. */
export function NewIntentDialog(): ReactElement | null {
    const request = useNewIntent((s) => s.request);
    const close = useNewIntent((s) => s.close);
    if (!request) return null;
    return (
        <Modal className="batch-modal" onClose={close}>
            <div className="batch-head">
                <strong>Nouveau chat</strong>
                <span className="spacer" />
                <button className="small" onClick={close} title="Fermer">
                    ×
                </button>
            </div>
            <Form request={request} onClose={close} />
        </Modal>
    );
}

import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { MergeBaseButton, MergeIntegrationButton } from '../MergeIntegration';
import { OpenMenu } from '../OpenMenu';
import { withProgress } from '../Progress';
import { stateDot } from '../Tabs';
import { BrunoButton } from '../BrunoButton';
import { CleanupButton } from '../CleanupDialog';
import { BatchDialog } from './BatchDialog';
import { IssueBody, labelStyle, timeAgo } from './IssueBody';
import type { BatchItem, Issue, IssueFilter, IssueState, Repo, Run } from '../../../../shared/protocol';

interface StatusGroup {
    key: string;
    name: string | null;
    order: number;
    issues: Issue[];
}

/** Regroupe par statut de projet, les plus avancés d'abord (Review, Test, Doing… Backlog) ; les issues sans statut en dernier. */
function groupByStatus(issues: Issue[]): StatusGroup[] {
    const groups = new Map<string, StatusGroup>();
    for (const issue of issues) {
        const key = issue.status ? `${issue.status.project}/${issue.status.name}` : '';
        let group = groups.get(key);
        if (!group) {
            // Ordre inversé des colonnes du projet ; « sans statut » (-∞) reste tout en bas.
            group = { key, name: issue.status?.name ?? null, order: issue.status?.order ?? Number.NEGATIVE_INFINITY, issues: [] };
            groups.set(key, group);
        }
        group.issues.push(issue);
    }
    return [...groups.values()].sort((a, b) => b.order - a.order);
}

const FILTERS: Array<{ value: IssueFilter; label: string }> = [
    { value: 'assigned', label: 'Assignées à moi' },
    { value: 'created', label: 'Créées par moi' },
    { value: 'all', label: 'Toutes' },
];
const STATES: Array<{ value: IssueState; label: string }> = [
    { value: 'open', label: 'Ouvertes' },
    { value: 'closed', label: 'Fermées' },
    { value: 'all', label: 'Toutes' },
];

function IssueRow({ issue, run, waiting, selected, checked, onCheck, onClick }: { issue: Issue; run: Run | undefined; waiting: BatchItem | undefined; selected: boolean; checked: boolean; onCheck: (checked: boolean) => void; onClick: () => void }): ReactElement {
    return (
        <div className={`issue-line ${selected ? 'selected' : ''} ${checked ? 'checked' : ''}`}>
            <input type="checkbox" className="issue-check" checked={checked} onChange={(e) => onCheck(e.target.checked)} title="Sélectionner pour implémenter plusieurs issues en même temps" />
            <button className="issue-row" onClick={onClick}>
                <span className={`badge ${issue.state === 'OPEN' ? 'open' : 'closed'}`} />
                <span className="issue-row-number">#{issue.number}</span>
                <span className="issue-row-title">
                    {waiting && (
                        <span className={`batch-tag ${waiting.state}`} title={waiting.detail}>
                            {waiting.state === 'waiting' ? `⏳ ${waiting.detail}` : '✗ lancement en échec'}
                        </span>
                    )}
                    {issue.title}
                    {issue.parent !== null && <span className="muted"> ↳ #{issue.parent}</span>}
                    {issue.subIssues.length > 0 && (
                        <span className="muted">
                            {' '}
                            · {issue.subIssues.filter((s) => s.state === 'CLOSED').length}/{issue.subIssues.length} sous-issues
                        </span>
                    )}
                </span>
                <span className="issue-row-labels">
                    {issue.labels.slice(0, 4).map((label) => (
                        <span key={label.name} className="label" style={labelStyle(label.color)}>
                            {label.name}
                        </span>
                    ))}
                </span>
                <span className="issue-row-local">
                    {run && (
                        <span title={`onglet ${run.state}${run.prUrl ? ' · PR ouverte' : ''}`}>
                            {stateDot(run.state)}
                            {run.prUrl ? ' PR' : ''}
                        </span>
                    )}
                </span>
                <span className="muted issue-row-time">{timeAgo(issue.updatedAt)}</span>
            </button>
        </div>
    );
}

/** Issue d'un lot en attente de ses dépendances (ou en échec) : la lancer sans attendre, ou la retirer. */
function WaitingBlock({ item, busy, onStart }: { item: BatchItem | undefined; busy: boolean; onStart: () => void }): ReactElement | null {
    const notify = useStore((s) => s.notify);
    if (!item) return null;
    const waiting = item.state === 'waiting';
    return (
        <div className={`batch-waiting ${item.state}`}>
            <span>{waiting ? `⏳ Lot : ${item.detail}` : `✗ Lancement en échec : ${item.detail}`}</span>
            <button className="small" disabled={busy} onClick={onStart} title="Lancer sans attendre (empilée sur les dépendances qui ont déjà une PR)">
                {waiting ? 'Lancer maintenant' : 'Relancer'}
            </button>
            <button className="small" onClick={() => void api.cancelBatchItem(item.repoId, item.issueNumber).catch((e: unknown) => notify(String(e)))} title="Retirer du lot">
                Retirer
            </button>
        </div>
    );
}

export function IssuesPage(): ReactElement {
    // Filtrer hors du sélecteur : un sélecteur zustand qui renvoie un nouveau tableau boucle à l'infini.
    const allRepos = useStore((s) => s.repos);
    const repos = useMemo(() => allRepos.filter((r) => r.enabled && r.host === 'github.com'), [allRepos]);
    const runs = useStore((s) => s.runs);
    const issues = useStore((s) => s.issues);
    const setIssues = useStore((s) => s.setIssues);
    const upsertRun = useStore((s) => s.upsertRun);
    const setActive = useStore((s) => s.setActive);
    const setDraft = useStore((s) => s.setDraft);
    const setPage = useStore((s) => s.setPage);
    const notify = useStore((s) => s.notify);
    const [planMode, setPlanMode] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loadingMore, setLoadingMore] = useState<number | null>(null);
    const [batchOpen, setBatchOpen] = useState(false);
    const batch = useStore((s) => s.batch);
    const checked = issues.checked;

    const load = useCallback(
        async (refresh = false): Promise<void> => {
            setIssues({ loading: true });
            try {
                const byRepo = await api.issues({ ...(issues.repoId !== null ? { repoId: issues.repoId } : {}), filter: issues.filter, state: issues.state, refresh });
                setIssues({ byRepo, loading: false });
            } catch (error) {
                notify(String(error));
                setIssues({ loading: false });
            }
        },
        [issues.repoId, issues.filter, issues.state, setIssues, notify],
    );

    useEffect(() => {
        void load();
    }, [load]);

    const loadMore = async (repoId: number): Promise<void> => {
        setLoadingMore(repoId);
        try {
            const [entry] = await api.issues({ repoId, filter: issues.filter, state: issues.state, more: true });
            if (entry) setIssues({ byRepo: useStore.getState().issues.byRepo.map((e) => (e.repoId === repoId ? entry : e)) });
        } catch (error) {
            notify(String(error));
        } finally {
            setLoadingMore(null);
        }
    };

    const implementRun = (repoId: number, number: number): Run | undefined => runs.find((r) => r.repoId === repoId && r.issueNumber === number && r.type === 'implement');

    const chat = async (repoId: number, number: number): Promise<void> => {
        setBusy(true);
        try {
            const { run, draft } = await api.issueChat(repoId, number);
            upsertRun(run);
            setDraft(run.id, draft);
            setActive(run.id);
        } catch (error) {
            notify(String(error));
        } finally {
            setBusy(false);
        }
    };

    const implement = async (repoId: number, number: number): Promise<void> => {
        setBusy(true);
        try {
            const run = await withProgress(`Implémentation de l'issue #${number}`, (opId) => api.implement(repoId, number, planMode, opId));
            upsertRun(run);
            setActive(run.id);
        } catch {
            // L'erreur reste affichée dans le loader.
        } finally {
            setBusy(false);
        }
    };

    const waitingItem = (repoId: number, number: number): BatchItem | undefined => batch.find((b) => b.repoId === repoId && b.issueNumber === number);

    /** Coche/décoche une issue ; la sélection reste dans un seul dépôt (un lot = un dépôt). */
    const check = (repoId: number, numbers: number[], on: boolean): void => {
        const current = checked?.repoId === repoId ? checked.numbers : [];
        if (on && checked && checked.repoId !== repoId && checked.numbers.length > 0) notify('Sélection remise à zéro : un lot ne concerne qu\'un dépôt.');
        const next = on ? [...new Set([...current, ...numbers])] : current.filter((n) => !numbers.includes(n));
        setIssues({ checked: next.length ? { repoId, numbers: next } : null });
    };

    const startWaiting = async (repoId: number, number: number): Promise<void> => {
        setBusy(true);
        try {
            const run = await api.startBatchItem(repoId, number);
            upsertRun(run);
            setActive(run.id);
        } catch (error) {
            notify(String(error));
        } finally {
            setBusy(false);
        }
    };

    const selected = issues.selected;
    const repoById = new Map(repos.map((r) => [r.id, r]));

    return (
        <div className="issues-page">
            <div className="issues-toolbar">
                <select value={issues.repoId ?? ''} onChange={(e) => setIssues({ repoId: e.target.value ? Number(e.target.value) : null, selected: null })}>
                    <option value="">Tous les dépôts</option>
                    {repos.map((repo) => (
                        <option key={repo.id} value={repo.id}>
                            {repo.owner}/{repo.name}
                        </option>
                    ))}
                </select>
                <div className="segmented">
                    {FILTERS.map((f) => (
                        <button key={f.value} className={issues.filter === f.value ? 'active' : ''} onClick={() => setIssues({ filter: f.value })}>
                            {f.label}
                        </button>
                    ))}
                </div>
                <div className="segmented">
                    {STATES.map((s) => (
                        <button key={s.value} className={issues.state === s.value ? 'active' : ''} onClick={() => setIssues({ state: s.value })}>
                            {s.label}
                        </button>
                    ))}
                </div>
                <button className="small" onClick={() => void load(true)} disabled={issues.loading} title="Recharger depuis GitHub">
                    {issues.loading ? '…' : '↻'}
                </button>
                <span className="spacer" />
                {checked && (
                    <div className="batch-bar">
                        <span>
                            {checked.numbers.length} issue{checked.numbers.length > 1 ? 's' : ''} sélectionnée{checked.numbers.length > 1 ? 's' : ''}
                            <span className="muted"> · {repoById.get(checked.repoId)?.name ?? ''}</span>
                        </span>
                        <button className="primary small" onClick={() => setBatchOpen(true)} title="Voir les dépendances puis lancer les implémentations en parallèle">
                            Implémenter…
                        </button>
                        <button className="small" onClick={() => setIssues({ checked: null })} title="Vider la sélection">
                            ×
                        </button>
                    </div>
                )}
                {repos.length === 0 && (
                    <button className="link" onClick={() => setPage('repos')}>
                        Aucun dépôt GitHub actif : en ajouter
                    </button>
                )}
            </div>
            <div className="issues-body">
                <div className="issues-list">
                    {issues.byRepo.map((entry) => {
                        const repo = repoById.get(entry.repoId) as Repo | undefined;
                        if (!repo) return null;
                        return (
                            <div key={entry.repoId} className="issues-group">
                                <div className="issues-group-head">
                                    <span>
                                        {repo.owner}/{repo.name}
                                    </span>
                                    <span className="muted">{entry.issues.length}</span>
                                    {entry.error && (
                                        <span className="error" title={entry.error}>
                                            erreur GitHub
                                        </span>
                                    )}
                                    <span className="spacer" />
                                    <CleanupButton repo={repo} />
                                </div>
                                {groupByStatus(entry.issues).map((group) => (
                                    <div key={group.key} className="issues-status">
                                        {group.name !== null ? (
                                            <div className="issues-status-head">
                                                <span>{group.name}</span>
                                                <span className="muted">{group.issues.length}</span>
                                            </div>
                                        ) : (
                                            // Pas de sous-titre quand aucune issue du dépôt n'a de statut.
                                            entry.issues.some((i) => i.status !== null) && (
                                                <div className="issues-status-head">
                                                    <span className="muted">Sans statut</span>
                                                    <span className="muted">{group.issues.length}</span>
                                                </div>
                                            )
                                        )}
                                        {group.issues.map((issue) => (
                                            <IssueRow
                                                key={issue.number}
                                                issue={issue}
                                                run={implementRun(repo.id, issue.number)}
                                                waiting={waitingItem(repo.id, issue.number)}
                                                selected={selected?.repoId === repo.id && selected.number === issue.number}
                                                checked={checked?.repoId === repo.id && checked.numbers.includes(issue.number)}
                                                onCheck={(on) => check(repo.id, [issue.number], on)}
                                                onClick={() => setIssues({ selected: { repoId: repo.id, number: issue.number } })}
                                            />
                                        ))}
                                    </div>
                                ))}
                                {entry.issues.length === 0 && !entry.error && <div className="muted pad">aucune issue</div>}
                                {entry.nextCursor && (
                                    <div className="issues-more">
                                        <button className="issues-more-button" disabled={loadingMore === entry.repoId} onClick={() => void loadMore(entry.repoId)}>
                                            {loadingMore === entry.repoId ? 'Chargement…' : 'Charger la suite ↓'}
                                        </button>
                                        <span className="muted">{entry.issues.length} issues chargées</span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {issues.byRepo.length === 0 && !issues.loading && <div className="muted pad">Rien à afficher.</div>}
                </div>
                {selected && (
                    <div className="issues-detail">
                        <div className="issues-detail-bar">
                            <span className="muted mono">{repoById.get(selected.repoId)?.name ?? ''}</span>
                            <span className="spacer" />
                            <button className="small" onClick={() => setIssues({ selected: null })} title="Fermer le détail">
                                ×
                            </button>
                        </div>
                        <IssueBody
                            repoId={selected.repoId}
                            number={selected.number}
                            onSelect={(number) => setIssues({ selected: { repoId: selected.repoId, number } })}
                            actions={({ issue, worktree }) => (
                                <>
                                    <WaitingBlock item={waitingItem(selected.repoId, issue.number)} busy={busy} onStart={() => void startWaiting(selected.repoId, issue.number)} />
                                    <button disabled={busy} onClick={() => void chat(selected.repoId, issue.number)} title="Un chat dans le checkout principal, avec l'issue en brouillon de prompt">
                                        Chat
                                    </button>
                                    <button className="primary" disabled={busy} onClick={() => void implement(selected.repoId, issue.number)} title="Branche liée, worktree, et session Claude qui implémente">
                                        {implementRun(selected.repoId, issue.number) ? 'Rouvrir l\'implémentation' : 'Implémenter'}
                                    </button>
                                    <label className="muted check">
                                        <input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} /> plan d'abord
                                    </label>
                                    {worktree && <OpenMenu path={worktree.path} label="Ouvrir le worktree ▾" />}
                                    {worktree && <BrunoButton repoId={selected.repoId} path={worktree.path} />}
                                    {(worktree?.branch || issue.linkedBranches.length > 0 || issue.pullRequests.some((pr) => pr.state === 'OPEN') || implementRun(selected.repoId, issue.number)) && (
                                        <>
                                            <MergeBaseButton repoId={selected.repoId} what={`la branche de l'issue #${issue.number}`} start={() => api.mergeBaseFor(selected.repoId, { issueNumber: issue.number })} />
                                            <MergeIntegrationButton repoId={selected.repoId} what={`la branche de l'issue #${issue.number}`} start={() => api.mergeIntegrationFor(selected.repoId, { issueNumber: issue.number })} />
                                        </>
                                    )}
                                    {issue.subIssues.some((sub) => sub.state === 'OPEN') && (
                                        <button
                                            disabled={busy}
                                            onClick={() => {
                                                const open = issue.subIssues.filter((sub) => sub.state === 'OPEN').map((sub) => sub.number);
                                                setIssues({ checked: { repoId: selected.repoId, numbers: open } });
                                                setBatchOpen(true);
                                            }}
                                            title="Sélectionne les sous-issues ouvertes et ouvre le lancement en lot (dépendances, PR empilées)"
                                        >
                                            Implémenter les sous-issues
                                        </button>
                                    )}
                                </>
                            )}
                        />
                    </div>
                )}
            </div>
            {batchOpen && checked && (
                <BatchDialog
                    repoId={checked.repoId}
                    numbers={checked.numbers}
                    onAdd={(number) => check(checked.repoId, [number], true)}
                    onClose={() => setBatchOpen(false)}
                />
            )}
        </div>
    );
}

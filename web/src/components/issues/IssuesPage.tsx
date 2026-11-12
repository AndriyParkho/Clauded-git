import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { stateDot } from '../Tabs';
import { IssueBody, labelStyle, timeAgo } from './IssueBody';
import type { Issue, IssueFilter, IssueState, Repo, Run } from '../../../../shared/protocol';

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

function IssueRow({ issue, run, selected, onClick }: { issue: Issue; run: Run | undefined; selected: boolean; onClick: () => void }): ReactElement {
    return (
        <button className={`issue-row ${selected ? 'selected' : ''}`} onClick={onClick}>
            <span className={`badge ${issue.state === 'OPEN' ? 'open' : 'closed'}`} />
            <span className="issue-row-number">#{issue.number}</span>
            <span className="issue-row-title">
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
    );
}

export function IssuesPage(): ReactElement {
    const repos = useStore((s) => s.repos.filter((r) => r.enabled && r.host === 'github.com'));
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
            const run = await api.implement(repoId, number, planMode);
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
                                </div>
                                {entry.issues.map((issue) => (
                                    <IssueRow
                                        key={issue.number}
                                        issue={issue}
                                        run={implementRun(repo.id, issue.number)}
                                        selected={selected?.repoId === repo.id && selected.number === issue.number}
                                        onClick={() => setIssues({ selected: { repoId: repo.id, number: issue.number } })}
                                    />
                                ))}
                                {entry.issues.length === 0 && !entry.error && <div className="muted pad">aucune issue</div>}
                            </div>
                        );
                    })}
                    {issues.byRepo.length === 0 && !issues.loading && <div className="muted pad">Rien à afficher.</div>}
                </div>
                {selected && (
                    <div className="issues-detail">
                        <IssueBody
                            repoId={selected.repoId}
                            number={selected.number}
                            onSelect={(number) => setIssues({ selected: { repoId: selected.repoId, number } })}
                            actions={(issue) => (
                                <>
                                    <button disabled={busy} onClick={() => void chat(selected.repoId, issue.number)} title="Un chat dans le checkout principal, avec l'issue en brouillon de prompt">
                                        Chat
                                    </button>
                                    <button className="primary" disabled={busy} onClick={() => void implement(selected.repoId, issue.number)} title="Branche liée, worktree, et session Claude qui implémente">
                                        {implementRun(selected.repoId, issue.number) ? 'Rouvrir l\'implémentation' : 'Implémenter'}
                                    </button>
                                    <label className="muted check">
                                        <input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} /> plan d'abord
                                    </label>
                                    {issue.subIssues.length > 0 && (
                                        <button disabled title="Phase 3 : implémentation en parallèle des sous-issues">
                                            Implémenter les sous-issues
                                        </button>
                                    )}
                                </>
                            )}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

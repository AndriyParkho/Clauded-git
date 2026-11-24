import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Markdown } from '../Markdown';
import { useStore } from '../../store';
import { stateDot } from '../Tabs';
import type { IssueDetailResponse, Run, SessionHistoryItem } from '../../../../shared/protocol';

/** Couleur du label GitHub mêlée au texte clair : reste lisible même pour un label noir ou bleu nuit sur fond sombre. */
export function labelStyle(color: string): React.CSSProperties {
    const c = `#${color}`;
    return {
        borderColor: `color-mix(in srgb, ${c} 55%, transparent)`,
        background: `color-mix(in srgb, ${c} 16%, transparent)`,
        color: `color-mix(in srgb, ${c} 60%, var(--fg-strong))`,
    };
}

export function timeAgo(iso: string | number): string {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return 'à l\'instant';
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `il y a ${hours} h`;
    const days = Math.round(hours / 24);
    if (days < 60) return `il y a ${days} j`;
    return new Date(iso).toLocaleDateString('fr-FR');
}

const RUN_TYPE_LABEL: Record<Run['type'], string> = { chat: 'chat', implement: 'implémentation', pr: 'PR', merge: 'merge', spec: 'spec' };

interface Props {
    repoId: number;
    number: number;
    /** Navigation vers une autre issue (sous-issue, parent). */
    onSelect?: (number: number) => void;
    /** Boutons d'action affichés sous l'en-tête. */
    actions?: (detail: IssueDetailResponse) => ReactNode;
    compact?: boolean;
}

/** Un onglet (ouvert ou archivé) ou une session Claude Code de la branche, dans l'historique de l'issue. */
type HistoryEntry = { kind: 'run'; run: Run; at: number } | { kind: 'session'; session: SessionHistoryItem; at: number };

/** Historique des chats de l'issue : onglets de l'app (archivés compris) et sessions de sa branche. */
function History({ repoId, number, detail, busy, onBusy }: { repoId: number; number: number; detail: IssueDetailResponse; busy: boolean; onBusy: (busy: boolean) => void }): ReactElement | null {
    const liveRuns = useStore((s) => s.runs);
    const setActive = useStore((s) => s.setActive);
    const upsertRun = useStore((s) => s.upsertRun);
    const notify = useStore((s) => s.notify);

    // Les onglets ouverts viennent du store (état en direct), les autres de la réponse du serveur.
    const entries: HistoryEntry[] = [];
    const seen = new Set<number>();
    for (const run of liveRuns) {
        if (run.repoId === repoId && run.issueNumber === number) {
            entries.push({ kind: 'run', run, at: new Date(run.updatedAt).getTime() });
            seen.add(run.id);
        }
    }
    for (const run of detail.runs) if (!seen.has(run.id)) entries.push({ kind: 'run', run, at: new Date(run.updatedAt).getTime() });
    for (const session of detail.sessions) entries.push({ kind: 'session', session, at: session.lastModified });
    entries.sort((a, b) => b.at - a.at);
    if (entries.length === 0) return null;

    const act = async (action: () => Promise<Run>): Promise<void> => {
        onBusy(true);
        try {
            const run = await action();
            upsertRun(run);
            setActive(run.id);
        } catch (error) {
            notify(String(error));
        } finally {
            onBusy(false);
        }
    };

    return (
        <div className="issue-history">
            <div className="sidebar-section">Historique ({entries.length})</div>
            {entries.map((entry) =>
                entry.kind === 'run' ? (
                    <div key={`run-${entry.run.id}`} className="history-row" title={`${entry.run.cwd}\n${entry.run.sessionId ?? 'pas encore de session'}`}>
                        {entry.run.archived ? <span className="dot dot-closed" title="onglet fermé" /> : stateDot(entry.run.state)}
                        <span className="history-kind">{RUN_TYPE_LABEL[entry.run.type]}</span>
                        <span className="history-title">{entry.run.title}</span>
                        <span className="muted">
                            {timeAgo(entry.run.updatedAt)}
                            {entry.run.costUsd > 0 ? ` · ${entry.run.costUsd.toFixed(2)} $` : ''}
                            {entry.run.prUrl ? ' · PR' : ''}
                        </span>
                        {entry.run.archived ? (
                            <button className="small" disabled={busy} onClick={() => void act(() => api.openRun(entry.run.id))}>
                                Reprendre
                            </button>
                        ) : (
                            <button className="small" onClick={() => setActive(entry.run.id)}>
                                Ouvrir
                            </button>
                        )}
                    </div>
                ) : (
                    <div key={`session-${entry.session.sessionId}`} className="history-row" title={`${entry.session.cwd ?? ''}\n${entry.session.sessionId}`}>
                        <span className="dot dot-closed" title="session Claude Code hors app" />
                        <span className="history-kind">session{entry.session.gitBranch ? ` · ${entry.session.gitBranch}` : ''}</span>
                        <span className="history-title">{entry.session.customTitle ?? entry.session.summary ?? entry.session.firstPrompt ?? entry.session.sessionId}</span>
                        <span className="muted">{timeAgo(entry.session.lastModified)}</span>
                        <button className="small" disabled={busy} onClick={() => void act(() => api.resumeIssueSession(repoId, number, entry.session.sessionId))}>
                            Reprendre
                        </button>
                    </div>
                ),
            )}
        </div>
    );
}

/** Détail d'une issue : en-tête, actions, historique, sous-issues, corps, commentaires. */
export function IssueBody({ repoId, number, onSelect, actions, compact }: Props): ReactElement {
    const [data, setData] = useState<IssueDetailResponse | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);
    const runCount = useStore((s) => s.runs.length);

    const load = useCallback((): (() => void) => {
        let cancelled = false;
        api.issue(repoId, number)
            .then((result) => !cancelled && setData(result))
            .catch((e: unknown) => !cancelled && setError(String(e)));
        return () => {
            cancelled = true;
        };
    }, [repoId, number]);

    useEffect(() => {
        setData(undefined);
        setError(undefined);
        return load();
    }, [load]);

    // Un onglet ouvert ou fermé change l'historique : on recharge sans vider l'affichage.
    useEffect(() => {
        if (data) return load();
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runCount]);

    if (error) return <div className="error pad">{error}</div>;
    if (!data) return <div className="muted pad">chargement de l'issue #{number}…</div>;
    const { issue } = data;

    return (
        <div className={`issue ${compact ? 'compact' : ''}`}>
            <div className="issue-head">
                <span className={`badge ${issue.state === 'OPEN' ? 'open' : 'closed'}`}>{issue.state === 'OPEN' ? 'ouverte' : 'fermée'}</span>
                <a href={issue.url} target="_blank" rel="noreferrer" className="issue-number">
                    #{issue.number}
                </a>
                <h2 className="issue-title">{issue.title}</h2>
            </div>
            <div className="issue-meta muted">
                @{issue.author} · {timeAgo(issue.createdAt)} · {issue.comments} commentaires
                {issue.assignees.length > 0 && ` · assignée à ${issue.assignees.map((a) => `@${a}`).join(', ')}`}
                {issue.status && (
                    <span className="status-chip" title={`projet ${issue.status.project}`}>
                        {issue.status.name}
                    </span>
                )}
                {issue.labels.map((label) => (
                    <span key={label.name} className="label" style={labelStyle(label.color)}>
                        {label.name}
                    </span>
                ))}
            </div>
            {issue.parent !== null && (
                <div className="muted">
                    Sous-issue de{' '}
                    <button className="link" onClick={() => onSelect?.(issue.parent as number)}>
                        #{issue.parent}
                    </button>
                </div>
            )}
            {actions && <div className="issue-actions">{actions(data)}</div>}
            {(issue.linkedBranches.length > 0 || data.worktree || issue.pullRequests.length > 0) && (
                <div className="muted mono issue-links">
                    {issue.linkedBranches.length > 0 && <span>branche liée : {issue.linkedBranches.join(', ')}</span>}
                    {data.worktree && (
                        <span>
                            worktree : {data.worktree.path}
                            {data.worktree.branch ? ` (${data.worktree.branch})` : ''}
                        </span>
                    )}
                    {issue.pullRequests.map((pr) => (
                        <span key={pr.number}>
                            <span className={`badge ${pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed'}`} />{' '}
                            <a href={pr.url} target="_blank" rel="noreferrer">
                                PR #{pr.number}
                            </a>{' '}
                            {pr.isDraft ? 'draft · ' : ''}
                            {pr.headRefName}
                        </span>
                    ))}
                </div>
            )}
            <History repoId={repoId} number={number} detail={data} busy={busy} onBusy={setBusy} />
            {issue.subIssues.length > 0 && (
                <div className="sub-issues">
                    <div className="sidebar-section">Sous-issues ({issue.subIssues.filter((s) => s.state === 'CLOSED').length}/{issue.subIssues.length} fermées)</div>
                    {issue.subIssues.map((sub) => (
                        <button key={sub.number} className="link sub-issue" onClick={() => onSelect?.(sub.number)}>
                            <span className={`badge ${sub.state === 'OPEN' ? 'open' : 'closed'}`} />#{sub.number} {sub.title}
                        </button>
                    ))}
                </div>
            )}
            <div className="issue-body">
                <Markdown text={issue.body || '*(pas de description)*'} />
            </div>
            {issue.commentList.length > 0 && (
                <details className="issue-comments" open={!compact}>
                    <summary>{issue.commentList.length} commentaires</summary>
                    {issue.commentList.map((comment, i) => (
                        <div key={i} className="comment">
                            <div className="muted">
                                @{comment.author} · {timeAgo(comment.createdAt)}
                            </div>
                            <Markdown text={comment.body} />
                        </div>
                    ))}
                </details>
            )}
        </div>
    );
}

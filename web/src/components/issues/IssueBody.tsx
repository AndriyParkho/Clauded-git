import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Markdown } from '../Markdown';
import { useStore } from '../../store';
import { stateDot } from '../Tabs';
import type { IssueDetail, Run } from '../../../../shared/protocol';

export function labelStyle(color: string): React.CSSProperties {
    return { borderColor: `#${color}`, color: `#${color}` };
}

export function timeAgo(iso: string): string {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return 'à l\'instant';
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `il y a ${hours} h`;
    const days = Math.round(hours / 24);
    if (days < 60) return `il y a ${days} j`;
    return new Date(iso).toLocaleDateString('fr-FR');
}

interface Props {
    repoId: number;
    number: number;
    /** Navigation vers une autre issue (sous-issue, parent). */
    onSelect?: (number: number) => void;
    /** Boutons d'action affichés sous l'en-tête. */
    actions?: (issue: IssueDetail, runs: Run[]) => ReactNode;
    compact?: boolean;
}

/** Détail d'une issue : en-tête, actions, sous-issues, corps, commentaires. */
export function IssueBody({ repoId, number, onSelect, actions, compact }: Props): ReactElement {
    const [data, setData] = useState<{ issue: IssueDetail; runs: Run[] } | undefined>();
    const [error, setError] = useState<string | undefined>();
    const runs = useStore((s) => s.runs);
    const setActive = useStore((s) => s.setActive);

    useEffect(() => {
        let cancelled = false;
        setData(undefined);
        setError(undefined);
        api.issue(repoId, number)
            .then((result) => !cancelled && setData(result))
            .catch((e: unknown) => !cancelled && setError(String(e)));
        return () => {
            cancelled = true;
        };
    }, [repoId, number]);

    if (error) return <div className="error pad">{error}</div>;
    if (!data) return <div className="muted pad">chargement de l'issue #{number}…</div>;
    const { issue } = data;
    const localRuns = runs.filter((r) => r.repoId === repoId && r.issueNumber === number);

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
            {actions && <div className="issue-actions">{actions(issue, data.runs)}</div>}
            {localRuns.length > 0 && (
                <div className="issue-runs">
                    {localRuns.map((run) => (
                        <button key={run.id} className="small" onClick={() => setActive(run.id)} title={run.cwd}>
                            {stateDot(run.state)} {run.type === 'implement' ? 'implémentation' : run.type} · {run.state}
                            {run.prUrl ? ' · PR' : ''}
                        </button>
                    ))}
                </div>
            )}
            {issue.linkedBranches.length > 0 && <div className="muted mono">branche liée : {issue.linkedBranches.join(', ')}</div>}
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

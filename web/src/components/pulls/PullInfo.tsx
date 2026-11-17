import type { ReactElement, ReactNode } from 'react';
import { useStore } from '../../store';
import { Markdown } from '../Markdown';
import { labelStyle, timeAgo } from '../issues/IssueBody';
import type { CheckInfo, ChecksState, IssueRef, PullDetail, PullSummary, ReviewDecision } from '../../../../shared/protocol';

const CHECKS_LABEL: Record<NonNullable<ChecksState>, string> = { SUCCESS: 'checks ok', FAILURE: 'checks en échec', ERROR: 'checks en erreur', PENDING: 'checks en cours', EXPECTED: 'checks attendus' };
const DECISION_LABEL: Record<NonNullable<ReviewDecision>, string> = { APPROVED: 'approuvée', CHANGES_REQUESTED: 'changements demandés', REVIEW_REQUIRED: 'review requise' };
const REVIEW_LABEL: Record<string, string> = { APPROVED: 'a approuvé', CHANGES_REQUESTED: 'a demandé des changements', COMMENTED: 'a commenté', DISMISSED: 'review écartée', PENDING: 'review en attente' };

function checkClass(state: string | null): string {
    if (state === 'SUCCESS' || state === 'NEUTRAL' || state === 'SKIPPED') return 'ok';
    if (state === 'FAILURE' || state === 'ERROR' || state === 'TIMED_OUT' || state === 'CANCELLED' || state === 'ACTION_REQUIRED' || state === 'STARTUP_FAILURE') return 'ko';
    return 'pending';
}

/** Pastille de l'état des checks du dernier commit. */
export function ChecksDot({ state }: { state: ChecksState }): ReactElement | null {
    if (!state) return null;
    return <span className={`check-dot ${checkClass(state)}`} title={CHECKS_LABEL[state]} />;
}

export function PullStateBadge({ pull }: { pull: PullSummary }): ReactElement {
    const kind = pull.state === 'MERGED' ? 'merged' : pull.state === 'CLOSED' ? 'closed' : pull.isDraft ? 'draft' : 'open';
    const label = pull.state === 'OPEN' ? (pull.isDraft ? 'draft' : 'ouverte') : pull.state === 'MERGED' ? 'mergée' : 'fermée';
    return <span className={`badge ${kind}`}>{label}</span>;
}

export function decisionLabel(decision: ReviewDecision): string | null {
    return decision ? DECISION_LABEL[decision] : null;
}

function Checks({ checks }: { checks: CheckInfo[] }): ReactElement | null {
    if (checks.length === 0) return null;
    const failed = checks.filter((c) => checkClass(c.state) === 'ko');
    const pending = checks.filter((c) => checkClass(c.state) === 'pending');
    // Les checks en échec et en cours d'abord : ce sont eux qu'on cherche.
    const ordered = [...failed, ...pending, ...checks.filter((c) => checkClass(c.state) === 'ok')];
    return (
        <details className="pull-section" open={failed.length > 0}>
            <summary>
                Checks ({checks.length}){failed.length > 0 && <span className="error"> · {failed.length} en échec</span>}
                {pending.length > 0 && <span className="warn"> · {pending.length} en cours</span>}
            </summary>
            <div className="checks">
                {ordered.map((check, i) => (
                    <div key={`${check.name}-${i}`} className="check-row">
                        <span className={`check-dot ${checkClass(check.state)}`} />
                        {check.url ? (
                            <a href={check.url} target="_blank" rel="noreferrer">
                                {check.name}
                            </a>
                        ) : (
                            <span>{check.name}</span>
                        )}
                        <span className="muted">{check.state.toLowerCase()}</span>
                    </div>
                ))}
            </div>
        </details>
    );
}

function Threads({ pull }: { pull: PullDetail }): ReactElement | null {
    if (pull.threads.length === 0) return null;
    const open = pull.threads.filter((t) => !t.isResolved);
    const resolved = pull.threads.length - open.length;
    return (
        <details className="pull-section" open={open.length > 0}>
            <summary>
                Commentaires de review : {open.length} non résolu{open.length > 1 ? 's' : ''}
                {resolved > 0 && <span className="muted"> · {resolved} résolu{resolved > 1 ? 's' : ''}</span>}
            </summary>
            {[...open, ...pull.threads.filter((t) => t.isResolved)].map((thread, i) => (
                <div key={i} className={`thread ${thread.isResolved ? 'resolved' : ''}`}>
                    <div className="mono thread-path">
                        {thread.path}
                        {thread.line ? `:${thread.line}` : ''}
                        {thread.isOutdated && <span className="muted"> · ligne modifiée depuis</span>}
                        {thread.isResolved && <span className="muted"> · résolu</span>}
                    </div>
                    {thread.comments.map((comment, j) => (
                        <div key={j} className="thread-comment">
                            <div className="muted">
                                @{comment.author} · {timeAgo(comment.createdAt)}
                            </div>
                            <Markdown text={comment.body} />
                        </div>
                    ))}
                </div>
            ))}
        </details>
    );
}

/**
 * Issues liées à la PR. « Voir » ouvre l'issue (dans le panneau de l'onglet, ou sur la page Issues) ;
 * si elle a un onglet d'implémentation ouvert, on peut y sauter.
 */
function LinkedIssues({ repoId, issues, onOpenIssue }: { repoId: number; issues: IssueRef[]; onOpenIssue: ((number: number) => void) | undefined }): ReactElement | null {
    const runs = useStore((s) => s.runs);
    const setIssues = useStore((s) => s.setIssues);
    const setPage = useStore((s) => s.setPage);
    const setActive = useStore((s) => s.setActive);
    if (issues.length === 0) return null;
    const open = (number: number): void => {
        if (onOpenIssue) {
            onOpenIssue(number);
            return;
        }
        setIssues({ selected: { repoId, number } });
        setPage('issues');
    };
    return (
        <div className="linked-issues">
            {issues.map((issue) => {
                const implement = runs.find((r) => r.repoId === repoId && r.issueNumber === issue.number && r.type === 'implement');
                return (
                    <div key={issue.number} className="linked-issue">
                        <span className={`badge ${issue.state === 'OPEN' ? 'open' : 'closed'}`} />
                        <button className="link" onClick={() => open(issue.number)} title="Ouvrir l'issue">
                            #{issue.number} {issue.title}
                        </button>
                        {implement && (
                            <button className="small" onClick={() => setActive(implement.id)} title="Aller à l'onglet d'implémentation de l'issue">
                                implémentation →
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

interface PullInfoProps {
    pull: PullDetail;
    repoId: number;
    actions?: ReactNode;
    /** Ouvrir une issue liée ; par défaut, la page Issues avec l'issue sélectionnée. */
    onOpenIssue?: (number: number) => void;
}

/** Tout ce qu'on lit d'une PR : en-tête, issues liées, checks, description, reviews, fils de commentaires, discussion. */
export function PullInfo({ pull, repoId, actions, onOpenIssue }: PullInfoProps): ReactElement {
    const reviews = pull.reviews.filter((r) => r.state !== 'COMMENTED' || r.body.trim());
    return (
        <div className="issue pull">
            <div className="issue-head">
                <a className="issue-number" href={pull.url} target="_blank" rel="noreferrer">
                    #{pull.number}
                </a>
                <h3 className="issue-title">{pull.title}</h3>
            </div>
            <div className="issue-meta">
                <PullStateBadge pull={pull} />
                <span className="muted">
                    @{pull.author} · <span className="mono">{pull.headRefName}</span> → <span className="mono">{pull.baseRefName}</span> · {pull.changedFiles} fichiers <span className="add-count">+{pull.additions}</span> <span className="del-count">−{pull.deletions}</span>
                </span>
                {pull.reviewDecision && <span className="status-chip">{DECISION_LABEL[pull.reviewDecision]}</span>}
                {pull.labels.map((label) => (
                    <span key={label.name} className="label" style={labelStyle(label.color)}>
                        {label.name}
                    </span>
                ))}
            </div>
            <LinkedIssues repoId={repoId} issues={pull.issues} onOpenIssue={onOpenIssue} />
            {actions && <div className="issue-actions">{actions}</div>}
            <Checks checks={pull.checkList} />
            <div className="issue-body">{pull.body.trim() ? <Markdown text={pull.body} /> : <span className="muted">Pas de description.</span>}</div>
            {reviews.length > 0 && (
                <div className="pull-section">
                    {reviews.map((review, i) => (
                        <div key={i} className="review-row">
                            <span className={`review-state ${review.state.toLowerCase()}`}>@{review.author}</span> <span className="muted">{REVIEW_LABEL[review.state] ?? review.state.toLowerCase()}</span>
                            {review.submittedAt && <span className="muted"> · {timeAgo(review.submittedAt)}</span>}
                            {review.body.trim() && <Markdown text={review.body} />}
                        </div>
                    ))}
                </div>
            )}
            <Threads pull={pull} />
            {pull.comments.length > 0 && (
                <details className="issue-comments">
                    <summary>{pull.comments.length} commentaires de discussion</summary>
                    {pull.comments.map((comment, i) => (
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

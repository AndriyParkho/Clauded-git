import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { ResizablePane } from '../ResizeHandle';
import { useStore } from '../../store';
import { BrunoButton } from '../BrunoButton';
import { MergeBaseButton, MergeIntegrationButton } from '../MergeIntegration';
import { OpenMenu } from '../OpenMenu';
import { withProgress } from '../Progress';
import { ReviewSkillSelect } from './ReviewSkillSelect';
import { stateDot } from '../Tabs';
import { timeAgo } from '../issues/IssueBody';
import { ChecksDot, PullInfo, decisionLabel } from './PullInfo';
import type { PullDetailResponse, PullFilter, PullSummary, Repo, Run } from '../../../../shared/protocol';

const FILTERS: Array<{ value: PullFilter; label: string }> = [
    { value: 'review', label: 'À relire' },
    { value: 'mine', label: 'Les miennes' },
    { value: 'all', label: 'Toutes les ouvertes' },
];

function PullRow({ pull, run, selected, onClick }: { pull: PullSummary; run: Run | undefined; selected: boolean; onClick: () => void }): ReactElement {
    const decision = decisionLabel(pull.reviewDecision);
    return (
        <button className={`issue-row pull-row ${selected ? 'selected' : ''}`} onClick={onClick}>
            <span>
                <ChecksDot state={pull.checks} />
            </span>
            <span className="issue-row-number">#{pull.number}</span>
            <span className="issue-row-title">
                {pull.isDraft && <span className="muted">[draft] </span>}
                {pull.title}
                <span className="muted"> · @{pull.author}</span>
            </span>
            <span className="muted pull-row-meta">
                {decision ?? ''} <span className="add-count">+{pull.additions}</span> <span className="del-count">−{pull.deletions}</span>
            </span>
            <span className="issue-row-local">{run && <span title={`onglet ${run.state}`}>{stateDot(run.state)}</span>}</span>
            <span className="muted issue-row-time">{timeAgo(pull.updatedAt)}</span>
        </button>
    );
}

function PullDetailPane({ repoId, number }: { repoId: number; number: number }): ReactElement {
    const runs = useStore((s) => s.runs);
    const upsertRun = useStore((s) => s.upsertRun);
    const setActive = useStore((s) => s.setActive);
    const [detail, setDetail] = useState<PullDetailResponse | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setDetail(undefined);
        setError(undefined);
        api.pull(repoId, number)
            .then(setDetail)
            .catch((e: unknown) => setError(String(e)));
    }, [repoId, number]);

    const open = async (review: boolean): Promise<void> => {
        setBusy(true);
        try {
            const run = await withProgress(review ? `Review de la PR #${number}` : `Ouverture de la PR #${number}`, (opId) => api.openPull(repoId, number, review, opId));
            upsertRun(run);
            setActive(run.id);
        } catch {
            // L'erreur reste affichée dans le loader.
        } finally {
            setBusy(false);
        }
    };

    if (error) return <div className="error pad">{error}</div>;
    if (!detail) return <div className="muted pad">chargement…</div>;
    const live = runs.find((r) => r.repoId === repoId && r.prNumber === number && r.type === 'pr');
    const archived = detail.runs.filter((r) => r.archived && r.type === 'pr');

    return (
        <PullInfo
            pull={detail.pull}
            repoId={repoId}
            actions={
                <>
                    <button className="primary" disabled={busy} onClick={() => void open(true)} title="Worktree sur la branche de la PR, session Claude, et review par le skill du profil (rien n'est publié)">
                        Review
                    </button>
                    <ReviewSkillSelect repoId={repoId} />
                    <button disabled={busy} onClick={() => void open(false)} title="Worktree sur la branche de la PR et un chat dedans, pour poser des questions sur le code">
                        {live ? 'Rouvrir l\'onglet' : archived.length ? 'Reprendre le chat' : 'Chat sur la PR'}
                    </button>
                    {detail.worktree ? (
                        <>
                            <OpenMenu path={detail.worktree.path} label="Ouvrir le worktree" />
                            <BrunoButton repoId={repoId} path={detail.worktree.path} />
                        </>
                    ) : (
                        <span className="muted" title="Créé par « Review » ou « Chat sur la PR »">
                            pas encore de worktree
                        </span>
                    )}
                    {!detail.pull.isCrossRepository && detail.pull.state === 'OPEN' && (
                        <>
                            <MergeBaseButton repoId={repoId} base={detail.pull.baseRefName} what={detail.pull.headRefName} start={() => api.mergeBaseFor(repoId, { prNumber: number })} />
                            <MergeIntegrationButton repoId={repoId} what={detail.pull.headRefName} start={() => api.mergeIntegrationFor(repoId, { prNumber: number })} />
                        </>
                    )}
                    <a href={detail.pull.url} target="_blank" rel="noreferrer">
                        GitHub ↗
                    </a>
                </>
            }
        />
    );
}

export function PullsPage(): ReactElement {
    const allRepos = useStore((s) => s.repos);
    const repos = useMemo(() => allRepos.filter((r) => r.enabled && r.host === 'github.com'), [allRepos]);
    const runs = useStore((s) => s.runs);
    const pulls = useStore((s) => s.pulls);
    const setPulls = useStore((s) => s.setPulls);
    const setPage = useStore((s) => s.setPage);
    const notify = useStore((s) => s.notify);

    const load = useCallback(
        async (refresh = false): Promise<void> => {
            setPulls({ loading: true });
            try {
                const byRepo = await api.pulls({ ...(pulls.repoId !== null ? { repoId: pulls.repoId } : {}), filter: pulls.filter, refresh });
                setPulls({ byRepo, loading: false });
            } catch (error) {
                notify(String(error));
                setPulls({ loading: false });
            }
        },
        [pulls.repoId, pulls.filter, setPulls, notify],
    );

    useEffect(() => {
        void load();
    }, [load]);

    const repoById = new Map(repos.map((r) => [r.id, r]));
    const selected = pulls.selected;
    const prRun = (repoId: number, number: number): Run | undefined => runs.find((r) => r.repoId === repoId && r.prNumber === number && r.type === 'pr');
    const total = pulls.byRepo.reduce((n, e) => n + e.pulls.length, 0);

    return (
        <div className="issues-page">
            <div className="issues-toolbar">
                <select value={pulls.repoId ?? ''} onChange={(e) => setPulls({ repoId: e.target.value ? Number(e.target.value) : null, selected: null })}>
                    <option value="">Tous les dépôts</option>
                    {repos.map((repo) => (
                        <option key={repo.id} value={repo.id}>
                            {repo.owner}/{repo.name}
                        </option>
                    ))}
                </select>
                <div className="segmented">
                    {FILTERS.map((f) => (
                        <button key={f.value} className={pulls.filter === f.value ? 'active' : ''} onClick={() => setPulls({ filter: f.value })}>
                            {f.label}
                        </button>
                    ))}
                </div>
                <button className="small" onClick={() => void load(true)} disabled={pulls.loading} title="Recharger depuis GitHub">
                    {pulls.loading ? '…' : '↻'}
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
                    {pulls.byRepo.map((entry) => {
                        const repo = repoById.get(entry.repoId) as Repo | undefined;
                        // Vue « tous les dépôts » : on n'affiche que ceux qui ont quelque chose (ou une erreur).
                        if (!repo || (pulls.repoId === null && entry.pulls.length === 0 && !entry.error)) return null;
                        return (
                            <div key={entry.repoId} className="issues-group">
                                <div className="issues-group-head">
                                    <span>
                                        {repo.owner}/{repo.name}
                                    </span>
                                    <span className="muted">{entry.pulls.length}</span>
                                    {entry.error && (
                                        <span className="error" title={entry.error}>
                                            erreur GitHub
                                        </span>
                                    )}
                                </div>
                                {entry.pulls.map((pull) => (
                                    <PullRow
                                        key={pull.number}
                                        pull={pull}
                                        run={prRun(repo.id, pull.number)}
                                        selected={selected?.repoId === repo.id && selected.number === pull.number}
                                        onClick={() => setPulls({ selected: { repoId: repo.id, number: pull.number } })}
                                    />
                                ))}
                                {entry.pulls.length === 0 && !entry.error && <div className="muted pad">aucune PR</div>}
                            </div>
                        );
                    })}
                    {total === 0 && !pulls.loading && <div className="muted pad">{pulls.filter === 'review' ? 'Aucune review demandée.' : 'Rien à afficher.'}</div>}
                </div>
                {selected && (
                    <ResizablePane sizeKey="pulls-detail" className="issues-detail">
                        <div className="issues-detail-bar">
                            <span className="muted mono">{repoById.get(selected.repoId)?.name ?? ''}</span>
                            <span className="spacer" />
                            <button className="small" onClick={() => setPulls({ selected: null })} title="Fermer le détail">
                                ×
                            </button>
                        </div>
                        <PullDetailPane repoId={selected.repoId} number={selected.number} />
                    </ResizablePane>
                )}
            </div>
        </div>
    );
}


import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { ResizablePane } from '../ResizeHandle';
import { useStore } from '../../store';
import { BrunoButton } from '../BrunoButton';
import { GitMenu } from '../MergeIntegration';
import { Menu, MenuLabel } from '../Menu';
import { OpenMenu } from '../OpenMenu';
import { withProgress } from '../Progress';
import { ReviewSkillSelect } from './ReviewSkillSelect';
import { stateDot } from '../Tabs';
import { ViewSwitch, type ViewOption } from '../ViewSwitch';
import { timeAgo } from '../issues/IssueBody';
import { DetailBar, NoWorktreeMenu, RefreshButton, SearchField, matchesQuery, useListKeys } from '../issues/IssuesPage';
import { ChecksDot, PullInfo, decisionLabel } from './PullInfo';
import { openNewIntent } from '../NewIntentDialog';
import type { PullDetailResponse, PullFilter, PullSummary, Run } from '../../../../shared/protocol';

const FILTERS: Array<ViewOption<PullFilter>> = [
    { value: 'review', label: 'À relire', title: 'Reviews demandées' },
    { value: 'mine', label: 'Les miennes' },
    { value: 'all', label: 'Toutes', title: 'Toutes les PR ouvertes' },
];

const rowId = (repoId: number, number: number): string => `pull-row-${repoId}-${number}`;

function PullRow({ pull, repoId, run, selected, onClick }: { pull: PullSummary; repoId: number; run: Run | undefined; selected: boolean; onClick: () => void }): ReactElement {
    const decision = decisionLabel(pull.reviewDecision);
    return (
        <div id={rowId(repoId, pull.number)} role="option" aria-selected={selected} className={`issue-line pull-line ${selected ? 'selected' : ''}`}>
            <div className="issue-row" onClick={onClick}>
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
            </div>
        </div>
    );
}

/** Ouvre l'onglet de la PR (worktree, session), avec ou sans review par le skill du profil. */
function useOpenPull(): { busy: boolean; open: (repoId: number, number: number, review: boolean) => Promise<void> } {
    const upsertRun = useStore((s) => s.upsertRun);
    const setActive = useStore((s) => s.setActive);
    const [busy, setBusy] = useState(false);
    const open = async (repoId: number, number: number, review: boolean): Promise<void> => {
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
    return { busy, open };
}

function PullDetailPane({ repoId, number, live, busy, onOpen }: { repoId: number; number: number; live: Run | undefined; busy: boolean; onOpen: (review: boolean) => void }): ReactElement {
    const [detail, setDetail] = useState<PullDetailResponse | undefined>();
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
        // Navigation rapide au clavier : seule la dernière PR demandée s'affiche.
        let current = true;
        setDetail(undefined);
        setError(undefined);
        api.pull(repoId, number)
            .then((d) => current && setDetail(d))
            .catch((e: unknown) => current && setError(String(e)));
        return () => {
            current = false;
        };
    }, [repoId, number]);

    if (error) return <div className="error pad">{error}</div>;
    if (!detail) return <div className="muted pad">chargement de la PR #{number}…</div>;
    const archived = detail.runs.filter((r) => r.archived && r.type === 'pr');
    const { pull, worktree } = detail;

    const reviewButton = (primary: boolean): ReactElement => (
        <button className={primary ? 'primary' : ''} disabled={busy} onClick={() => onOpen(true)} title={`Worktree sur la branche de la PR, session Claude, et review par le skill du profil (rien n'est publié)${primary ? ' (Entrée depuis la liste)' : ''}`}>
            Review
        </button>
    );
    const skillMenu = (
        <Menu icon="settings" title="Skill de review du dépôt" closeOnClick={false} keepMounted>
            <MenuLabel>Skill de review du dépôt</MenuLabel>
            <div className="menu-row">
                <ReviewSkillSelect repoId={repoId} />
            </div>
        </Menu>
    );

    return (
        <PullInfo
            pull={pull}
            repoId={repoId}
            actions={
                <>
                    {live ? (
                        <>
                            <button className="primary" disabled={busy} onClick={() => onOpen(false)} title="Revenir à l'onglet de la PR (Entrée depuis la liste)">
                                Rouvrir l'onglet
                            </button>
                            {reviewButton(false)}
                            {skillMenu}
                        </>
                    ) : (
                        <>
                            {reviewButton(true)}
                            {skillMenu}
                            <button disabled={busy} onClick={() => onOpen(false)} title="Worktree sur la branche de la PR et un chat dedans, pour poser des questions sur le code">
                                {archived.length ? 'Reprendre le chat' : 'Chat sur la PR'}
                            </button>
                        </>
                    )}
                    <button disabled={busy} onClick={() => openNewIntent({ intent: 'investigation', repoId, prNumber: number })} title="Investiguer un problème lié à la PR (prod ou prelive), en lecture seule, dans son worktree s'il existe ; le rapport est publié sur son issue (sinon sur la PR)">
                        Investiguer
                    </button>
                    <span className="spacer" />
                    {!pull.isCrossRepository && pull.state === 'OPEN' && (
                        <GitMenu
                            repoId={repoId}
                            base={pull.baseRefName}
                            what={pull.headRefName}
                            mergeBase={() => api.mergeBaseFor(repoId, { prNumber: number })}
                            mergeIntegration={() => api.mergeIntegrationFor(repoId, { prNumber: number })}
                            {...(live ? { runId: live.id } : {})}
                        />
                    )}
                    {worktree ? (
                        <OpenMenu path={worktree.path}>
                            <BrunoButton repoId={repoId} path={worktree.path} />
                        </OpenMenu>
                    ) : (
                        <NoWorktreeMenu hint="créé par « Review » ou « Chat sur la PR »" />
                    )}
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
    const { busy, open } = useOpenPull();
    const [query, setQuery] = useState('');
    const pageRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

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

    const repoById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);
    const selected = pulls.selected;
    // Ma PR ouverte depuis une issue : son onglet d'implémentation (même branche) fait office d'onglet de la PR.
    const prRun = (repoId: number, number: number): Run | undefined => {
        const head = pulls.byRepo.find((e) => e.repoId === repoId)?.pulls.find((p) => p.number === number)?.headRefName;
        const own = head ? runs.find((r) => r.repoId === repoId && r.type === 'implement' && r.branch === head) : undefined;
        return own ?? runs.find((r) => r.repoId === repoId && r.prNumber === number && r.type === 'pr');
    };
    const total = pulls.byRepo.reduce((n, e) => n + e.pulls.length, 0);

    // Ce qui est affiché, dans l'ordre de l'écran : sert au rendu et à la navigation au clavier.
    const sections = useMemo(
        () =>
            pulls.byRepo.flatMap((entry) => {
                const repo = repoById.get(entry.repoId);
                const shown = query.trim() ? entry.pulls.filter((p) => matchesQuery(query, [`#${p.number}`, p.title, p.author, p.headRefName, ...p.labels.map((l) => l.name)])) : entry.pulls;
                // Vue « tous les dépôts » ou recherche : on n'affiche que les dépôts qui ont quelque chose (ou une erreur).
                if (!repo || ((pulls.repoId === null || query.trim()) && shown.length === 0 && !entry.error)) return [];
                return [{ entry, repo, shown }];
            }),
        [pulls.byRepo, pulls.repoId, repoById, query],
    );
    const order = useMemo(() => sections.flatMap(({ repo, shown }) => shown.map((p) => ({ repoId: repo.id, number: p.number }))), [sections]);
    const selectedIndex = selected ? order.findIndex((o) => o.repoId === selected.repoId && o.number === selected.number) : -1;

    useListKeys(pageRef, listRef, searchRef, {
        activeId: selected && selectedIndex !== -1 ? rowId(selected.repoId, selected.number) : undefined,
        move: (step) => {
            if (order.length === 0) return;
            const next = selectedIndex === -1 ? (step === 1 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, selectedIndex + step));
            const target = order[next];
            if (target && next !== selectedIndex) setPulls({ selected: target });
        },
        // Entrée met le focus sur l'action principale du détail (rouvrir l'onglet ou lancer la review) :
        // une seconde Entrée la déclenche, rien ne démarre par mégarde.
        primary: () => pageRef.current?.querySelector<HTMLButtonElement>('.issues-detail button.primary:not(:disabled)')?.focus(),
        close: () => setPulls({ selected: null }),
    });

    const selectedRepo = selected ? repoById.get(selected.repoId) : undefined;

    return (
        <div className="issues-page" ref={pageRef}>
            <div className="issues-toolbar list-toolbar">
                <select value={pulls.repoId ?? ''} onChange={(e) => setPulls({ repoId: e.target.value ? Number(e.target.value) : null, selected: null })} aria-label="Dépôt" title="Dépôt">
                    <option value="">Tous les dépôts</option>
                    {repos.map((repo) => (
                        <option key={repo.id} value={repo.id}>
                            {repo.owner}/{repo.name}
                        </option>
                    ))}
                </select>
                <ViewSwitch<PullFilter> label="Pull requests" value={pulls.filter} onChange={(filter) => setPulls({ filter })} options={FILTERS} />
                <SearchField value={query} onChange={setQuery} inputRef={searchRef} onLeave={() => listRef.current?.focus()} label="Filtrer les PR" />
                <RefreshButton loading={pulls.loading} onClick={() => void load(true)} />
                <span className="spacer" />
                {repos.length === 0 && (
                    <button className="link" onClick={() => setPage('repos')}>
                        Aucun dépôt GitHub actif : en ajouter
                    </button>
                )}
            </div>
            <div className="issues-body">
                <div
                    className="issues-list"
                    ref={listRef}
                    role="listbox"
                    tabIndex={0}
                    aria-label="Pull requests : j / k pour naviguer, Entrée pour la review ou l'onglet ouvert"
                    aria-activedescendant={selected && selectedIndex !== -1 ? rowId(selected.repoId, selected.number) : undefined}
                    aria-busy={pulls.loading}
                >
                    {sections.map(({ entry, repo, shown }) => (
                        <div key={entry.repoId} className="issues-group" role="group" aria-label={`${repo.owner}/${repo.name}`}>
                            <div className="issues-group-head">
                                <span>
                                    {repo.owner}/{repo.name}
                                </span>
                                <span className="muted">{shown.length === entry.pulls.length ? entry.pulls.length : `${shown.length} / ${entry.pulls.length}`}</span>
                                {entry.error && (
                                    <span className="error" title={entry.error}>
                                        erreur GitHub
                                    </span>
                                )}
                            </div>
                            {shown.map((pull) => (
                                <PullRow
                                    key={pull.number}
                                    pull={pull}
                                    repoId={repo.id}
                                    run={prRun(repo.id, pull.number)}
                                    selected={selected?.repoId === repo.id && selected.number === pull.number}
                                    onClick={() => setPulls({ selected: { repoId: repo.id, number: pull.number } })}
                                />
                            ))}
                            {entry.pulls.length === 0 && !entry.error && <div className="muted pad">aucune PR</div>}
                        </div>
                    ))}
                    {sections.length === 0 && !pulls.loading && (
                        <div className="muted list-empty">{query.trim() && total > 0 ? `Aucune PR chargée ne correspond à « ${query.trim()} ».` : pulls.filter === 'review' ? 'Aucune review demandée.' : 'Rien à afficher.'}</div>
                    )}
                </div>
                {selected && (
                    <ResizablePane sizeKey="pulls-detail" className="issues-detail">
                        <DetailBar repo={selectedRepo} url={selectedRepo ? `https://github.com/${selectedRepo.owner}/${selectedRepo.name}/pull/${selected.number}` : undefined} onClose={() => setPulls({ selected: null })} />
                        <PullDetailPane
                            repoId={selected.repoId}
                            number={selected.number}
                            live={prRun(selected.repoId, selected.number)}
                            busy={busy}
                            onOpen={(review) => void open(selected.repoId, selected.number, review)}
                        />
                    </ResizablePane>
                )}
            </div>
        </div>
    );
}

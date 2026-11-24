import '../../styles/lists.css';
import type { ReactElement, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { ResizablePane } from '../ResizeHandle';
import { useStore } from '../../store';
import { GitMenu } from '../MergeIntegration';
import { Icon } from '../Icon';
import { Menu } from '../Menu';
import { OpenMenu } from '../OpenMenu';
import { withProgress } from '../Progress';
import { stateDot } from '../Tabs';
import { ViewSwitch, type ViewOption } from '../ViewSwitch';
import { BrunoButton } from '../BrunoButton';
import { CleanupButton } from '../CleanupDialog';
import { BatchDialog } from './BatchDialog';
import { ExistingBranchDialog, openBranchChat } from './ExistingBranch';
import { IssueBody, labelStyle, timeAgo } from './IssueBody';
import type { BatchItem, ExistingBranch, Issue, IssueFilter, IssueState, Repo, Run } from '../../../../shared/protocol';
import { useUi } from '../../ui';
import { openNewIntent } from '../NewIntentDialog';

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

const FILTERS: Array<ViewOption<IssueFilter>> = [
    { value: 'assigned', label: 'Assignées', title: 'Assignées à moi' },
    { value: 'created', label: 'Créées', title: 'Créées par moi' },
    { value: 'all', label: 'Toutes', title: 'Toutes les issues des dépôts' },
];
const STATES: Array<ViewOption<IssueState>> = [
    { value: 'open', label: 'Ouvertes' },
    { value: 'closed', label: 'Fermées' },
    { value: 'all', label: 'Toutes', title: 'Ouvertes et fermées' },
];

/* ---------------------------------------------------------------------------------------------
   Morceaux communs aux pages Issues et Pull requests
   --------------------------------------------------------------------------------------------- */

/** Une ligne (issue, PR) correspond à la recherche si chaque mot apparaît dans l'un de ses textes. */
export function matchesQuery(query: string, texts: Array<string | null | undefined>): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const haystack = texts.filter(Boolean).join(' ').toLowerCase();
    return words.every((word) => haystack.includes(word));
}

/** Un champ de saisie a le focus : pas de raccourci d'une lettre. Une case à cocher n'en est pas un. */
function typing(el: HTMLElement): boolean {
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((el as HTMLInputElement).type);
}

export interface ListKeys {
    /** Sélection suivante (1) ou précédente (-1). */
    move: (step: 1 | -1) => void;
    /** Action principale de l'élément sélectionné. */
    primary: () => void;
    /** Ferme le détail. */
    close: () => void;
    /** Coche / décoche l'élément sélectionné (issues). */
    toggle?: () => void;
    /** Id DOM de la ligne sélectionnée, pour la faire défiler dans la vue. */
    activeId: string | undefined;
}

/**
 * Navigation au clavier d'une liste avec un panneau de détail : j / ↓ et k / ↑ changent la
 * sélection, Entrée lance l'action principale, Échap ferme le détail, x coche la ligne, / va à la
 * recherche. Seulement quand le focus est dans la page (ou nulle part), hors des champs, sans
 * modificateur et sans fenêtre modale ouverte. ↑ / ↓ restent au défilement dans le détail.
 */
export function useListKeys(page: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>, search: RefObject<HTMLInputElement | null>, keys: ListKeys): void {
    const latest = useRef(keys);
    latest.current = keys;

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
            const root = page.current;
            const target = e.target instanceof HTMLElement ? e.target : null;
            if (!root || !target || typing(target)) return;
            if (target !== document.body && !root.contains(target)) return;
            // Les pages sont dans le volet principal : si un autre volet a le focus, ses touches sont à lui.
            if (useUi.getState().focusedPane !== 0) return;
            // Fenêtre, palette ou chargement par-dessus : les touches sont à eux.
            if (document.querySelector('[aria-modal="true"], [role="dialog"], [role="alertdialog"]')) return;
            const k = latest.current;
            // `/` demande Maj sur un clavier AZERTY : seul raccourci qui l'accepte.
            if (e.key === '/') {
                e.preventDefault();
                search.current?.focus();
                return;
            }
            if (e.shiftKey) return;
            const inDetail = target.closest('.issues-detail') !== null;
            // Entrée ne vaut que dans la liste : pas après un clic dans le texte du détail.
            const onList = target === list.current || target.closest('[role="option"]') !== null;
            const step = e.key === 'j' || (e.key === 'ArrowDown' && !inDetail) ? 1 : e.key === 'k' || (e.key === 'ArrowUp' && !inDetail) ? -1 : 0;
            if (step !== 0) {
                e.preventDefault();
                k.move(step);
                // Sans focus, la liste le prend : Entrée enchaîne sur l'action principale.
                if (target === document.body) list.current?.focus({ preventScroll: true });
            } else if (e.key === 'Enter' && onList) {
                e.preventDefault();
                k.primary();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                k.close();
                list.current?.focus({ preventScroll: true });
            } else if (e.key === 'x' && k.toggle) {
                e.preventDefault();
                k.toggle();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [page, list, search]);

    // La ligne sélectionnée défile dans la vue, une fois par sélection (et dès qu'elle est rendue).
    const scrolled = useRef<string | undefined>(undefined);
    useEffect(() => {
        const id = keys.activeId;
        if (!id) {
            scrolled.current = undefined;
            return;
        }
        if (scrolled.current === id) return;
        const row = document.getElementById(id);
        if (!row) return;
        row.scrollIntoView({ block: 'nearest' });
        scrolled.current = id;
    });
}

/** Recherche locale dans la liste chargée. ↓ ou Entrée passent à la liste ; Échap vide puis sort. */
export function SearchField({ value, onChange, inputRef, onLeave, label }: { value: string; onChange: (value: string) => void; inputRef: RefObject<HTMLInputElement | null>; onLeave: () => void; label: string }): ReactElement {
    return (
        <span className="list-search">
            <Icon name="search" size={14} />
            <input
                ref={inputRef}
                type="search"
                value={value}
                placeholder="Filtrer…"
                aria-label={label}
                title={`${label} (raccourci /). Ne cherche que dans ce qui est chargé.`}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape' && value) {
                        e.preventDefault();
                        onChange('');
                    } else if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        onLeave();
                    }
                }}
            />
        </span>
    );
}

export function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }): ReactElement {
    return (
        <button className={`icon-button list-refresh ${loading ? 'loading' : ''}`} onClick={onClick} disabled={loading} title={loading ? 'Chargement…' : 'Recharger depuis GitHub'} aria-label="Recharger depuis GitHub">
            <Icon name="refresh" size={15} />
        </button>
    );
}

/** Barre du détail : dépôt, lien GitHub, fermeture (Échap). */
export function DetailBar({ repo, url, onClose }: { repo: Repo | undefined; url: string | undefined; onClose: () => void }): ReactElement {
    return (
        <div className="issues-detail-bar">
            <span className="muted mono">{repo ? `${repo.owner}/${repo.name}` : ''}</span>
            <span className="spacer" />
            {url && (
                <a className="icon-button" href={url} target="_blank" rel="noreferrer" title="Ouvrir sur GitHub" aria-label="Ouvrir sur GitHub">
                    <Icon name="external" size={14} />
                </a>
            )}
            <button className="icon-button" onClick={onClose} title="Fermer le détail (Échap)" aria-label="Fermer le détail">
                <Icon name="x" size={14} />
            </button>
        </div>
    );
}

/** Pas de worktree : le menu « Ouvrir » reste à sa place, désactivé, pour dire ce qui le crée. */
export function NoWorktreeMenu({ hint }: { hint: string }): ReactElement {
    return (
        <Menu label="Ouvrir" icon="external" title={`Pas encore de worktree : ${hint}`} disabled>
            {null}
        </Menu>
    );
}

/* --------------------------------------------------------------------------------------------- */

const rowId = (repoId: number, number: number): string => `issue-row-${repoId}-${number}`;

function IssueRow({ issue, repoId, run, waiting, selected, checked, onCheck, onClick }: { issue: Issue; repoId: number; run: Run | undefined; waiting: BatchItem | undefined; selected: boolean; checked: boolean; onCheck: (checked: boolean) => void; onClick: () => void }): ReactElement {
    return (
        <div id={rowId(repoId, issue.number)} role="option" aria-selected={selected} className={`issue-line ${selected ? 'selected' : ''} ${checked ? 'checked' : ''}`}>
            <input
                type="checkbox"
                className="issue-check"
                tabIndex={-1}
                checked={checked}
                onChange={(e) => onCheck(e.target.checked)}
                aria-label={`Cocher l'issue #${issue.number}`}
                title="Sélectionner pour implémenter plusieurs issues en même temps (x au clavier)"
            />
            <div className="issue-row" onClick={onClick}>
                <span className={`badge ${issue.state === 'OPEN' ? 'open' : 'closed'}`} title={issue.state === 'OPEN' ? 'ouverte' : 'fermée'} />
                <span className="issue-row-number">#{issue.number}</span>
                <span className="issue-row-title">
                    {waiting && (
                        <span className={`batch-tag ${waiting.state}`} title={waiting.detail}>
                            {waiting.state === 'waiting' ? `◷ ${waiting.detail}` : '✗ lancement en échec'}
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
            </div>
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
            <span>{waiting ? `◷ Lot : ${item.detail}` : `✗ Lancement en échec : ${item.detail}`}</span>
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
    const [query, setQuery] = useState('');
    const batch = useStore((s) => s.batch);
    const checked = issues.checked;
    const pageRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

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

    /** Une branche déjà travaillée est signalée d'abord ; `force` relance l'implémentation dessus. */
    const implement = async (repoId: number, number: number, force = false): Promise<void> => {
        setBusy(true);
        try {
            if (!force) {
                const { branch } = await api.existingBranch(repoId, number);
                if (branch) {
                    setExisting({ repoId, number, branch });
                    return;
                }
            }
            const run = await withProgress(`Implémentation de l'issue #${number}`, (opId) => api.implement(repoId, number, planMode, opId));
            upsertRun(run);
            setActive(run.id);
        } catch (error) {
            // Une erreur du lancement reste affichée dans le loader ; celle de la vérification, en notification.
            if (!useStore.getState().progress) notify(String(error));
        } finally {
            setBusy(false);
        }
    };

    const [existing, setExisting] = useState<{ repoId: number; number: number; branch: ExistingBranch } | null>(null);

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
    const repoById = useMemo(() => new Map(repos.map((r) => [r.id, r])), [repos]);

    // Ce qui est affiché, dans l'ordre de l'écran : sert au rendu et à la navigation au clavier.
    const sections = useMemo(
        () =>
            issues.byRepo.flatMap((entry) => {
                const repo = repoById.get(entry.repoId);
                if (!repo) return [];
                const shown = query.trim() ? entry.issues.filter((i) => matchesQuery(query, [`#${i.number}`, i.title, i.author, i.status?.name, ...i.assignees, ...i.labels.map((l) => l.name)])) : entry.issues;
                // Une recherche masque les dépôts où rien ne correspond.
                if (query.trim() && shown.length === 0 && !entry.error) return [];
                return [{ entry, repo, shown, groups: groupByStatus(shown) }];
            }),
        [issues.byRepo, repoById, query],
    );
    const order = useMemo(() => sections.flatMap(({ repo, groups }) => groups.flatMap((g) => g.issues.map((i) => ({ repoId: repo.id, number: i.number })))), [sections]);
    const selectedIndex = selected ? order.findIndex((o) => o.repoId === selected.repoId && o.number === selected.number) : -1;

    useListKeys(pageRef, listRef, searchRef, {
        activeId: selected && selectedIndex !== -1 ? rowId(selected.repoId, selected.number) : undefined,
        move: (step) => {
            if (order.length === 0) return;
            const next = selectedIndex === -1 ? (step === 1 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, selectedIndex + step));
            const target = order[next];
            if (target && next !== selectedIndex) setIssues({ selected: target });
        },
        // Entrée ne lance rien d'office (une implémentation démarre une session Claude) : elle met le
        // focus sur l'action principale du détail, qu'une seconde Entrée déclenche.
        primary: () => pageRef.current?.querySelector<HTMLButtonElement>('.issues-detail button.primary:not(:disabled)')?.focus(),
        close: () => setIssues({ selected: null }),
        toggle: () => {
            if (!selected || selectedIndex === -1) return;
            const on = checked?.repoId === selected.repoId && checked.numbers.includes(selected.number);
            check(selected.repoId, [selected.number], !on);
        },
    });

    const selectedRepo = selected ? repoById.get(selected.repoId) : undefined;

    return (
        <div className="issues-page" ref={pageRef}>
            <div className="issues-toolbar list-toolbar">
                <select value={issues.repoId ?? ''} onChange={(e) => setIssues({ repoId: e.target.value ? Number(e.target.value) : null, selected: null })} aria-label="Dépôt" title="Dépôt">
                    <option value="">Tous les dépôts</option>
                    {repos.map((repo) => (
                        <option key={repo.id} value={repo.id}>
                            {repo.owner}/{repo.name}
                        </option>
                    ))}
                </select>
                <ViewSwitch<IssueFilter> label="Issues" value={issues.filter} onChange={(filter) => setIssues({ filter })} options={FILTERS} />
                <ViewSwitch<IssueState> label="État" value={issues.state} onChange={(state) => setIssues({ state })} options={STATES} />
                <SearchField value={query} onChange={setQuery} inputRef={searchRef} onLeave={() => listRef.current?.focus()} label="Filtrer les issues" />
                <RefreshButton loading={issues.loading} onClick={() => void load(true)} />
                <span className="spacer" />
                {checked && (
                    <div className="batch-bar">
                        <span>
                            {checked.numbers.length} issue{checked.numbers.length > 1 ? 's' : ''} cochée{checked.numbers.length > 1 ? 's' : ''}
                            <span className="muted"> · {repoById.get(checked.repoId)?.name ?? ''}</span>
                        </span>
                        <button className="primary small" onClick={() => setBatchOpen(true)} title="Voir les dépendances puis lancer les implémentations en parallèle">
                            Implémenter…
                        </button>
                        <button className="icon-button" onClick={() => setIssues({ checked: null })} title="Vider la sélection" aria-label="Vider la sélection">
                            <Icon name="x" size={14} />
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
                <div
                    className="issues-list"
                    ref={listRef}
                    role="listbox"
                    tabIndex={0}
                    aria-label="Issues : j / k pour naviguer, Entrée pour implémenter, x pour cocher"
                    aria-activedescendant={selected && selectedIndex !== -1 ? rowId(selected.repoId, selected.number) : undefined}
                    aria-busy={issues.loading}
                >
                    {sections.map(({ entry, repo, shown, groups }) => (
                        <div key={entry.repoId} className="issues-group" role="group" aria-label={`${repo.owner}/${repo.name}`}>
                            <div className="issues-group-head">
                                <span>
                                    {repo.owner}/{repo.name}
                                </span>
                                <span className="muted">{shown.length === entry.issues.length ? entry.issues.length : `${shown.length} / ${entry.issues.length}`}</span>
                                {entry.error && (
                                    <span className="error" title={entry.error}>
                                        erreur GitHub
                                    </span>
                                )}
                                <span className="spacer" />
                                <CleanupButton repo={repo} />
                            </div>
                            {groups.map((group) => (
                                <div key={group.key} className="issues-status">
                                    {group.name !== null ? (
                                        <div className="issues-status-head">
                                            <span>{group.name}</span>
                                            <span className="muted">{group.issues.length}</span>
                                        </div>
                                    ) : (
                                        // Pas de sous-titre quand aucune issue du dépôt n'a de statut.
                                        shown.some((i) => i.status !== null) && (
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
                                            repoId={repo.id}
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
                    ))}
                    {sections.length === 0 && !issues.loading && <div className="muted list-empty">{query.trim() && issues.byRepo.length > 0 ? `Aucune issue chargée ne correspond à « ${query.trim()} ».` : 'Rien à afficher.'}</div>}
                </div>
                {selected && (
                    <ResizablePane sizeKey="issues-detail" className="issues-detail">
                        <DetailBar repo={selectedRepo} url={selectedRepo ? `https://github.com/${selectedRepo.owner}/${selectedRepo.name}/issues/${selected.number}` : undefined} onClose={() => setIssues({ selected: null })} />
                        <IssueBody
                            repoId={selected.repoId}
                            number={selected.number}
                            onSelect={(number) => setIssues({ selected: { repoId: selected.repoId, number } })}
                            actions={({ issue, worktree }) => {
                                const run = implementRun(selected.repoId, issue.number);
                                // Les sous-issues d'autres dépôts se lancent à la main, dans leur dépôt.
                                const openSubs = issue.subIssues.filter((sub) => sub.state === 'OPEN' && !sub.otherRepo).map((sub) => sub.number);
                                const elsewhere = issue.subIssues.filter((sub) => sub.state === 'OPEN' && sub.otherRepo).length;
                                const what = `la branche de l'issue #${issue.number}`;
                                const hasBranch = Boolean(worktree?.branch) || issue.linkedBranches.length > 0 || issue.pullRequests.some((pr) => pr.state === 'OPEN') || run !== undefined;
                                return (
                                    <>
                                        <WaitingBlock item={waitingItem(selected.repoId, issue.number)} busy={busy} onStart={() => void startWaiting(selected.repoId, issue.number)} />
                                        <button className="primary" disabled={busy} onClick={() => void implement(selected.repoId, issue.number)} title={`${run ? "Revenir à l'onglet d'implémentation" : 'Branche liée, worktree, et session Claude qui implémente'} (Entrée depuis la liste, puis Entrée)`}>
                                            {run ? 'Rouvrir l\'implémentation' : 'Implémenter'}
                                        </button>
                                        {!run && (
                                            <label className="muted check" title="Claude propose un plan avant de modifier le code">
                                                <input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} /> plan d'abord
                                            </label>
                                        )}
                                        <button disabled={busy} onClick={() => void chat(selected.repoId, issue.number)} title="Un chat dans le checkout principal, avec l'issue en brouillon de prompt">
                                            Chat
                                        </button>
                                        <button disabled={busy} onClick={() => openNewIntent({ intent: 'investigation', repoId: selected.repoId, issueNumber: issue.number })} title="Investiguer un problème lié à l'issue (prod ou prelive), en lecture seule, dans son worktree s'il existe ; le rapport est publié sur l'issue">
                                            Investiguer
                                        </button>
                                        {openSubs.length > 0 && (
                                            <button
                                                disabled={busy}
                                                onClick={() => {
                                                    setIssues({ checked: { repoId: selected.repoId, numbers: openSubs } });
                                                    setBatchOpen(true);
                                                }}
                                                title={`Coche les sous-issues ouvertes et ouvre le lancement en lot (dépendances, PR empilées)${elsewhere ? `. ${elsewhere} autre${elsewhere > 1 ? 's sont' : ' est'} dans d'autres dépôts : à lancer à la main, depuis leur dépôt` : ''}`}
                                            >
                                                Implémenter les sous-issues ({openSubs.length})…
                                            </button>
                                        )}
                                        <span className="spacer" />
                                        {hasBranch && (
                                            <GitMenu
                                                repoId={selected.repoId}
                                                what={what}
                                                mergeBase={() => api.mergeBaseFor(selected.repoId, { issueNumber: issue.number })}
                                                mergeIntegration={() => api.mergeIntegrationFor(selected.repoId, { issueNumber: issue.number })}
                                                {...(run ? { runId: run.id } : {})}
                                            />
                                        )}
                                        {worktree ? (
                                            <OpenMenu path={worktree.path}>
                                                <BrunoButton repoId={selected.repoId} path={worktree.path} />
                                            </OpenMenu>
                                        ) : (
                                            <NoWorktreeMenu hint="« Implémenter » le crée" />
                                        )}
                                    </>
                                );
                            }}
                        />
                    </ResizablePane>
                )}
            </div>
            {existing && (
                <ExistingBranchDialog
                    number={existing.number}
                    branch={existing.branch}
                    onClose={() => setExisting(null)}
                    onImplement={() => {
                        setExisting(null);
                        void implement(existing.repoId, existing.number, true);
                    }}
                    onChat={() => {
                        setExisting(null);
                        void openBranchChat(existing.repoId, existing.number).catch(() => undefined);
                    }}
                />
            )}
            {batchOpen && checked && (
                <BatchDialog
                    repoId={checked.repoId}
                    numbers={checked.numbers}
                    onAdd={(number) => check(checked.repoId, [number], true)}
                    onOpenParent={(_parent, subs) => setIssues({ checked: { repoId: checked.repoId, numbers: subs } })}
                    onClose={() => setBatchOpen(false)}
                />
            )}
        </div>
    );
}

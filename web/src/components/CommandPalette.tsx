import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore, type Page } from '../store';
import { send } from '../ws';
import { MOD, openToRight, showRun, useUi } from '../ui';
import { Icon, type IconName } from './Icon';
import { RUN_ICON, STATE_LABEL, orderedRuns, repoLabel, repoName, runMeta } from './Tabs';
import { timeAgo } from './Usage';
import type { Repo, SessionHistoryItem } from '../../../shared/protocol';

interface Item {
    id: string;
    group: string;
    label: string;
    detail?: string;
    icon: IconName;
    /** Texte cherché en plus du libellé et du détail. */
    keywords?: string;
    run: () => void | Promise<void>;
    /** ⌘↵ : ouvrir à côté au lieu de remplacer le volet qui a le focus. */
    split?: () => void | Promise<void>;
}

/** Sessions Claude Code par dépôt, relues au plus toutes les 2 minutes. */
const sessionCache = new Map<number, { at: number; items: SessionHistoryItem[] }>();

function useSessions(repos: Repo[], open: boolean): Array<{ repo: Repo; session: SessionHistoryItem }> {
    const [, setVersion] = useState(0);
    useEffect(() => {
        if (!open) return;
        let live = true;
        for (const repo of repos) {
            const cached = sessionCache.get(repo.id);
            if (cached && Date.now() - cached.at < 120_000) continue;
            api.repoSessions(repo.id)
                .then((items) => {
                    sessionCache.set(repo.id, { at: Date.now(), items });
                    if (live) setVersion((v) => v + 1);
                })
                .catch(() => undefined);
        }
        return () => {
            live = false;
        };
    }, [repos, open]);
    return repos
        .flatMap((repo) => (sessionCache.get(repo.id)?.items ?? []).map((session) => ({ repo, session })))
        .sort((a, b) => b.session.lastModified - a.session.lastModified);
}

function normalize(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function sessionTitle(session: SessionHistoryItem): string {
    return session.customTitle ?? session.summary ?? session.firstPrompt ?? session.sessionId;
}

const PAGES: Array<{ page: Page; label: string; icon: IconName }> = [
    { page: 'issues', label: 'Issues', icon: 'issue' },
    { page: 'pulls', label: 'Pull requests', icon: 'pr' },
    { page: 'specs', label: 'Specs', icon: 'spec' },
    { page: 'repos', label: 'Dépôts et réglages', icon: 'settings' },
];

/**
 * Palette de commandes (⌘K) : aller à un onglet ou une page, lancer un chat, reprendre une ancienne
 * session Claude Code d'un dépôt, et les actions d'interface. Tout au clavier.
 */
export function CommandPalette(): ReactElement | null {
    const open = useUi((s) => s.palette);
    const setPalette = useUi((s) => s.setPalette);
    const toggleRail = useUi((s) => s.toggleRail);
    const setShortcuts = useUi((s) => s.setShortcuts);
    const runs = useStore((s) => s.runs);
    const allRepos = useStore((s) => s.repos);
    const setPage = useStore((s) => s.setPage);
    const upsertRun = useStore((s) => s.upsertRun);
    const notify = useStore((s) => s.notify);
    const repos = useMemo(() => allRepos.filter((r) => r.enabled), [allRepos]);
    const sessions = useSessions(repos, open);
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        setQuery('');
        setCursor(0);
        input.current?.focus();
    }, [open]);

    const items = useMemo((): Item[] => {
        const tabs: Item[] = orderedRuns(runs, allRepos).map((run) => ({
            id: `run-${run.id}`,
            group: 'Onglets ouverts',
            label: run.title,
            detail: `${repoName(run, allRepos)} · ${runMeta(run)} · ${STATE_LABEL[run.state]}`,
            icon: RUN_ICON[run.type],
            keywords: run.cwd,
            run: () => showRun(run.id),
            split: () => openToRight(run.id),
        }));
        const pages: Item[] = PAGES.map((p) => ({ id: `page-${p.page}`, group: 'Aller à', label: p.label, icon: p.icon, run: () => setPage(p.page) }));
        const chats: Item[] = repos.map((repo) => ({
            id: `new-${repo.id}`,
            group: 'Nouveau chat',
            label: `Nouveau chat dans ${repoLabel(repo)}`,
            icon: 'plus',
            keywords: repo.path,
            run: async () => {
                const run = await api.createRun({ repoId: repo.id });
                upsertRun(run);
                showRun(run.id);
            },
        }));
        const history: Item[] = sessions.map(({ repo, session }) => ({
            id: `session-${repo.id}-${session.sessionId}`,
            group: 'Reprendre une session',
            label: sessionTitle(session),
            detail: `${repoLabel(repo, false)}${session.gitBranch ? ` · ${session.gitBranch}` : ''} · ${timeAgo(session.lastModified)}`,
            icon: 'history',
            keywords: `${session.firstPrompt ?? ''} ${session.summary}`,
            run: async () => {
                // Session déjà ouverte dans un onglet : on y va plutôt que d'en lancer une seconde.
                const existing = runs.find((r) => r.sessionId === session.sessionId);
                if (existing) return showRun(existing.id);
                const title = sessionTitle(session).slice(0, 40);
                const run = await api.createRun({ repoId: repo.id, cwd: session.cwd ?? repo.path, sessionId: session.sessionId, title });
                upsertRun(run);
                showRun(run.id);
            },
        }));
        const actions: Item[] = [
            { id: 'rail', group: 'Interface', label: 'Replier / déplier le rail', detail: `${MOD}B`, icon: 'sidebar', run: toggleRail },
            { id: 'keys', group: 'Interface', label: 'Raccourcis clavier', detail: '?', icon: 'keyboard', run: () => setShortcuts(true) },
            { id: 'usage', group: 'Interface', label: 'Relire la consommation du compte', icon: 'gauge', run: () => send({ type: 'refreshAccount' }) },
        ];

        const needle = normalize(query.trim());
        if (!needle) return [...tabs, ...pages, ...chats, ...history.slice(0, 8), ...actions];
        const words = needle.split(/\s+/);
        const all = [...tabs, ...pages, ...chats, ...history, ...actions];
        // Les groupes gardent leur ordre ; la pertinence ne trie qu'à l'intérieur d'un groupe.
        const groupOrder = [...new Set(all.map((item) => item.group))];
        return all
            .map((item) => {
                const label = normalize(item.label);
                const hay = `${label} ${normalize(item.detail ?? '')} ${normalize(item.keywords ?? '')}`;
                if (!words.every((w) => hay.includes(w))) return null;
                const score = label.startsWith(needle) ? 0 : label.includes(needle) ? 1 : 2;
                return { item, score };
            })
            .filter((x): x is { item: Item; score: number } => x !== null)
            .sort((a, b) => groupOrder.indexOf(a.item.group) - groupOrder.indexOf(b.item.group) || a.score - b.score)
            .slice(0, 60)
            .map((x) => x.item);
    }, [runs, allRepos, repos, sessions, query, setPage, upsertRun, toggleRail, setShortcuts]);

    useEffect(() => setCursor(0), [query]);
    useEffect(() => {
        list.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [cursor]);

    if (!open) return null;

    const choose = async (item: Item | undefined, aside = false): Promise<void> => {
        if (!item) return;
        setPalette(false);
        try {
            await (aside && item.split ? item.split() : item.run());
        } catch (error) {
            notify(String(error));
        }
    };

    const onKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, items.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            void choose(items[cursor], e.metaKey || e.ctrlKey);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setPalette(false);
        }
    };

    let lastGroup = '';
    return (
        <div className="palette-backdrop" onMouseDown={() => setPalette(false)}>
            <div className="palette" role="dialog" aria-label="Palette de commandes" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
                <div className="palette-input">
                    <Icon name="search" />
                    <input
                        ref={input}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Onglet, page, dépôt, ancienne session…"
                        aria-label="Rechercher"
                        aria-controls="palette-list"
                        aria-activedescendant={items[cursor] ? `palette-${items[cursor].id}` : undefined}
                    />
                    <kbd>Échap</kbd>
                </div>
                <div className="palette-list" id="palette-list" role="listbox" ref={list}>
                    {items.length === 0 && <div className="muted palette-empty">Rien ne correspond à « {query} ».</div>}
                    {items.map((item, i) => {
                        const head = item.group !== lastGroup ? item.group : null;
                        lastGroup = item.group;
                        return (
                            <div key={item.id}>
                                {head && <div className="palette-group">{head}</div>}
                                <div
                                    id={`palette-${item.id}`}
                                    data-index={i}
                                    role="option"
                                    aria-selected={i === cursor}
                                    className={`palette-item ${i === cursor ? 'active' : ''}`}
                                    onMouseMove={() => i !== cursor && setCursor(i)}
                                    onClick={(e) => void choose(item, e.metaKey || e.ctrlKey || e.altKey)}
                                >
                                    <Icon name={item.icon} size={15} />
                                    <span className="palette-label">{item.label}</span>
                                    {item.detail && <span className="palette-detail">{item.detail}</span>}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div className="palette-foot muted">
                    <span>
                        <kbd>↑</kbd>
                        <kbd>↓</kbd> naviguer
                    </span>
                    <span>
                        <kbd>↵</kbd> ouvrir
                    </span>
                    <span>
                        <kbd>{MOD}</kbd>
                        <kbd>↵</kbd> ouvrir à côté
                    </span>
                    <span>
                        <kbd>Échap</kbd> fermer
                    </span>
                </div>
            </div>
        </div>
    );
}

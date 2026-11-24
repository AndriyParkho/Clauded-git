import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { api, type Profile } from '../api';
import { useStore, type Page, type Panel } from '../store';
import { send } from '../ws';
import { MOD, openToRight, paneRun, showRun, useUi } from '../ui';
import { Icon, type IconName } from './Icon';
import { runIcon, STATE_LABEL, orderedRuns, repoLabel, repoName, runMeta } from './Tabs';
import { timeAgo } from './Usage';
import { openNewIntent } from './NewIntentDialog';
import { repoRunPanels } from './run/panels';
import { EFFORTS, effortChoices } from './chat/StatusBar';
import type { JobInfo, ModelChoice, OpenApp, Repo, Run, SessionHistoryItem } from '../../../shared/protocol';

interface Item {
    id: string;
    group: string;
    label: string;
    detail?: string;
    icon: IconName;
    /** Texte cherché en plus du libellé et du détail. */
    keywords?: string;
    /** Onglet concerné : ses erreurs y sont rattachées. */
    runId?: number;
    run: () => void | Promise<void>;
    /** ⌘↵ : ouvrir à côté au lieu de remplacer le volet qui a le focus. */
    split?: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Actions de l'onglet affiché dans le volet qui a le focus
// ---------------------------------------------------------------------------------------------

/**
 * Dernier profil connu de chaque dépôt, affiché tout de suite ; relu à chaque ouverture de la palette
 * (api.ts le garde une minute), pour qu'une modification dans les réglages y apparaisse.
 */
const profileCache = new Map<number, Profile>();
const profileLoading = new Map<number, Promise<Profile>>();

/** Profil du dépôt (`undefined` tant qu'il n'est pas arrivé : la palette s'affiche sans l'attendre). */
function useRepoProfile(repoId: number | null, open: boolean, runId: number | undefined): Profile | undefined {
    const [, setVersion] = useState(0);
    useEffect(() => {
        if (!open || repoId === null) return;
        let pending = profileLoading.get(repoId);
        if (!pending) {
            pending = api.profile(repoId).then((r) => {
                profileCache.set(repoId, r.profile);
                return r.profile;
            });
            // En échec, on retentera à la prochaine ouverture.
            void pending.finally(() => profileLoading.delete(repoId)).catch(() => undefined);
            profileLoading.set(repoId, pending);
        }
        let live = true;
        pending.then(
            () => live && setVersion((v) => v + 1),
            (error: unknown) => live && useStore.getState().notify(String(error), runId),
        );
        return () => {
            live = false;
        };
    }, [repoId, open, runId]);
    return repoId === null ? undefined : profileCache.get(repoId);
}

const FALLBACK_MODELS: ModelChoice[] = [
    { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: '' },
    { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' },
    { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: '' },
    { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: '' },
];
const MODES: Array<{ value: PermissionMode; label: string }> = [
    { value: 'default', label: "normal (tout accepté par l'app)" },
    { value: 'acceptEdits', label: 'éditions acceptées' },
    { value: 'plan', label: 'plan mode' },
    { value: 'bypassPermissions', label: 'bypass' },
];
const APPS: Array<{ value: OpenApp; label: string; keywords: string }> = [
    { value: 'vscode', label: 'VS Code', keywords: 'vscode code editeur' },
    { value: 'finder', label: 'Finder', keywords: 'finder dossier' },
    { value: 'terminal', label: 'Terminal', keywords: 'terminal shell' },
    { value: 'iterm', label: 'iTerm', keywords: 'iterm terminal shell' },
];

/** Panneaux latéraux de chaque type d'onglet (voir RepoRunView et SpecView). */
function runPanels(run: Run): Array<{ panel: Panel; label: string; icon: IconName; keywords?: string }> {
    if (run.type === 'spec') {
        return [
            { panel: 'spec', label: 'Afficher la spec', icon: 'spec' },
            { panel: 'versions', label: 'Afficher les versions de la spec', icon: 'history', keywords: 'historique' },
            { panel: 'plan', label: 'Afficher le découpage en issues', icon: 'issue', keywords: 'plan' },
        ];
    }
    return run.repoId !== null ? repoRunPanels(run) : [];
}

/** Ce que les merges de l'onglet touchent (`null` : pas de merge pour ce type d'onglet). */
function mergeTarget(run: Run): string | null {
    if (run.repoId === null) return null;
    if (run.type === 'implement') return run.branch ?? 'la branche';
    if (run.type === 'pr') return run.branch ?? `la branche de la PR #${run.prNumber ?? '?'}`;
    if (run.type === 'chat' && run.issueNumber !== null) return `la branche de l'issue #${run.issueNumber}`;
    if (run.type === 'chat' && run.prNumber !== null) return `la branche de la PR #${run.prNumber}`;
    if (run.type === 'chat') return 'la branche du dossier';
    return null;
}

/** Projet où lancer les commandes : celui choisi dans le menu Commandes, sinon celui proposé. */
async function commandProject(runId: number): Promise<string> {
    try {
        const raw = localStorage.getItem(`clauded.project.${runId}`);
        const chosen: unknown = raw === null ? null : JSON.parse(raw);
        if (typeof chosen === 'string') return chosen;
    } catch {
        // stockage illisible : on prend le projet proposé
    }
    return api
        .projects(runId)
        .then((info) => info.suggested)
        .catch(() => '.');
}

/** Lance un merge et le suit dans le store, comme le menu Git (pastille, sortie, résolution). */
async function startMerge(run: Run, confirm: string, start: () => Promise<JobInfo>, hasJobs: boolean): Promise<void> {
    if (!window.confirm(confirm)) return;
    if (hasJobs) useStore.getState().setPanel(run.id, 'jobs');
    const started = await start();
    useStore.setState((s) => ({ jobs: { ...s.jobs, [started.id]: s.jobs[started.id] ?? started } }));
}

/**
 * Actions sur l'onglet `run` : panneaux, commandes du profil, merges, ouverture du dossier, modèle,
 * mode de permission, interruption, reprise dans un terminal. `featured` : les plus utiles, montrées
 * sans recherche.
 */
function runActions(run: Run, profile: Profile | undefined, models: ModelChoice[] | undefined): { all: Item[]; featured: Item[] } {
    const group = `Onglet : ${run.title}`;
    const item = (id: string, rest: Omit<Item, 'id' | 'group' | 'runId'>): Item => ({ id: `tab-${run.id}-${id}`, group, runId: run.id, ...rest });
    const setPanel = (panel: Panel): void => useStore.getState().setPanel(run.id, panel);
    const panels = runPanels(run);
    const hasJobs = panels.some((p) => p.panel === 'jobs');

    const interrupt: Item[] =
        run.state === 'running' ? [item('interrupt', { label: 'Interrompre Claude', icon: 'x', keywords: 'stop arreter interrupt', run: () => send({ type: 'interrupt', runId: run.id }) })] : [];

    const panelItems = panels.map((p) => item(`panel-${p.panel}`, { label: p.label, icon: p.icon, keywords: `panneau ${p.keywords ?? ''}`, run: () => setPanel(p.panel) }));

    // Commandes du profil : seulement dans les onglets à worktree (ceux qui ont des logs).
    const launch = (action: () => Promise<JobInfo>) => async (): Promise<void> => {
        setPanel('jobs');
        await action();
    };
    const commandItems: Item[] = hasJobs && profile ? Object.entries(profile.commands).map(([name, command]) => item(`cmd-${name}`, { label: `Lancer ${name}`, detail: command, icon: 'play', keywords: 'commande', run: launch(async () => api.command(run.id, name, await commandProject(run.id))) })) : [];
    const installItems: Item[] = hasJobs && profile?.install ? [item('install', { label: "Lancer l'install", detail: profile.install, icon: 'play', keywords: 'install dependances commande', run: launch(() => api.install(run.id)) })] : [];

    const merges: Item[] = [];
    const what = mergeTarget(run);
    if (what !== null) {
        const base = run.baseBranch ?? profile?.baseBranch;
        if (base) {
            merges.push(
                item('merge-base', {
                    label: `Merge ${base}`,
                    detail: `origin/${base} dans ${what}`,
                    icon: 'merge',
                    keywords: 'git merge base',
                    run: () => startMerge(run, `Merger origin/${base} dans ${what} et la pousser ?`, () => api.mergeBase(run.id), hasJobs),
                }),
            );
        }
        const integration = profile?.integrationBranch;
        if (integration) {
            merges.push(
                item('merge-integration', {
                    label: `Merge → ${integration}`,
                    detail: `${what} dans ${integration}`,
                    icon: 'merge',
                    keywords: 'git merge integration',
                    run: () => startMerge(run, `Merger ${what} dans ${integration} et pousser ${integration} ?`, () => api.mergeIntegration(run.id), hasJobs),
                }),
            );
        }
    }

    const path = run.worktree ?? run.cwd;
    const openItems = APPS.map((app) =>
        item(`open-${app.value}`, {
            label: `Ouvrir dans ${app.label}`,
            detail: path.replace(/^\/Users\/[^/]+/, '~'),
            icon: 'external',
            keywords: `${app.keywords} dossier worktree`,
            run: async () => {
                await api.openIn(path, app.value);
            },
        }),
    );

    const choices = models && models.length > 0 ? models : FALLBACK_MODELS;
    const modelList = run.model && !choices.some((m) => m.value === run.model) ? [{ value: run.model, displayName: run.model, description: '' }, ...choices] : choices;
    const modelItems = modelList.map((model) =>
        item(`model-${model.value}`, {
            label: `Modèle : ${model.displayName}`,
            ...(model.value === run.model ? { detail: 'actuel' } : {}),
            icon: 'settings',
            keywords: `modele model changer ${model.value}`,
            run: () => send({ type: 'setModel', runId: run.id, model: model.value }),
        }),
    );
    const currentMode = run.permissionMode ?? 'default';
    const modeItems = MODES.map((mode) =>
        item(`mode-${mode.value}`, {
            label: `Mode de permission : ${mode.label}`,
            ...(mode.value === currentMode ? { detail: 'actuel' } : {}),
            icon: 'settings',
            keywords: `permissions changer ${mode.value}`,
            run: () => send({ type: 'setPermissionMode', runId: run.id, mode: mode.value }),
        }),
    );

    const currentEffort = run.effort ?? 'medium';
    const modelInfo = (models ?? []).find((m) => m.value === run.model);
    const effortItems = effortChoices(modelInfo).map((effort) =>
        item(`effort-${effort}`, {
            label: `Effort : ${EFFORTS[effort]}`,
            ...(effort === currentEffort ? { detail: 'actuel' } : {}),
            icon: 'gauge',
            keywords: `effort reflexion thinking ${effort}`,
            run: () => send({ type: 'setEffort', runId: run.id, effort }),
        }),
    );

    const session: Item[] = [
        ...(run.repoId !== null && run.type !== 'merge' && run.type !== 'spec'
            ? [
                  item('commit-push', {
                      label: 'Commit & push',
                      detail: 'message écrit par un petit modèle',
                      icon: 'commit',
                      keywords: 'git commit push pousser',
                      run: async () => {
                          await api.commitPush(run.id);
                          setPanel('jobs');
                      },
                  }),
              ]
            : []),
        item('compact', { label: 'Compacter la conversation', detail: '/compact', icon: 'history', keywords: 'compact resume contexte tokens', run: () => send({ type: 'prompt', runId: run.id, text: '/compact' }) }),
        item('clear', {
            label: 'Nouvelle conversation dans cet onglet',
            detail: '/clear',
            icon: 'plus',
            keywords: 'clear reset vider contexte tokens',
            run: async () => {
                if (window.confirm('Repartir d\'une conversation vide dans cet onglet ? (la précédente reste reprenable depuis l\'historique)')) await api.resetRun(run.id);
            },
        }),
    ];

    const resume: Item[] = run.sessionId
        ? [
              item('resume', {
                  label: 'Copier la commande de reprise',
                  detail: 'claude --resume',
                  icon: 'terminal',
                  keywords: 'resume reprendre terminal copier session',
                  run: () => navigator.clipboard.writeText(`cd '${run.cwd.replaceAll("'", "'\\''")}' && claude --resume ${run.sessionId}`),
              }),
          ]
        : [];

    return {
        all: [...interrupt, ...panelItems, ...commandItems, ...installItems, ...merges, ...session, ...openItems, ...modelItems, ...effortItems, ...modeItems, ...resume],
        featured: [...interrupt, ...panelItems, ...commandItems].slice(0, 6),
    };
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
 * Palette de commandes (⌘K) : agir sur l'onglet affiché (panneaux, commandes, merges, modèle…), aller
 * à un onglet ou une page, lancer un chat, reprendre une ancienne session Claude Code d'un dépôt, et les
 * actions d'interface. Tout au clavier.
 */
export function CommandPalette(): ReactElement | null {
    const open = useUi((s) => s.palette);
    const setPalette = useUi((s) => s.setPalette);
    const toggleRail = useUi((s) => s.toggleRail);
    const setShortcuts = useUi((s) => s.setShortcuts);
    const runs = useStore((s) => s.runs);
    const allRepos = useStore((s) => s.repos);
    // L'ordre des onglets suit les épingles et le glisser-déposer du rail.
    const pinnedRuns = useUi((s) => s.pinnedRuns);
    const runOrder = useUi((s) => s.runOrder);
    const setPage = useStore((s) => s.setPage);
    const upsertRun = useStore((s) => s.upsertRun);
    const notify = useStore((s) => s.notify);
    const repos = useMemo(() => allRepos.filter((r) => r.enabled), [allRepos]);
    const sessions = useSessions(repos, open);
    // Onglet du volet qui a le focus ; `panes`, `page` et `activeRunId` ne servent qu'à relire `paneRun` quand il change.
    const focusedPane = useUi((s) => s.focusedPane);
    const panes = useUi((s) => s.panes);
    const page = useStore((s) => s.page);
    const activeRunId = useStore((s) => s.activeRunId);
    const focusedId = useMemo(() => (open ? paneRun(focusedPane) : undefined), [open, focusedPane, panes, page, activeRunId]);
    const focused = focusedId === undefined ? undefined : runs.find((r) => r.id === focusedId);
    const models = useStore((s) => (focusedId === undefined ? undefined : s.views[focusedId]?.models));
    // Le profil ne sert qu'aux commandes et aux merges : inutile pour un chat simple ou une spec.
    const needsProfile = focused !== undefined && (runPanels(focused).some((p) => p.panel === 'jobs') || mergeTarget(focused) !== null);
    const profile = useRepoProfile(needsProfile ? focused.repoId : null, open, focused?.id);
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
            icon: runIcon(run),
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
        const intents: Item[] = [
            { id: 'new-investigation', group: 'Nouveau chat', label: 'Nouvelle investigation…', detail: 'prod ou prelive, lecture seule, rapport', icon: 'investigate', keywords: 'logs incident prelive prod bug', run: () => openNewIntent({ intent: 'investigation' }) },
            { id: 'new-question', group: 'Nouveau chat', label: 'Nouvelle question sur le code…', detail: 'lecture seule, effort bas', icon: 'question', keywords: 'comprendre explorer', run: () => openNewIntent({ intent: 'question' }) },
        ];
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

        // Actions de l'onglet affiché, en tête ; sans recherche, seulement les plus utiles.
        const current = focused ? runActions(focused, profile, models) : { all: [], featured: [] };

        const needle = normalize(query.trim());
        if (!needle) return [...current.featured, ...tabs, ...pages, ...chats, ...intents, ...history.slice(0, 8), ...actions];
        const words = needle.split(/\s+/);
        const all = [...current.all, ...tabs, ...pages, ...chats, ...intents, ...history, ...actions];
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
    }, [runs, allRepos, repos, sessions, query, setPage, upsertRun, toggleRail, setShortcuts, focused, profile, models, pinnedRuns, runOrder]);

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
            notify(String(error), item.runId);
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
                        placeholder="Action, onglet, page, dépôt, ancienne session…"
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

import '../styles/rail.css';
import type { DragEvent, ReactElement } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useStore, type Page } from '../store';
import { ALT, MOD, openToRight, showRun, useUi } from '../ui';
import { Icon, type IconName } from './Icon';
import { Menu, MenuLabel, MenuSeparator } from './Menu';
import { openNewIntent } from './NewIntentDialog';
import { intentClass, runIcon, STATE_LABEL, TabDot, groupRuns, moveRun, repoLabel, runMeta } from './Tabs';
import { UsageButton, UsageDetails } from './Usage';
import { RUN_DRAG } from './Workspace';
import { ResizeHandle, useSize } from './ResizeHandle';
import type { Run } from '../../../shared/protocol';

/** Type MIME ajouté aux onglets glissés : seul un dépôt dans le rail les réordonne. */
const RAIL_DRAG = 'application/x-clauded-rail';

const NAV: Array<{ page: Page; label: string; icon: IconName }> = [
    { page: 'issues', label: 'Issues', icon: 'issue' },
    { page: 'pulls', label: 'Pull requests', icon: 'pr' },
    { page: 'specs', label: 'Specs', icon: 'spec' },
];

/** Petites icônes propres au rail (absentes d'`Icon`), au même trait. */
function Glyph({ d, size = 14 }: { d: string; size?: number }): ReactElement {
    return (
        <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d={d} />
        </svg>
    );
}
const PIN = 'M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z';
const PENCIL = 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z';

function NavItem({ page, label, icon, collapsed }: { page: Page; label: string; icon: IconName; collapsed: boolean }): ReactElement {
    const current = useStore((s) => s.page);
    const setPage = useStore((s) => s.setPage);
    return (
        <button className={`rail-item ${current === page ? 'active' : ''}`} onClick={() => setPage(page)} title={collapsed ? label : undefined} aria-current={current === page ? 'page' : undefined}>
            <Icon name={icon} />
            <span className="rail-label">{label}</span>
        </button>
    );
}

/** Volet où cet onglet est affiché (-1 s'il ne l'est pas). */
function usePaneOf(runId: number): number {
    const main = useStore((s) => s.page === 'chat' && s.activeRunId === runId);
    const extra = useUi((s) => s.panes.indexOf(runId));
    return main ? 0 : extra === -1 ? -1 : extra + 1;
}

/** Ferme un onglet : il disparaît du rail, la session reste reprenable. */
async function closeRun(run: Run): Promise<void> {
    const { removeRun, notify } = useStore.getState();
    try {
        await api.deleteRun(run.id);
        removeRun(run.id);
    } catch (error) {
        notify(String(error));
    }
}

/** Champ de renommage en place : Entrée valide, Échap annule, quitter le champ valide aussi. */
function RenameField({ run, onDone }: { run: Run; onDone: (refocus: boolean) => void }): ReactElement {
    const [value, setValue] = useState(run.title);
    const done = useRef(false);

    const finish = async (save: boolean, refocus: boolean): Promise<void> => {
        if (done.current) return;
        done.current = true;
        onDone(refocus);
        const title = value.trim();
        if (!save || !title || title === run.title) return;
        const { upsertRun, notify } = useStore.getState();
        // Run relu à chaque mise à jour : son état a pu changer, ou l'onglet être fermé entre-temps.
        const retitle = (next: string): void => {
            const latest = useStore.getState().runs.find((r) => r.id === run.id);
            if (latest) upsertRun({ ...latest, title: next });
        };
        // Affiché tout de suite ; le serveur fait foi, et on revient à l'ancien titre en cas d'échec.
        retitle(title);
        try {
            const saved = await api.renameRun(run.id, title);
            if (useStore.getState().runs.some((r) => r.id === run.id)) upsertRun(saved);
        } catch (error) {
            retitle(run.title);
            notify(String(error));
        }
    };

    return (
        <input
            className="rail-tab-rename"
            value={value}
            autoFocus
            maxLength={200}
            aria-label={`Nouveau titre de ${run.title}`}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    void finish(true, true);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    void finish(false, true);
                }
            }}
            onBlur={() => void finish(true, false)}
        />
    );
}

/** Menu d'un onglet ouvert par clic droit ou « ⋯ », placé où on l'a demandé. */
interface MenuAt {
    runId: number;
    x: number;
    y: number;
    /** Élément qui reprend le focus à la fermeture au clavier. */
    from: HTMLElement | null;
    /** Ouvert par le bouton « ⋯ » : un second clic dessus le referme. */
    fromButton: boolean;
}

/**
 * Menu contextuel d'un onglet. Pas le `Menu` commun : la liste du rail défile et rognerait un menu
 * positionné sous son bouton, et le clic droit doit l'ouvrir sous le pointeur. Il en reprend
 * l'apparence et le comportement (Échap, flèches, clic extérieur).
 */
function TabMenu({ at, run, pinned, onClose, onRename }: { at: MenuAt; run: Run; pinned: boolean; onClose: (refocus: boolean) => void; onRename: (runId: number) => void }): ReactElement {
    const list = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: at.x, top: at.y });
    const pane = usePaneOf(run.id);
    const togglePin = useUi((s) => s.togglePin);

    // Gardé dans la fenêtre, premier élément focalisé pour enchaîner au clavier.
    useLayoutEffect(() => {
        const el = list.current;
        if (!el) return;
        const box = el.getBoundingClientRect();
        setPos({ left: Math.max(8, Math.min(at.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - box.height - 8)) });
        el.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    }, [at.x, at.y]);

    useEffect(() => {
        const outside = (e: MouseEvent): void => {
            const target = e.target as Node;
            if (list.current?.contains(target) || (at.fromButton && at.from?.contains(target))) return;
            onClose(false);
        };
        const scroll = (e: Event): void => {
            if (!list.current?.contains(e.target as Node)) onClose(false);
        };
        const away = (): void => onClose(false);
        document.addEventListener('mousedown', outside);
        document.addEventListener('scroll', scroll, true);
        window.addEventListener('resize', away);
        window.addEventListener('blur', away);
        return () => {
            document.removeEventListener('mousedown', outside);
            document.removeEventListener('scroll', scroll, true);
            window.removeEventListener('resize', away);
            window.removeEventListener('blur', away);
        };
    }, [onClose, at]);

    const onKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === 'Escape' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            onClose(true);
            return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const items = [...(list.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
        if (items.length === 0) return;
        e.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
        items[next]?.focus();
    };

    const act = (fn: () => void, refocus = true) => (): void => {
        onClose(refocus);
        fn();
    };

    return createPortal(
        <div ref={list} role="menu" aria-label={`Actions de ${run.title}`} className="menu-items rail-tab-menu" style={{ left: pos.left, top: pos.top }} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
            <div className="menu-label">{run.title}</div>
            <button role="menuitem" onClick={act(() => onRename(run.id), false)}>
                <Glyph d={PENCIL} /> Renommer <kbd>F2</kbd>
            </button>
            <button role="menuitem" onClick={act(() => togglePin(run.id))}>
                <Glyph d={PIN} /> {pinned ? 'Désépingler' : 'Épingler'}
            </button>
            <button role="menuitem" onClick={act(() => openToRight(run.id), false)} disabled={pane !== -1} title={pane !== -1 ? 'Déjà affiché dans un volet' : undefined}>
                <Icon name="split" size={14} /> Ouvrir à côté <kbd>{ALT}-clic</kbd>
            </button>
            <MenuSeparator />
            <button role="menuitem" className="rail-tab-menu-close" onClick={act(() => void closeRun(run), false)} title="La session reste reprenable">
                <Icon name="x" size={14} /> Fermer l'onglet
            </button>
        </div>,
        document.body,
    );
}

type DropSide = 'before' | 'after';

interface TabProps {
    run: Run;
    index: number;
    collapsed: boolean;
    editing: boolean;
    menuOpen: boolean;
    dragging: boolean;
    drop: DropSide | null;
    onEdit: (runId: number | null) => void;
    onMenu: (at: MenuAt) => void;
    onDragStart: (run: Run) => void;
    onDragOver: (e: DragEvent<HTMLDivElement>, run: Run) => void;
    onDrop: (e: DragEvent<HTMLDivElement>, run: Run) => void;
    onDragEnd: () => void;
}

function TabItem({ run, index, collapsed, editing, menuOpen, dragging, drop, onEdit, onMenu, onDragStart, onDragOver, onDrop, onDragEnd }: TabProps): ReactElement {
    const pane = usePaneOf(run.id);
    const split = useUi((s) => s.panes.length > 0);
    const focused = useUi((s) => s.focusedPane);
    const main = useRef<HTMLButtonElement>(null);
    // Actif : affiché dans le volet qui a le focus ; visible : affiché dans un autre volet.
    const active = pane !== -1 && (pane === focused || !split);
    const visible = pane !== -1 && !active;

    const hint = index < 9 ? `\n${ALT}${index + 1}` : '';
    const classes = ['rail-tab', active && 'active', visible && 'visible', run.state === 'waiting' && 'waiting', dragging && 'dragging', drop && `drop-${drop}`, editing && 'editing', menuOpen && 'menu-open'].filter(Boolean).join(' ');
    const icon = (
        <span className={`rail-tab-icon ${intentClass(run)}`}>
            <Icon name={runIcon(run)} size={15} />
            <TabDot run={run} />
        </span>
    );

    return (
        <div
            className={classes}
            draggable={!editing}
            onDragStart={(e) => {
                e.dataTransfer.setData(RUN_DRAG, String(run.id));
                e.dataTransfer.setData(RAIL_DRAG, String(run.id));
                e.dataTransfer.effectAllowed = 'move';
                onDragStart(run);
            }}
            onDragOver={(e) => onDragOver(e, run)}
            onDrop={(e) => onDrop(e, run)}
            onDragEnd={onDragEnd}
            onContextMenu={(e) => {
                if (collapsed || editing) return;
                e.preventDefault();
                onMenu({ runId: run.id, x: e.clientX, y: e.clientY, from: main.current, fromButton: false });
            }}
        >
            {editing ? (
                <div className="rail-tab-main">
                    {icon}
                    <RenameField
                        run={run}
                        onDone={(refocus) => {
                            onEdit(null);
                            if (refocus) requestAnimationFrame(() => main.current?.focus());
                        }}
                    />
                </div>
            ) : (
                <button
                    ref={main}
                    className="rail-tab-main"
                    onClick={(e) => (e.altKey ? openToRight(run.id) : showRun(run.id))}
                    onKeyDown={(e) => {
                        if (e.key === 'F2' && !collapsed) {
                            e.preventDefault();
                            onEdit(run.id);
                        }
                    }}
                    title={`${run.title}\n${run.cwd}\n${STATE_LABEL[run.state]}${hint}\n${ALT}-clic ou glisser vers la droite : ouvrir à côté${collapsed ? '' : '\nDouble-clic sur le titre : renommer'}`}
                    aria-current={active ? 'page' : undefined}
                >
                    {icon}
                    {!collapsed && (
                        <span className="rail-tab-text">
                            <span className="rail-tab-title" onDoubleClick={() => onEdit(run.id)}>
                                {run.title}
                            </span>
                            <span className="rail-tab-meta">{run.state === 'waiting' ? 'attend ta réponse' : runMeta(run)}</span>
                        </span>
                    )}
                </button>
            )}
            {!collapsed && !editing && (
                <span className="rail-tab-actions">
                    <button
                        className="icon-button"
                        onClick={(e) => {
                            const box = e.currentTarget.getBoundingClientRect();
                            onMenu({ runId: run.id, x: box.left, y: box.bottom + 4, from: e.currentTarget, fromButton: true });
                        }}
                        aria-expanded={menuOpen}
                        title="Actions de l'onglet (clic droit)"
                        aria-label={`Actions de ${run.title}`}
                        aria-haspopup="menu"
                    >
                        <Icon name="more" size={13} />
                    </button>
                    <button className="rail-tab-close icon-button" onClick={() => void closeRun(run)} title="Fermer l'onglet (la session reste reprenable)" aria-label={`Fermer ${run.title}`}>
                        <Icon name="x" size={13} />
                    </button>
                </span>
            )}
        </div>
    );
}

/** « + » : nouveau chat dans un dépôt, ou reprise d'une ancienne session via la palette. */
function NewMenu({ collapsed }: { collapsed: boolean }): ReactElement {
    // Filtré hors du sélecteur : un tableau recréé à chaque lecture fait boucler zustand.
    const repos = useStore((s) => s.repos).filter((r) => r.enabled);
    const upsertRun = useStore((s) => s.upsertRun);
    const notify = useStore((s) => s.notify);
    const setPalette = useUi((s) => s.setPalette);

    const newChat = async (repoId: number): Promise<void> => {
        try {
            const run = await api.createRun({ repoId });
            upsertRun(run);
            showRun(run.id);
        } catch (error) {
            notify(String(error));
        }
    };

    return (
        <Menu icon="plus" title="Nouveau chat ou reprise d'une session" className={`rail-new ${collapsed ? 'collapsed' : ''}`}>
            <MenuLabel>Nouveau chat dans</MenuLabel>
            {repos.length === 0 && <div className="muted menu-note">Aucun dépôt activé.</div>}
            {repos.map((repo) => (
                <button key={repo.id} role="menuitem" onClick={() => void newChat(repo.id)}>
                    <Icon name="chat" size={14} /> {repoLabel(repo)}
                </button>
            ))}
            <MenuSeparator />
            <button role="menuitem" onClick={() => openNewIntent({ intent: 'investigation' })} title="Logs, métriques, comportement en prod ou prelive ; lecture seule, se termine par un rapport">
                <Icon name="investigate" size={14} /> Nouvelle investigation…
            </button>
            <button role="menuitem" onClick={() => openNewIntent({ intent: 'question' })} title="Comprendre le code ; lecture seule, effort bas">
                <Icon name="question" size={14} /> Nouvelle question sur le code…
            </button>
            <MenuSeparator />
            <button role="menuitem" onClick={() => setPalette(true)}>
                <Icon name="history" size={14} /> Reprendre une session… <kbd>{MOD}K</kbd>
            </button>
        </Menu>
    );
}

/**
 * Rail de gauche : navigation (Issues, PR, Specs), onglets ouverts (épinglés en tête, puis groupés par
 * dépôt, réordonnables à la souris), recherche (⌘K), consommation et réglages. Se replie en barre
 * d'icônes (⌘B).
 */
export function Rail(): ReactElement {
    const runs = useStore((s) => s.runs);
    const repos = useStore((s) => s.repos);
    const collapsed = useUi((s) => s.railCollapsed);
    const toggleRail = useUi((s) => s.toggleRail);
    const setPalette = useUi((s) => s.setPalette);
    const setShortcuts = useUi((s) => s.setShortcuts);
    // Lus par groupRuns via getState : abonnés ici pour suivre épingles et ordre.
    const pinnedRuns = useUi((s) => s.pinnedRuns);
    useUi((s) => s.runOrder);
    const waitingOnly = useUi((s) => s.waitingOnly);
    const setWaitingOnly = useUi((s) => s.setWaitingOnly);
    const pruneRunPrefs = useUi((s) => s.pruneRunPrefs);
    const width = useSize('rail');
    const nav = useRef<HTMLElement>(null);

    const [editingId, setEditingId] = useState<number | null>(null);
    const [menu, setMenu] = useState<MenuAt | null>(null);
    // Onglet glissé et sa section : on ne réordonne qu'au sein d'une même section.
    const [dragged, setDragged] = useState<{ id: number; section: string } | null>(null);
    const [dropAt, setDropAt] = useState<{ id: number; side: DropSide } | null>(null);
    const dragId = useRef<number | null>(null);

    // Épingles et ordre des onglets fermés entre-temps. Pas avant le premier `hello` (liste vide).
    useEffect(() => {
        if (runs.length > 0) pruneRunPrefs(runs.map((r) => r.id));
    }, [runs, pruneRunPrefs]);

    const closeMenu = useCallback(
        (refocus: boolean): void => {
            if (refocus) menu?.from?.focus({ preventScroll: true });
            setMenu(null);
        },
        [menu],
    );
    const openMenu = useCallback((at: MenuAt): void => {
        setMenu((current) => (at.fromButton && current?.fromButton && current.runId === at.runId ? null : at));
    }, []);

    const waiting = runs.filter((r) => r.state === 'waiting').length;
    const groups = groupRuns(runs, repos);
    // Raccourcis ⌥1…⌥9 : rang dans la liste complète, même filtrée.
    const rank = new Map(groups.flatMap((g) => g.runs).map((run, i) => [run.id, i]));
    const sectionOf = new Map(groups.flatMap((g) => g.runs.map((run) => [run.id, g.key] as const)));
    // Le filtre « À toi » n'a pas de bouton en mode replié : il ne s'y applique pas.
    const filtering = waitingOnly && !collapsed;
    const shown = filtering ? groups.map((g) => ({ ...g, runs: g.runs.filter((r) => r.state === 'waiting') })).filter((g) => g.runs.length > 0) : groups;
    const menuRun = menu ? runs.find((r) => r.id === menu.runId) : undefined;

    const sideOf = (e: DragEvent<HTMLDivElement>): DropSide => {
        const box = e.currentTarget.getBoundingClientRect();
        return e.clientY > box.top + box.height / 2 ? 'after' : 'before';
    };

    const endDrag = (): void => {
        dragId.current = null;
        setDragged(null);
        setDropAt(null);
    };

    const onDragOver = (e: DragEvent<HTMLDivElement>, run: Run): void => {
        if (!dragged || !e.dataTransfer.types.includes(RAIL_DRAG) || sectionOf.get(run.id) !== dragged.section) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const side = sideOf(e);
        const next = run.id === dragged.id ? null : { id: run.id, side };
        setDropAt((current) => (current?.id === next?.id && current?.side === next?.side ? current : next));
    };

    const onDrop = (e: DragEvent<HTMLDivElement>, run: Run): void => {
        if (!dragged || !e.dataTransfer.types.includes(RAIL_DRAG) || sectionOf.get(run.id) !== dragged.section) return;
        e.preventDefault();
        e.stopPropagation();
        moveRun(runs, repos, dragged.id, run.id, sideOf(e) === 'after');
        endDrag();
    };

    return (
        <nav ref={nav} className={`rail ${collapsed ? 'collapsed' : ''}`} aria-label="Navigation principale" style={collapsed || width === undefined ? undefined : { width }}>
            <div className="rail-head">
                {!collapsed && (
                    <span className="brand">
                        clauded<span className="brand-dim">_git</span>
                    </span>
                )}
                <button className="icon-button" onClick={toggleRail} title={`${collapsed ? 'Déplier' : 'Replier'} le rail (${MOD}B)`} aria-label={collapsed ? 'Déplier le rail' : 'Replier le rail'}>
                    <Icon name="sidebar" />
                </button>
            </div>

            <button className="rail-search" onClick={() => setPalette(true)} title={`Rechercher un onglet, une session, une action (${MOD}K)`}>
                <Icon name="search" size={15} />
                <span className="rail-label">Rechercher…</span>
                <kbd className="rail-label">{MOD}K</kbd>
            </button>

            <div className="rail-nav">
                {NAV.map((item) => (
                    <NavItem key={item.page} {...item} collapsed={collapsed} />
                ))}
            </div>

            <div className="rail-section">
                <span className="rail-label">Onglets</span>
                {!collapsed && runs.length > 0 && <span className="rail-count">{runs.length}</span>}
                {!collapsed && (waiting > 0 || waitingOnly) && (
                    <button
                        className={`rail-waiting ${waitingOnly ? 'on' : ''}`}
                        onClick={() => setWaitingOnly(!waitingOnly)}
                        aria-pressed={waitingOnly}
                        title={waitingOnly ? 'Afficher tous les onglets' : "N'afficher que les onglets qui attendent ta réponse"}
                    >
                        {waiting} à toi
                        {waitingOnly && <Icon name="x" size={11} />}
                    </button>
                )}
                <span className="spacer" />
                <NewMenu collapsed={collapsed} />
            </div>

            <div
                className={`rail-tabs ${dragged ? 'reordering' : ''}`}
                onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
                }}
            >
                {runs.length === 0 && !collapsed && <div className="muted rail-empty">Aucun onglet. Lance un chat avec « + » ou ouvre une issue.</div>}
                {runs.length > 0 && filtering && shown.length === 0 && (
                    <div className="muted rail-empty">
                        Aucun onglet n'attend ta réponse.{' '}
                        <button className="link" onClick={() => setWaitingOnly(false)}>
                            Tout afficher
                        </button>
                    </div>
                )}
                {shown.map((group) => (
                    <div key={group.key} className={`rail-group ${group.pinned ? 'pinned' : ''}`} role="group" aria-label={group.repo}>
                        {!collapsed && (group.pinned || shown.length > 1) && (
                            <div className="rail-group-head">
                                {group.pinned && <Glyph d={PIN} size={11} />}
                                {group.repo}
                            </div>
                        )}
                        {group.runs.map((run) => (
                            <TabItem
                                key={run.id}
                                run={run}
                                index={rank.get(run.id) ?? 0}
                                collapsed={collapsed}
                                editing={!collapsed && editingId === run.id}
                                menuOpen={menu?.runId === run.id}
                                dragging={dragged?.id === run.id}
                                drop={dropAt?.id === run.id ? dropAt.side : null}
                                onEdit={setEditingId}
                                onMenu={openMenu}
                                onDragStart={(r) => {
                                    // Après coup : un changement de classe pendant `dragstart` se verrait sur l'image glissée.
                                    const section = sectionOf.get(r.id) ?? '';
                                    dragId.current = r.id;
                                    requestAnimationFrame(() => {
                                        if (dragId.current === r.id) setDragged({ id: r.id, section });
                                    });
                                }}
                                onDragOver={onDragOver}
                                onDrop={onDrop}
                                onDragEnd={endDrag}
                            />
                        ))}
                    </div>
                ))}
            </div>

            <div className="rail-foot">
                {collapsed ? <UsageButton /> : <UsageDetails />}
                <div className="rail-foot-row">
                    <NavItem page="repos" label="Dépôts" icon="settings" collapsed={collapsed} />
                    {!collapsed && (
                        <button className="icon-button" onClick={() => setShortcuts(true)} title="Raccourcis clavier (?)" aria-label="Raccourcis clavier">
                            <Icon name="keyboard" />
                        </button>
                    )}
                </div>
            </div>
            {!collapsed && <ResizeHandle sizeKey="rail" current={() => nav.current?.offsetWidth ?? 248} min={184} max={440} direction={1} label="Largeur du rail" className="edge-right" />}
            {menu && menuRun && !collapsed && <TabMenu at={menu} run={menuRun} pinned={pinnedRuns.includes(menuRun.id)} onClose={closeMenu} onRename={setEditingId} />}
        </nav>
    );
}

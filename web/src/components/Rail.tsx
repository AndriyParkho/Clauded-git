import type { ReactElement } from 'react';
import { useRef } from 'react';
import { api } from '../api';
import { useStore, type Page } from '../store';
import { ALT, MOD, openToRight, showRun, useUi } from '../ui';
import { Icon, type IconName } from './Icon';
import { Menu, MenuLabel, MenuSeparator } from './Menu';
import { RUN_ICON, STATE_LABEL, TabDot, groupRuns, repoLabel, runMeta } from './Tabs';
import { UsageButton, UsageDetails } from './Usage';
import { RUN_DRAG } from './Workspace';
import { ResizeHandle, useSize } from './ResizeHandle';
import type { Run } from '../../../shared/protocol';

const NAV: Array<{ page: Page; label: string; icon: IconName }> = [
    { page: 'issues', label: 'Issues', icon: 'issue' },
    { page: 'pulls', label: 'Pull requests', icon: 'pr' },
    { page: 'specs', label: 'Specs', icon: 'spec' },
];

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

function TabItem({ run, index, collapsed }: { run: Run; index: number; collapsed: boolean }): ReactElement {
    const pane = usePaneOf(run.id);
    const split = useUi((s) => s.panes.length > 0);
    const focused = useUi((s) => s.focusedPane);
    // Actif : affiché dans le volet qui a le focus ; visible : affiché dans un autre volet.
    const active = pane !== -1 && (pane === focused || !split);
    const visible = pane !== -1 && !active;
    const removeRun = useStore((s) => s.removeRun);
    const notify = useStore((s) => s.notify);

    const close = async (): Promise<void> => {
        try {
            await api.deleteRun(run.id);
            removeRun(run.id);
        } catch (error) {
            notify(String(error));
        }
    };

    const hint = index < 9 ? `\n${ALT}${index + 1}` : '';
    return (
        <div
            className={`rail-tab ${active ? 'active' : ''} ${visible ? 'visible' : ''} ${run.state === 'waiting' ? 'waiting' : ''}`}
            draggable
            onDragStart={(e) => {
                e.dataTransfer.setData(RUN_DRAG, String(run.id));
                e.dataTransfer.effectAllowed = 'move';
            }}
        >
            <button
                className="rail-tab-main"
                onClick={(e) => (e.altKey ? openToRight(run.id) : showRun(run.id))}
                title={`${run.title}\n${run.cwd}\n${STATE_LABEL[run.state]}${hint}\n${ALT}-clic ou glisser vers la droite : ouvrir à côté`}
                aria-current={active ? 'page' : undefined}
            >
                <span className="rail-tab-icon">
                    <Icon name={RUN_ICON[run.type]} size={15} />
                    <TabDot run={run} />
                </span>
                {!collapsed && (
                    <span className="rail-tab-text">
                        <span className="rail-tab-title">{run.title}</span>
                        <span className="rail-tab-meta">{run.state === 'waiting' ? 'attend ta réponse' : runMeta(run)}</span>
                    </span>
                )}
            </button>
            {!collapsed && (
                <span className="rail-tab-actions">
                    {pane === -1 && (
                        <button className="icon-button" onClick={() => openToRight(run.id)} title={`Ouvrir à côté (${ALT}-clic)`} aria-label={`Ouvrir ${run.title} à côté`}>
                            <Icon name="split" size={13} />
                        </button>
                    )}
                    <button className="rail-tab-close icon-button" onClick={() => void close()} title="Fermer l'onglet (la session reste reprenable)" aria-label={`Fermer ${run.title}`}>
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
            <button role="menuitem" onClick={() => setPalette(true)}>
                <Icon name="history" size={14} /> Reprendre une session… <kbd>{MOD}K</kbd>
            </button>
        </Menu>
    );
}

/**
 * Rail de gauche : navigation (Issues, PR, Specs), onglets ouverts groupés par dépôt, recherche
 * (⌘K), consommation et réglages. Se replie en barre d'icônes (⌘B).
 */
export function Rail(): ReactElement {
    const runs = useStore((s) => s.runs);
    const repos = useStore((s) => s.repos);
    const collapsed = useUi((s) => s.railCollapsed);
    const toggleRail = useUi((s) => s.toggleRail);
    const setPalette = useUi((s) => s.setPalette);
    const setShortcuts = useUi((s) => s.setShortcuts);
    const waiting = runs.filter((r) => r.state === 'waiting').length;
    const groups = groupRuns(runs, repos);
    const width = useSize('rail');
    const nav = useRef<HTMLElement>(null);
    let index = 0;

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
                {!collapsed && waiting > 0 && (
                    <span className="rail-waiting" title="Onglets qui attendent ta réponse">
                        {waiting} à toi
                    </span>
                )}
                <span className="spacer" />
                <NewMenu collapsed={collapsed} />
            </div>

            <div className="rail-tabs">
                {runs.length === 0 && !collapsed && <div className="muted rail-empty">Aucun onglet. Lance un chat avec « + » ou ouvre une issue.</div>}
                {groups.map((group) => (
                    <div key={group.repo} className="rail-group">
                        {!collapsed && groups.length > 1 && <div className="rail-group-head">{group.repo}</div>}
                        {group.runs.map((run) => (
                            <TabItem key={run.id} run={run} index={index++} collapsed={collapsed} />
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
        </nav>
    );
}

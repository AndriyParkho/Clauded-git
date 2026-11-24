import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useStore, type Page } from '../store';
import { send } from '../ws';
import { closePane, keepOnlyPane, MAX_PANES, openToRight, paneRatios, prunePanes, putInPane, useUi } from '../ui';
import { Icon } from './Icon';
import { RUN_ICON, TabDot } from './Tabs';
import { RunContent } from './RunContent';
import type { Run } from '../../../shared/protocol';

/** Type MIME des onglets glissés depuis le rail. */
export const RUN_DRAG = 'application/x-clauded-run';

const PAGE_TITLES: Record<Page, string> = { chat: 'Onglet', issues: 'Issues', pulls: 'Pull requests', specs: 'Specs', repos: 'Dépôts' };
const MIN_PANE = 320;

/** Onglet affiché dans un volet secondaire : rejoué depuis le serveur à la première ouverture. */
function RunPane({ run }: { run: Run }): ReactElement {
    const loaded = useStore((s) => s.views[run.id]?.loaded);
    const connected = useStore((s) => s.connected);
    useEffect(() => {
        if (connected && !loaded) send({ type: 'replay', runId: run.id });
    }, [run.id, connected, loaded]);
    return <RunContent run={run} />;
}

/** Barre d'un volet quand l'écran est partagé : ce qu'il montre, le garder seul, le fermer. */
function PaneBar({ index, run, page, count }: { index: number; run: Run | undefined; page: Page; count: number }): ReactElement {
    return (
        <div className="pane-bar">
            {run ? (
                <>
                    <span className="pane-bar-icon">
                        <Icon name={RUN_ICON[run.type]} size={13} />
                        <TabDot run={run} />
                    </span>
                    <span className="pane-bar-title">{run.title}</span>
                </>
            ) : (
                <span className="pane-bar-title">{PAGE_TITLES[page]}</span>
            )}
            <span className="spacer" />
            {count > 1 && (
                <button className="icon-button" onClick={() => keepOnlyPane(index)} title="Garder ce volet seul" aria-label="Garder ce volet seul">
                    <Icon name="maximize" size={13} />
                </button>
            )}
            <button className="icon-button" onClick={() => closePane(index)} title="Fermer le volet (l'onglet reste dans le rail)" aria-label="Fermer le volet">
                <Icon name="x" size={13} />
            </button>
        </div>
    );
}

type DropZone = 'center' | 'right';

/** Un volet : reçoit le focus au clic, et les onglets glissés depuis le rail (au centre : remplace ; à droite : partage). */
function Pane({ index, ratio, count, children, run, page }: { index: number; ratio: number; count: number; children: ReactElement; run: Run | undefined; page: Page }): ReactElement {
    const focused = useUi((s) => s.focusedPane === index);
    const focusPane = useUi((s) => s.focusPane);
    const [drop, setDrop] = useState<DropZone | null>(null);

    const zone = (e: React.DragEvent<HTMLElement>): DropZone => {
        const rect = e.currentTarget.getBoundingClientRect();
        return e.clientX > rect.left + rect.width * 0.62 && count < MAX_PANES ? 'right' : 'center';
    };

    return (
        <section
            className={`pane ${focused && count > 1 ? 'focused' : ''}`}
            style={{ flex: `${ratio} 1 0`, minWidth: MIN_PANE }}
            data-pane={index}
            onMouseDownCapture={() => focusPane(index)}
            onFocusCapture={() => focusPane(index)}
            onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(RUN_DRAG)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDrop(zone(e));
            }}
            onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
            }}
            onDrop={(e) => {
                const id = Number(e.dataTransfer.getData(RUN_DRAG));
                const where = zone(e);
                setDrop(null);
                if (!id) return;
                e.preventDefault();
                if (where === 'right') openToRight(id, index);
                else putInPane(id, index);
            }}
        >
            {count > 1 && <PaneBar index={index} run={run} page={page} count={count} />}
            <div className="pane-body">{children}</div>
            {drop && (
                <div className={`drop-zone ${drop}`} aria-hidden="true">
                    <span>{drop === 'right' ? 'Ouvrir à droite' : 'Ouvrir ici'}</span>
                </div>
            )}
        </section>
    );
}

/** Poignée entre deux volets : déplace la frontière, en gardant MIN_PANE de chaque côté. */
function PaneSplitter({ index, container }: { index: number; container: React.RefObject<HTMLDivElement | null> }): ReactElement {
    const setRatios = useUi((s) => s.setRatios);
    const drag = useRef<{ x: number; widths: number[] } | null>(null);

    const widths = (): number[] => [...(container.current?.querySelectorAll<HTMLElement>(':scope > .pane') ?? [])].map((el) => el.getBoundingClientRect().width);
    const apply = (base: number[], dx: number): void => {
        const left = base[index - 1] ?? 0;
        const right = base[index] ?? 0;
        const delta = Math.max(MIN_PANE - left, Math.min(right - MIN_PANE, dx));
        const next = [...base];
        next[index - 1] = left + delta;
        next[index] = right - delta;
        setRatios(next.map((w) => w / 100));
    };

    return (
        <div
            className="pane-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Frontière entre deux volets"
            tabIndex={0}
            title="Glisser pour redimensionner les volets, double-clic pour les égaliser"
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, widths: widths() };
                document.body.classList.add('resizing');
            }}
            onPointerMove={(e) => drag.current && apply(drag.current.widths, e.clientX - drag.current.x)}
            onPointerUp={(e) => {
                drag.current = null;
                e.currentTarget.releasePointerCapture(e.pointerId);
                document.body.classList.remove('resizing');
            }}
            onDoubleClick={() => setRatios([])}
            onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                apply(widths(), (e.shiftKey ? 64 : 16) * (e.key === 'ArrowRight' ? 1 : -1));
            }}
        />
    );
}

/**
 * Zone de travail : le volet principal (page ou onglet actif) et, à sa droite, jusqu'à trois autres
 * onglets côte à côte. On y glisse les onglets du rail ; chaque frontière se règle à la souris.
 */
export function Workspace({ main }: { main: ReactElement }): ReactElement {
    const panes = useUi((s) => s.panes);
    const ratios = useUi((s) => s.ratios);
    const runs = useStore((s) => s.runs);
    const page = useStore((s) => s.page);
    const activeRunId = useStore((s) => s.activeRunId);
    const container = useRef<HTMLDivElement>(null);
    const mainRun = page === 'chat' ? runs.find((r) => r.id === activeRunId) : undefined;

    // Onglet fermé, ou devenu celui du volet principal : son volet disparaît. Pas tant que la liste
    // des onglets n'est pas arrivée du serveur, sinon les volets gardés d'une visite à l'autre sautent.
    useEffect(() => {
        if (runs.length > 0) prunePanes(runs.map((r) => r.id));
    }, [runs, activeRunId, page, panes]);

    const extra = panes.map((id) => runs.find((r) => r.id === id)).filter((r): r is Run => r !== undefined && r.id !== mainRun?.id);
    const count = extra.length + 1;
    const shares = paneRatios(count, ratios);

    return (
        <div className="workspace" ref={container}>
            <Pane index={0} ratio={shares[0] ?? 1} count={count} run={mainRun} page={page}>
                {main}
            </Pane>
            {extra.map((run, i) => (
                <PaneGroup key={run.id} index={i + 1} ratio={shares[i + 1] ?? 1} count={count} run={run} container={container} page={page} />
            ))}
        </div>
    );
}

function PaneGroup({ index, ratio, count, run, container, page }: { index: number; ratio: number; count: number; run: Run; container: React.RefObject<HTMLDivElement | null>; page: Page }): ReactElement {
    return (
        <>
            <PaneSplitter index={index} container={container} />
            <Pane index={index} ratio={ratio} count={count} run={run} page={page}>
                <RunPane run={run} />
            </Pane>
        </>
    );
}

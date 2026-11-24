import { create } from 'zustand';
import { useStore } from './store';

/** Nombre maximal de volets côte à côte (le principal compris). */
export const MAX_PANES = 4;

/**
 * État d'interface local au navigateur, gardé d'une visite à l'autre : rail replié, largeurs choisies
 * à la souris, volets ouverts côte à côte et leurs proportions.
 *
 * Volets : l'indice 0 est le volet principal (la page ou l'onglet actif du store) ; les indices 1…n
 * sont les onglets de `panes`, ouverts à sa droite.
 */
interface UiState {
    railCollapsed: boolean;
    palette: boolean;
    shortcuts: boolean;
    /** Largeurs en px choisies par glisser, par zone (`rail`, `panel`, `issues-detail`…). */
    sizes: Record<string, number>;
    /** Onglets des volets 1…n. */
    panes: number[];
    /** Part de largeur de chaque volet (0…n), somme quelconque. */
    ratios: number[];
    /** Volet qui reçoit les onglets choisis dans le rail ou la palette. */
    focusedPane: number;
    toggleRail(): void;
    setPalette(open: boolean): void;
    setShortcuts(open: boolean): void;
    setSize(key: string, px: number): void;
    resetSize(key: string): void;
    focusPane(index: number): void;
    setRatios(ratios: number[]): void;
}

function read<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
}

function write(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // stockage indisponible : le choix ne survivra pas au rechargement
    }
}

export const useUi = create<UiState>((set, get) => ({
    railCollapsed: read('clauded.railCollapsed', false),
    palette: false,
    shortcuts: false,
    sizes: read<Record<string, number>>('clauded.sizes', {}),
    panes: read<number[]>('clauded.panes', []),
    ratios: read<number[]>('clauded.ratios', []),
    focusedPane: 0,
    toggleRail: () => {
        const next = !get().railCollapsed;
        write('clauded.railCollapsed', next);
        set({ railCollapsed: next });
    },
    setPalette: (open) => set({ palette: open, ...(open ? { shortcuts: false } : {}) }),
    setShortcuts: (open) => set({ shortcuts: open, ...(open ? { palette: false } : {}) }),
    setSize: (key, px) => {
        const sizes = { ...get().sizes, [key]: Math.round(px) };
        write('clauded.sizes', sizes);
        set({ sizes });
    },
    resetSize: (key) => {
        const { [key]: _removed, ...sizes } = get().sizes;
        write('clauded.sizes', sizes);
        set({ sizes });
    },
    focusPane: (index) => {
        if (get().focusedPane !== index) set({ focusedPane: index });
    },
    setRatios: (ratios) => {
        write('clauded.ratios', ratios);
        set({ ratios });
    },
}));

function savePanes(panes: number[], ratios: number[], focusedPane: number): void {
    write('clauded.panes', panes);
    write('clauded.ratios', ratios);
    useUi.setState({ panes, ratios, focusedPane });
}

/** Proportions alignées sur le nombre de volets (parts égales si elles ne correspondent plus). */
export function paneRatios(count: number, ratios: number[]): number[] {
    return ratios.length === count && ratios.every((r) => r > 0) ? ratios : Array.from({ length: count }, () => 1);
}

/** Onglet affiché dans le volet `index` (`undefined` pour le principal quand il montre une page). */
export function paneRun(index: number): number | undefined {
    if (index === 0) {
        const { page, activeRunId } = useStore.getState();
        return page === 'chat' && activeRunId !== null ? activeRunId : undefined;
    }
    return useUi.getState().panes[index - 1];
}

/** Volet qui affiche déjà cet onglet, -1 sinon. */
function paneOf(runId: number): number {
    if (paneRun(0) === runId) return 0;
    const i = useUi.getState().panes.indexOf(runId);
    return i === -1 ? -1 : i + 1;
}

/** Affiche un onglet dans le volet qui a le focus (ou va sur le volet qui l'affiche déjà). */
export function showRun(runId: number): void {
    const ui = useUi.getState();
    const where = paneOf(runId);
    if (where !== -1) return ui.focusPane(where);
    if (ui.focusedPane === 0 || ui.focusedPane > ui.panes.length) {
        useStore.getState().setActive(runId);
        return ui.focusPane(0);
    }
    const panes = [...ui.panes];
    panes[ui.focusedPane - 1] = runId;
    savePanes(panes, ui.ratios, ui.focusedPane);
}

/**
 * Ouvre un onglet dans un nouveau volet à droite de `from` (par défaut celui qui a le focus), en
 * partageant sa largeur. Au-delà de MAX_PANES, il remplace le dernier volet.
 */
export function openToRight(runId: number, from = useUi.getState().focusedPane): void {
    const ui = useUi.getState();
    const where = paneOf(runId);
    if (where !== -1) return ui.focusPane(where);
    // Rien dans le volet principal : l'onglet y va, inutile de couper l'écran.
    if (paneRun(0) === undefined && useStore.getState().page === 'chat') return showRun(runId);
    const count = ui.panes.length + 1;
    const ratios = paneRatios(count, ui.ratios);
    if (count >= MAX_PANES) {
        const panes = [...ui.panes];
        panes[panes.length - 1] = runId;
        return savePanes(panes, ratios, panes.length);
    }
    const source = Math.min(from, count - 1);
    const half = (ratios[source] ?? 1) / 2;
    const nextRatios = [...ratios];
    nextRatios.splice(source, 1, half, half);
    const panes = [...ui.panes];
    panes.splice(source, 0, runId);
    savePanes(panes, nextRatios, source + 1);
}

/** Ferme un volet ; fermer le principal y fait remonter le volet suivant. */
export function closePane(index: number): void {
    const ui = useUi.getState();
    const count = ui.panes.length + 1;
    if (count <= 1) return;
    const ratios = paneRatios(count, ui.ratios);
    const panes = [...ui.panes];
    if (index === 0) {
        const next = panes.shift();
        if (next !== undefined) useStore.getState().setActive(next);
    } else panes.splice(index - 1, 1);
    // La largeur libérée va au voisin de gauche (ou de droite pour le premier).
    const freed = ratios[index] ?? 0;
    const nextRatios = [...ratios];
    nextRatios.splice(index, 1);
    const neighbour = Math.max(0, index - 1);
    if (nextRatios[neighbour] !== undefined) nextRatios[neighbour] += freed;
    savePanes(panes, nextRatios, Math.min(ui.focusedPane >= index ? Math.max(0, ui.focusedPane - 1) : ui.focusedPane, panes.length));
}

/** Garde ce volet seul à l'écran (il devient le principal). */
export function keepOnlyPane(index: number): void {
    if (index > 0) {
        const run = useUi.getState().panes[index - 1];
        if (run !== undefined) useStore.getState().setActive(run);
    }
    savePanes([], [], 0);
}

/** Place un onglet dans un volet précis (glisser-déposer au centre d'un volet). */
export function putInPane(runId: number, index: number): void {
    const ui = useUi.getState();
    const where = paneOf(runId);
    if (where === index) return ui.focusPane(index);
    // Déjà affiché ailleurs : on le retire de là-bas avant de le poser ici.
    if (where > 0) closePane(where);
    const fresh = useUi.getState();
    const target = where > 0 && where < index ? index - 1 : index;
    if (target === 0) {
        useStore.getState().setActive(runId);
        return fresh.focusPane(0);
    }
    const panes = [...fresh.panes];
    panes[target - 1] = runId;
    savePanes(panes, fresh.ratios, target);
}

/** Retire les volets dont l'onglet a été fermé, ou qui doublent le volet principal. */
export function prunePanes(runIds: number[]): void {
    const ui = useUi.getState();
    const main = paneRun(0);
    const keep = ui.panes.map((id, i) => ({ id, i })).filter(({ id }) => runIds.includes(id) && id !== main);
    if (keep.length === ui.panes.length) return;
    const ratios = paneRatios(ui.panes.length + 1, ui.ratios);
    savePanes(
        keep.map((k) => k.id),
        [ratios[0] ?? 1, ...keep.map((k) => ratios[k.i + 1] ?? 1)],
        Math.min(ui.focusedPane, keep.length),
    );
}

/** ⌘ sur Mac, Ctrl ailleurs, pour les libellés de raccourcis. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
export const ALT = MOD === '⌘' ? '⌥' : 'Alt';

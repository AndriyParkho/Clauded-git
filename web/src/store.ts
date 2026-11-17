import { create } from 'zustand';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
    AccountUsage,
    AskRequest,
    BatchItem,
    BrunoState,
    IssueFilter,
    IssueState,
    JobInfo,
    McpStatus,
    ModelChoice,
    PermissionEvent,
    ProgressStep,
    PullFilter,
    Quote,
    Repo,
    RepoIssues,
    RepoPulls,
    ReviewState,
    Run,
    ServerMessage,
    SlashCommandInfo,
    SpecFile,
    SpecPlan,
    UsageInfo,
} from '../../shared/protocol';

/** Ce que l'UI garde pour un onglet, en plus de la ligne `Run` venue du serveur. */
export interface RunView {
    messages: SDKMessage[];
    /** uuids déjà affichés, pour ne pas dupliquer un message rejoué. */
    seen: Set<string>;
    /** Texte en cours de streaming, pas encore reçu comme message complet. */
    partial: string;
    /** Outil dont l'appel est en cours de streaming (nom), pour l'indicateur. */
    partialTool: string | null;
    asks: AskRequest[];
    commands: SlashCommandInfo[];
    models: ModelChoice[];
    permissions: PermissionEvent[];
    jobs: JobInfo[];
    usage?: UsageInfo;
    /** Dernier résultat de `/mcp`, affiché dans une fenêtre au-dessus du chat (jamais dans le fil). */
    mcp?: McpStatus;
    loaded: boolean;
}

export interface Notice {
    id: number;
    at: string;
    message: string;
    runId?: number;
}

export type Page = 'chat' | 'issues' | 'pulls' | 'specs' | 'repos';
export type Panel = 'issue' | 'diff' | 'jobs' | 'pr' | 'review' | 'info' | 'spec' | 'versions' | 'plan';

export interface PullsState {
    filter: PullFilter;
    repoId: number | null;
    byRepo: RepoPulls[];
    loading: boolean;
    selected: { repoId: number; number: number } | null;
}

/** Clé d'une review dans le store. */
export const reviewKey = (repoId: number, prNumber: number): string => `${repoId}:${prNumber}`;

export interface IssuesState {
    filter: IssueFilter;
    state: IssueState;
    repoId: number | null;
    byRepo: RepoIssues[];
    loading: boolean;
    selected: { repoId: number; number: number } | null;
    /** Issues cochées pour une implémentation en lot (toutes du même dépôt). */
    checked: { repoId: number; numbers: number[] } | null;
}

interface State {
    connected: boolean;
    repos: Repo[];
    runs: Run[];
    views: Record<number, RunView>;
    activeRunId: number | null;
    page: Page;
    notices: Notice[];
    /** Conso du compte claude.ai (globale, relue par le serveur toutes les 5 min et après chaque tour). */
    account?: AccountUsage;
    /** Texte à pré-remplir dans la saisie d'un onglet (chat d'issue). */
    drafts: Record<number, string>;
    /** Panneau latéral ouvert par onglet. */
    panels: Record<number, Panel | null>;
    issues: IssuesState;
    pulls: PullsState;
    /** Reviews en préparation, par `reviewKey`. */
    reviews: Record<string, ReviewState>;
    /** Derniers états des jobs suivis hors d'un onglet (merge dans develop depuis une issue ou une PR), par id. */
    jobs: Record<string, JobInfo>;
    /** Opération longue en cours (ouverture d'une PR, implémentation) : loader bloquant et ses étapes. */
    progress: { opId: string; title: string; steps: ProgressStep[]; error?: string } | null;
    /** Issues de lots en attente de leurs dépendances (ou en échec). */
    batch: BatchItem[];
    /** Commande Bruno et checkout actif, par dépôt (chargé à la demande). */
    bruno: Record<number, BrunoState>;
    /** Dernier job de nettoyage lancé, par dépôt. */
    cleanupJobs: Record<number, string>;
    /** Fichier de spec (contenu en direct, versions) par onglet spec. */
    specs: Record<number, SpecFile>;
    /** Découpage de la spec en issues, par onglet spec. */
    specPlans: Record<number, SpecPlan>;
    /** Passages cités en attente, envoyés avec le prochain message de l'onglet. */
    quotes: Record<number, Quote[]>;

    apply(message: ServerMessage): void;
    setPulls(patch: Partial<PullsState>): void;
    setReview(review: ReviewState): void;
    setConnected(connected: boolean): void;
    setRepos(repos: Repo[]): void;
    setRuns(runs: Run[]): void;
    upsertRun(run: Run): void;
    removeRun(runId: number): void;
    setActive(runId: number | null): void;
    setPage(page: Page): void;
    markUnloaded(): void;
    notify(message: string, runId?: number): void;
    dismissNotice(id: number): void;
    setDraft(runId: number, text: string | undefined): void;
    setPanel(runId: number, panel: Panel | null): void;
    setIssues(patch: Partial<IssuesState>): void;
    dismissMcp(runId: number): void;
    addQuote(runId: number, quote: Omit<Quote, 'id'>): void;
    removeQuote(runId: number, id: string): void;
    clearQuotes(runId: number): void;
}

const emptyView = (): RunView => ({ messages: [], seen: new Set(), partial: '', partialTool: null, asks: [], commands: [], models: [], permissions: [], jobs: [], loaded: false });

let noticeId = 0;

function upsertJob(list: JobInfo[], job: JobInfo): JobInfo[] {
    const index = list.findIndex((j) => j.id === job.id);
    return index >= 0 ? list.map((j) => (j.id === job.id ? job : j)) : [...list, job];
}

export const useStore = create<State>((set, get) => ({
    connected: false,
    repos: [],
    runs: [],
    views: {},
    activeRunId: null,
    page: 'issues',
    notices: [],
    drafts: {},
    panels: {},
    issues: { filter: 'assigned', state: 'open', repoId: null, byRepo: [], loading: false, selected: null, checked: null },
    pulls: { filter: 'review', repoId: null, byRepo: [], loading: false, selected: null },
    reviews: {},
    jobs: {},
    progress: null,
    batch: [],
    bruno: {},
    cleanupJobs: {},
    specs: {},
    specPlans: {},
    quotes: {},
    addQuote: (runId, quote) => set((state) => ({ quotes: { ...state.quotes, [runId]: [...(state.quotes[runId] ?? []), { ...quote, id: crypto.randomUUID() }] } })),
    removeQuote: (runId, id) => set((state) => ({ quotes: { ...state.quotes, [runId]: (state.quotes[runId] ?? []).filter((q) => q.id !== id) } })),
    clearQuotes: (runId) =>
        set((state) => {
            const quotes = { ...state.quotes };
            delete quotes[runId];
            return { quotes };
        }),
    setPulls: (patch) => set((state) => ({ pulls: { ...state.pulls, ...patch } })),
    setReview: (review) => set((state) => ({ reviews: { ...state.reviews, [reviewKey(review.repoId, review.prNumber)]: review } })),

    setConnected: (connected) => set({ connected }),
    setRepos: (repos) => set({ repos }),
    setRuns: (runs) => set({ runs }),
    upsertRun: (run) =>
        set((state) => {
            const index = state.runs.findIndex((r) => r.id === run.id);
            const runs = index >= 0 ? state.runs.map((r) => (r.id === run.id ? run : r)) : [...state.runs, run];
            return { runs };
        }),
    removeRun: (runId) =>
        set((state) => {
            const views = { ...state.views };
            delete views[runId];
            const runs = state.runs.filter((r) => r.id !== runId);
            const activeRunId = state.activeRunId === runId ? (runs.at(-1)?.id ?? null) : state.activeRunId;
            return { runs, views, activeRunId, ...(activeRunId === null ? { page: 'issues' as Page } : {}) };
        }),
    setActive: (runId) => set({ activeRunId: runId, page: 'chat' }),
    setPage: (page) => set({ page }),
    markUnloaded: () =>
        set((state) => {
            const views: Record<number, RunView> = {};
            for (const [id, view] of Object.entries(state.views)) views[Number(id)] = { ...view, loaded: false };
            return { views };
        }),
    notify: (message, runId) =>
        set((state) => ({ notices: [...state.notices.slice(-9), { id: ++noticeId, at: new Date().toISOString(), message, ...(runId !== undefined ? { runId } : {}) }] })),
    dismissNotice: (id) => set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),
    setDraft: (runId, text) =>
        set((state) => {
            const drafts = { ...state.drafts };
            if (text === undefined) delete drafts[runId];
            else drafts[runId] = text;
            return { drafts };
        }),
    setPanel: (runId, panel) => set((state) => ({ panels: { ...state.panels, [runId]: panel } })),
    setIssues: (patch) => set((state) => ({ issues: { ...state.issues, ...patch } })),
    dismissMcp: (runId) =>
        set((state) => {
            const view = state.views[runId];
            if (!view) return {};
            const { mcp: _dropped, ...rest } = view;
            return { views: { ...state.views, [runId]: rest } };
        }),

    apply: (message) => {
        const state = get();
        const patchView = (runId: number, update: (view: RunView) => Partial<RunView>): void =>
            set((s) => {
                const view = s.views[runId] ?? emptyView();
                return { views: { ...s.views, [runId]: { ...view, ...update(view) } } };
            });

        switch (message.type) {
            case 'hello':
                set({ repos: message.repos, runs: message.runs, activeRunId: state.activeRunId ?? message.runs.at(-1)?.id ?? null, ...(message.account ? { account: message.account } : {}) });
                break;
            case 'batch':
                set({ batch: message.items });
                break;
            case 'spec':
                set((s) => ({ specs: { ...s.specs, [message.spec.runId]: message.spec } }));
                break;
            case 'specPlan':
                set((s) => ({ specPlans: { ...s.specPlans, [message.plan.runId]: message.plan } }));
                break;
            case 'account':
                set({ account: message.account });
                break;
            case 'run':
                if (message.run.archived) state.removeRun(message.run.id);
                else state.upsertRun(message.run);
                break;
            case 'runDeleted':
                state.removeRun(message.runId);
                break;
            case 'sdk':
                set((s) => ({ views: { ...s.views, [message.runId]: withMessage(s.views[message.runId] ?? emptyView(), message.message) } }));
                break;
            case 'replay':
                set((s) => {
                    const previous = s.views[message.runId];
                    let view: RunView = { ...emptyView(), asks: message.asks, commands: message.commands, models: message.models, jobs: message.jobs, loaded: true };
                    for (const m of message.messages) view = withMessage(view, m);
                    if (previous) view = { ...view, permissions: previous.permissions };
                    if (message.usage) view = { ...view, usage: message.usage };
                    return { views: { ...s.views, [message.runId]: view } };
                });
                break;
            case 'mcp':
                patchView(message.status.runId, () => ({ mcp: message.status }));
                break;
            case 'ask':
                patchView(message.ask.runId, (view) => (view.asks.some((a) => a.id === message.ask.id) ? {} : { asks: [...view.asks, message.ask] }));
                break;
            case 'askResolved':
                patchView(message.runId, (view) => ({ asks: view.asks.filter((a) => a.id !== message.requestId) }));
                break;
            case 'permission':
                patchView(message.event.runId, (view) => ({ permissions: [...view.permissions.slice(-199), message.event] }));
                break;
            case 'commands':
                patchView(message.runId, () => ({ commands: message.commands }));
                break;
            case 'models':
                patchView(message.runId, () => ({ models: message.models }));
                break;
            case 'usage':
                patchView(message.usage.runId, () => ({ usage: message.usage }));
                break;
            case 'job': {
                // Un nettoyage (tâche de fond) qui se termine le signale, où que l'on soit dans l'app.
                const previous = state.jobs[message.job.id];
                if (previous?.status === 'running' && message.job.status !== 'running' && Object.values(state.cleanupJobs).includes(message.job.id)) {
                    state.notify(`${message.job.name} : ${message.job.output.trim().split('\n').at(-1) ?? ''}`);
                }
                // Tous les jobs sont suivis par id ; ceux d'un onglet (runId > 0) vont aussi dans sa vue.
                set((s) => ({ jobs: { ...s.jobs, [message.job.id]: message.job } }));
                if (message.job.runId > 0) patchView(message.job.runId, (view) => ({ jobs: upsertJob(view.jobs, message.job) }));
                break;
            }
            case 'progress':
                set((s) => (s.progress?.opId === message.opId ? { progress: { ...s.progress, steps: message.steps } } : {}));
                break;
            case 'review':
                state.setReview(message.review);
                break;
            case 'error':
                state.notify(message.message, message.runId);
                break;
        }
    },
}));

/** Intègre un message du SDK dans la vue : streaming à part, dédoublonnage par uuid. */
function withMessage(view: RunView, message: SDKMessage): RunView {
    if (message.type === 'stream_event') {
        const event = message.event as { type: string; delta?: { type: string; text?: string }; content_block?: { type: string; name?: string } };
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            return { ...view, partial: view.partial + (event.delta.text ?? '') };
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            return { ...view, partialTool: event.content_block.name ?? 'outil' };
        }
        if (event.type === 'message_stop') return { ...view, partialTool: null };
        return view;
    }
    const uuid = (message as { uuid?: string }).uuid;
    if (uuid && view.seen.has(uuid)) return view;
    const seen = new Set(view.seen);
    if (uuid) seen.add(uuid);
    const next: RunView = { ...view, seen, messages: [...view.messages, message] };
    if (message.type === 'assistant' || message.type === 'result') {
        next.partial = '';
        next.partialTool = null;
    }
    return next;
}

export function activeRun(state: State): Run | undefined {
    return state.runs.find((r) => r.id === state.activeRunId);
}

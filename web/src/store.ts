import { create } from 'zustand';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AskRequest, IssueFilter, IssueState, JobInfo, ModelChoice, PermissionEvent, Repo, RepoIssues, Run, ServerMessage, SlashCommandInfo, UsageInfo } from '../../shared/protocol';

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
    loaded: boolean;
}

export interface Notice {
    id: number;
    at: string;
    message: string;
    runId?: number;
}

export type Page = 'chat' | 'issues' | 'repos';
export type Panel = 'issue' | 'diff' | 'jobs' | 'pr';

export interface IssuesState {
    filter: IssueFilter;
    state: IssueState;
    repoId: number | null;
    byRepo: RepoIssues[];
    loading: boolean;
    selected: { repoId: number; number: number } | null;
}

interface State {
    connected: boolean;
    repos: Repo[];
    runs: Run[];
    views: Record<number, RunView>;
    activeRunId: number | null;
    page: Page;
    notices: Notice[];
    /** Dernières limites du compte vues, quelle que soit la session (elles sont globales). */
    limits?: UsageInfo;
    /** Texte à pré-remplir dans la saisie d'un onglet (chat d'issue). */
    drafts: Record<number, string>;
    /** Panneau latéral ouvert par onglet. */
    panels: Record<number, Panel | null>;
    issues: IssuesState;

    apply(message: ServerMessage): void;
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
    issues: { filter: 'assigned', state: 'open', repoId: null, byRepo: [], loading: false, selected: null },

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

    apply: (message) => {
        const state = get();
        const patchView = (runId: number, update: (view: RunView) => Partial<RunView>): void =>
            set((s) => {
                const view = s.views[runId] ?? emptyView();
                return { views: { ...s.views, [runId]: { ...view, ...update(view) } } };
            });

        switch (message.type) {
            case 'hello':
                set({ repos: message.repos, runs: message.runs, activeRunId: state.activeRunId ?? message.runs.at(-1)?.id ?? null });
                break;
            case 'run':
                state.upsertRun(message.run);
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
                    return { views: { ...s.views, [message.runId]: view }, ...(message.usage?.limits ? { limits: message.usage } : {}) };
                });
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
                if (message.usage.limits) set({ limits: message.usage });
                break;
            case 'job':
                patchView(message.job.runId, (view) => ({ jobs: upsertJob(view.jobs, message.job) }));
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

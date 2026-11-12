import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
    getSessionMessages,
    query,
    type PermissionMode,
    type PermissionResult,
    type Query,
    type SDKMessage,
    type SessionMessage,
    type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { getRun, updateRun } from '../db.js';
import { PromptQueue, sessionOptions } from './options.js';
import type { AskRequest, ModelChoice, PermissionEvent, RateWindow, Run, SlashCommandInfo, UsageInfo } from '../../shared/protocol.js';

/** Outils dont l'appel est une question à l'utilisateur, à afficher comme une carte dans le chat. */
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** Nombre de messages gardés en mémoire par session, pour rejouer un onglet rouvert. */
const BUFFER_LIMIT = 3000;

interface Live {
    run: Run;
    q: Query;
    queue: PromptQueue;
    messages: SDKMessage[];
    asks: Map<string, { ask: AskRequest; resolve: (result: PermissionResult) => void }>;
    commands: SlashCommandInfo[];
    models: ModelChoice[];
    usage?: UsageInfo;
}

export interface ManagerEvents {
    sdk: [runId: number, message: SDKMessage];
    run: [run: Run];
    ask: [ask: AskRequest];
    askResolved: [runId: number, requestId: string];
    permission: [event: PermissionEvent];
    commands: [runId: number, commands: SlashCommandInfo[]];
    models: [runId: number, models: ModelChoice[]];
    usage: [usage: UsageInfo];
    error: [runId: number | undefined, message: string];
}

export interface AnswerParams {
    allow: boolean;
    updatedInput?: Record<string, unknown> | undefined;
    message?: string | undefined;
}

/** Un message relu depuis le transcript d'une session, remis dans la forme des messages du SDK. */
function fromHistory(message: SessionMessage): SDKMessage {
    return {
        type: message.type,
        message: message.message,
        uuid: message.uuid,
        session_id: message.session_id,
        parent_tool_use_id: message.parent_tool_use_id,
    } as unknown as SDKMessage;
}

function toCommandInfo(command: SlashCommand): SlashCommandInfo {
    return { name: command.name, description: command.description, argumentHint: command.argumentHint };
}

function toWindow(window: { utilization: number | null; resets_at: string | null } | null | undefined): RateWindow | undefined {
    return window ? { utilization: window.utilization, resetsAt: window.resets_at } : undefined;
}

/**
 * Gère les sessions Claude vivantes : une par onglet ouvert. Les messages du SDK sont diffusés
 * par événements ; l'état de l'onglet est persisté dans la base.
 */
export class SessionManager extends EventEmitter<ManagerEvents> {
    private readonly live = new Map<number, Live>();

    isLive(runId: number): boolean {
        return this.live.has(runId);
    }

    /** Rediffuse un onglet modifié en base par quelqu'un d'autre (install terminée, PR trouvée…). */
    notifyRun(runId: number): void {
        const run = getRun(runId);
        if (!run) return;
        const live = this.live.get(runId);
        if (live) live.run = run;
        this.emit('run', run);
    }

    /** Démarre la session d'un onglet (nouvelle, ou reprise de `run.sessionId`). Sans effet si déjà vivante. */
    async open(runId: number): Promise<Run> {
        const existing = this.live.get(runId);
        if (existing) return existing.run;
        const run = getRun(runId);
        if (!run) throw new Error(`onglet ${runId} introuvable`);

        const queue = new PromptQueue();
        const live: Live = { run, q: undefined as unknown as Query, queue, messages: [], asks: new Map(), commands: [], models: [] };
        live.q = query({
            prompt: queue,
            options: sessionOptions({
                cwd: run.cwd,
                resume: run.sessionId ?? undefined,
                permissionMode: run.permissionMode ?? undefined,
                model: run.model ?? undefined,
                includePartialMessages: true,
                canUseTool: (tool, input) => this.decidePermission(live, tool, input),
            }),
        });
        this.live.set(runId, live);
        // Le CLI accepte un prompt dès maintenant ; le message `init` n'arrive qu'avec le premier tour.
        this.patch(live, { state: 'idle', lastError: null });

        // Commandes slash, modèles et compte sont connus dès le démarrage du CLI.
        void live.q
            .initializationResult()
            .then((init) => {
                live.commands = init.commands.map(toCommandInfo);
                live.models = init.models.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }));
                this.emit('commands', runId, live.commands);
                this.emit('models', runId, live.models);
            })
            .catch(() => undefined);

        if (run.sessionId) {
            try {
                const history = await getSessionMessages(run.sessionId, { dir: run.cwd });
                live.messages.push(...history.map(fromHistory));
            } catch (error) {
                this.emit('error', runId, `historique illisible : ${String(error)}`);
            }
        }
        void this.pump(live);
        return live.run;
    }

    async prompt(runId: number, text: string): Promise<void> {
        const live = this.live.get(runId) ?? (await this.open(runId).then(() => this.live.get(runId)));
        if (!live) throw new Error(`onglet ${runId} introuvable`);
        const message = live.queue.push(text);
        // Le CLI ne renvoie pas nos propres prompts : on les garde pour l'affichage et le rejeu.
        const echo = { ...message, session_id: live.run.sessionId ?? '' } as SDKMessage;
        this.remember(live, echo);
        this.emit('sdk', runId, echo);
        this.patch(live, { state: 'running' });
    }

    async interrupt(runId: number): Promise<void> {
        const live = this.live.get(runId);
        if (!live) return;
        await live.q.interrupt();
    }

    /** Répond à une question de Claude ou à une demande de validation de plan. */
    answer(runId: number, requestId: string, params: AnswerParams): void {
        const live = this.live.get(runId);
        const pending = live?.asks.get(requestId);
        if (!live || !pending) throw new Error(`question ${requestId} introuvable`);
        live.asks.delete(requestId);
        if (params.allow) {
            const result: PermissionResult = { behavior: 'allow', updatedInput: params.updatedInput ?? pending.ask.input };
            // Un plan validé enchaîne sur l'implémentation : on sort du plan mode pour la session.
            if (pending.ask.tool === 'ExitPlanMode') result.updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
            pending.resolve(result);
        } else {
            pending.resolve({ behavior: 'deny', message: params.message ?? 'Refusé par l\'utilisateur.' });
        }
        this.emit('askResolved', runId, requestId);
        if (live.asks.size === 0) this.patch(live, { state: 'running' });
    }

    async setPermissionMode(runId: number, mode: PermissionMode): Promise<void> {
        const live = this.live.get(runId);
        if (!live) {
            updateRun(runId, { permissionMode: mode });
            const run = getRun(runId);
            if (run) this.emit('run', run);
            return;
        }
        await live.q.setPermissionMode(mode);
        this.patch(live, { permissionMode: mode });
    }

    async setModel(runId: number, model: string): Promise<void> {
        const live = this.live.get(runId);
        if (!live) {
            updateRun(runId, { model });
            const run = getRun(runId);
            if (run) this.emit('run', run);
            return;
        }
        await live.q.setModel(model);
        this.patch(live, { model });
    }

    /** Ferme la session Claude d'un onglet (le transcript reste reprenable). */
    close(runId: number): void {
        const live = this.live.get(runId);
        if (!live) return;
        this.live.delete(runId);
        live.queue.close();
        for (const pending of live.asks.values()) pending.resolve({ behavior: 'deny', message: 'Session fermée.' });
        live.asks.clear();
        try {
            live.q.close();
        } catch {
            // déjà terminée
        }
        this.patch(live, { state: 'closed' });
    }

    closeAll(): void {
        for (const runId of [...this.live.keys()]) this.close(runId);
    }

    /** Tout ce qu'il faut pour réafficher un onglet : messages, questions en attente, commandes, modèles, conso. */
    replay(runId: number): { messages: SDKMessage[]; asks: AskRequest[]; commands: SlashCommandInfo[]; models: ModelChoice[]; usage?: UsageInfo } {
        const live = this.live.get(runId);
        if (!live) return { messages: [], asks: [], commands: [], models: [] };
        return {
            messages: live.messages,
            asks: [...live.asks.values()].map((p) => p.ask),
            commands: live.commands,
            models: live.models,
            ...(live.usage ? { usage: live.usage } : {}),
        };
    }

    // -----------------------------------------------------------------------------------------

    private decidePermission(live: Live, tool: string, input: Record<string, unknown>): Promise<PermissionResult> {
        if (!ASK_TOOLS.has(tool)) {
            this.emit('permission', { runId: live.run.id, tool, input, at: new Date().toISOString() });
            return Promise.resolve({ behavior: 'allow', updatedInput: input });
        }
        const ask: AskRequest = { id: randomUUID(), runId: live.run.id, tool, input, createdAt: new Date().toISOString() };
        return new Promise((resolve) => {
            live.asks.set(ask.id, { ask, resolve });
            this.patch(live, { state: 'waiting' });
            this.emit('ask', ask);
        });
    }

    private remember(live: Live, message: SDKMessage): void {
        if (message.type === 'stream_event') return;
        live.messages.push(message);
        if (live.messages.length > BUFFER_LIMIT) live.messages.splice(0, live.messages.length - BUFFER_LIMIT);
    }

    /** Contexte utilisé par la session et limites du compte, après chaque tour. */
    private async refreshUsage(live: Live): Promise<void> {
        const usage: UsageInfo = { runId: live.run.id, at: new Date().toISOString() };
        try {
            const context = await live.q.getContextUsage();
            usage.context = { tokens: context.totalTokens, max: context.maxTokens, percent: context.percentage };
        } catch {
            // session déjà fermée, ou CLI trop ancien
        }
        try {
            const account = await live.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
            usage.subscription = account.subscription_type;
            const limits = account.rate_limits;
            if (limits) {
                const windows: NonNullable<UsageInfo['limits']> = {};
                const fiveHour = toWindow(limits.five_hour);
                const sevenDay = toWindow(limits.seven_day);
                const sevenDayOpus = toWindow(limits.seven_day_opus);
                const sevenDaySonnet = toWindow(limits.seven_day_sonnet);
                if (fiveHour) windows.fiveHour = fiveHour;
                if (sevenDay) windows.sevenDay = sevenDay;
                if (sevenDayOpus) windows.sevenDayOpus = sevenDayOpus;
                if (sevenDaySonnet) windows.sevenDaySonnet = sevenDaySonnet;
                if (limits.extra_usage) {
                    windows.extra = { enabled: limits.extra_usage.is_enabled, used: limits.extra_usage.used_credits, limit: limits.extra_usage.monthly_limit, utilization: limits.extra_usage.utilization };
                }
                usage.limits = windows;
            } else {
                usage.limits = null;
            }
        } catch {
            // idem
        }
        if (this.live.get(live.run.id) !== live) return;
        live.usage = usage;
        this.emit('usage', usage);
    }

    private async pump(live: Live): Promise<void> {
        const runId = live.run.id;
        try {
            for await (const message of live.q) {
                this.remember(live, message);
                this.emit('sdk', runId, message);
                if (message.type === 'system' && message.subtype === 'init') {
                    this.patch(live, { sessionId: message.session_id, model: message.model, permissionMode: message.permissionMode });
                } else if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) {
                    this.patch(live, { permissionMode: message.permissionMode });
                } else if (message.type === 'result') {
                    this.patch(live, { state: 'idle', costUsd: message.total_cost_usd });
                    void this.refreshUsage(live);
                }
            }
            if (this.live.get(runId) === live) {
                this.live.delete(runId);
                this.patch(live, { state: 'closed' });
            }
        } catch (error) {
            if (this.live.get(runId) === live) this.live.delete(runId);
            this.patch(live, { state: 'error', lastError: String(error) });
            this.emit('error', runId, String(error));
        }
    }

    private patch(live: Live, patch: Partial<Run>): void {
        const run = updateRun(live.run.id, patch);
        if (!run) return;
        live.run = run;
        this.emit('run', run);
    }
}

export const sessions = new SessionManager();

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
    getSessionMessages,
    type EffortLevel,
    query,
    type PermissionMode,
    type PermissionResult,
    type Query,
    type SDKMessage,
    type SessionMessage,
    type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { artifactInstructions } from '../artifacts.js';
import { DEFAULT_EFFORT } from '../config.js';
import { getRun, updateRun } from '../db.js';
import { probeUsage, readUsage } from './account.js';
import { PromptQueue, sessionOptions } from './options.js';
import { intentHooks, intentInstructions } from './intent.js';
import { CONTEXT_HINTS, sessionMcp } from './scope.js';
import type { AccountUsage, AskRequest, ImageAttachment, McpAction, McpServerInfo, McpStatus, ModelChoice, PermissionEvent, Run, SlashCommandInfo, UsageInfo } from '../../shared/protocol.js';

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
    mcp: [status: McpStatus];
    run: [run: Run];
    ask: [ask: AskRequest];
    askResolved: [runId: number, requestId: string];
    permission: [event: PermissionEvent];
    commands: [runId: number, commands: SlashCommandInfo[]];
    models: [runId: number, models: ModelChoice[]];
    /** La conversation de l'onglet repart de zéro (`/clear`) : les clients rejouent l'onglet. */
    reset: [runId: number];
    usage: [usage: UsageInfo];
    account: [account: AccountUsage];
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

/** Écart minimal entre deux lectures de la conso du compte (sauf demande explicite). */
const ACCOUNT_MIN_INTERVAL_MS = 60_000;
/** Lecture périodique, même sans onglet actif, pour que la jauge et les resets restent à jour. */
const ACCOUNT_POLL_MS = 5 * 60_000;

/**
 * Gère les sessions Claude vivantes : une par onglet ouvert. Les messages du SDK sont diffusés
 * par événements ; l'état de l'onglet est persisté dans la base.
 */
export class SessionManager extends EventEmitter<ManagerEvents> {
    private readonly live = new Map<number, Live>();
    /** Ouvertures en cours (la lecture du profil précède le démarrage du CLI). */
    private readonly opening = new Map<number, Promise<Run>>();
    private account: AccountUsage | undefined;
    private accountRead: Promise<void> | undefined;
    private accountTimer: NodeJS.Timeout | undefined;

    /** Dernière conso du compte connue (envoyée à chaque client qui se connecte). */
    get accountUsage(): AccountUsage | undefined {
        return this.account;
    }

    /** Lit la conso du compte maintenant puis toutes les 5 min. */
    startAccountPolling(): void {
        void this.refreshAccount();
        this.accountTimer ??= setInterval(() => void this.refreshAccount(), ACCOUNT_POLL_MS);
        this.accountTimer.unref();
    }

    /**
     * Relit la conso du compte (5 h, 7 j, par modèle, dates de reset), via une session ouverte ou à
     * défaut une session sonde. Une lecture déjà en cours est partagée ; sans `force`, au plus une par minute.
     */
    refreshAccount(force = false): Promise<void> {
        if (this.accountRead) return this.accountRead;
        if (!force && this.account && !this.account.error && Date.now() - new Date(this.account.at).getTime() < ACCOUNT_MIN_INTERVAL_MS) return Promise.resolve();
        this.accountRead = (async () => {
            const live = [...this.live.values()][0];
            let account: AccountUsage;
            try {
                account = live ? await readUsage(live.q).catch(() => probeUsage()) : await probeUsage();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                account = { ...(this.account ?? { subscription: null, available: false, windows: [] }), at: new Date().toISOString(), error: message };
            }
            this.account = account;
            this.emit('account', account);
        })().finally(() => {
            this.accountRead = undefined;
        });
        return this.accountRead;
    }

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
    open(runId: number): Promise<Run> {
        const existing = this.live.get(runId);
        if (existing) return Promise.resolve(existing.run);
        let opening = this.opening.get(runId);
        if (!opening) {
            opening = this.start(runId).finally(() => this.opening.delete(runId));
            this.opening.set(runId, opening);
        }
        return opening;
    }

    private async start(runId: number): Promise<Run> {
        const run = getRun(runId);
        if (!run) throw new Error(`onglet ${runId} introuvable`);
        const onlyMcp = await sessionMcp(run);

        const queue = new PromptQueue();
        const live: Live = { run, q: undefined as unknown as Query, queue, messages: [], asks: new Map(), commands: [], models: [] };
        // Noms des serveurs MCP de la session, lus une fois (garde-fou d'environnement d'une investigation).
        let servers: Promise<string[]> | undefined;
        const mcpServers = (): Promise<string[]> => (servers ??= live.q.mcpServerStatus().then((list) => list.map((s) => s.name)));
        const intent = intentInstructions(run);
        live.q = query({
            prompt: queue,
            options: sessionOptions({
                cwd: run.cwd,
                resume: run.sessionId ?? undefined,
                permissionMode: run.permissionMode ?? undefined,
                model: run.model ?? undefined,
                effort: run.effort ?? DEFAULT_EFFORT,
                onlyMcp,
                includePartialMessages: true,
                canUseTool: (tool, input) => this.decidePermission(live, tool, input),
                appendSystemPrompt: [artifactInstructions(run.id), CONTEXT_HINTS, ...(intent ? [intent] : [])].join('\n\n'),
                hooks: intentHooks(run, mcpServers),
            }),
        });
        this.live.set(runId, live);
        // Le CLI accepte un prompt dès maintenant ; le message `init` n'arrive qu'avec le premier tour.
        // Rouvrir un onglet archivé le ramène dans la barre d'onglets.
        this.patch(live, { state: 'idle', lastError: null, archived: false });

        // Commandes slash, modèles et compte sont connus dès le démarrage du CLI.
        void live.q
            .initializationResult()
            .then((init) => {
                live.commands = init.commands.map(toCommandInfo);
                live.models = init.models.map((m) => ({
                    value: m.value,
                    displayName: m.displayName,
                    description: m.description,
                    ...(m.supportsEffort && m.supportedEffortLevels?.length ? { efforts: m.supportedEffortLevels } : {}),
                }));
                this.emit('commands', runId, live.commands);
                this.emit('models', runId, live.models);
                void this.refreshUsage(live);
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

    async prompt(runId: number, text: string, images: ImageAttachment[] = []): Promise<void> {
        const live = this.live.get(runId) ?? (await this.open(runId).then(() => this.live.get(runId)));
        if (!live) throw new Error(`onglet ${runId} introuvable`);
        // `/mcp` : l'app affiche l'état des serveurs dans une fenêtre, rien n'entre dans la conversation.
        if (text.trim() === '/mcp' && images.length === 0) {
            await this.mcp(runId, 'status');
            return;
        }
        // `/clear` : nouvelle conversation dans le même onglet (le transcript précédent reste sur le disque).
        if (text.trim() === '/clear' && images.length === 0) {
            await this.reset(runId);
            return;
        }
        const message = live.queue.push(text, images);
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

    /** Fichiers d'instructions que la session a chargés (CLAUDE.md, mémoire), ou rien sans session ouverte. */
    async loadedMemoryFiles(runId: number): Promise<Array<{ path: string; tokens: number }>> {
        const live = this.live.get(runId);
        if (!live) return [];
        try {
            const context = await live.q.getContextUsage({ detail: 'summary' });
            return context.memoryFiles.map((f) => ({ path: f.path, tokens: f.tokens }));
        } catch {
            return live.usage?.context?.memoryFiles ?? [];
        }
    }

    /** État des serveurs MCP de la session, après une action éventuelle (reconnexion, activation). */
    async mcp(runId: number, action: McpAction, server?: string): Promise<void> {
        const live = this.live.get(runId);
        if (!live) throw new Error(`onglet ${runId} sans session`);
        try {
            if (action === 'reconnect' && server) await live.q.reconnectMcpServer(server);
            else if ((action === 'enable' || action === 'disable') && server) await live.q.toggleMcpServer(server, action === 'enable');
        } catch (error) {
            this.emit('error', runId, `MCP ${server ?? ''} : ${error instanceof Error ? error.message : String(error)}`);
        }
        const servers = await live.q.mcpServerStatus();
        const status: McpStatus = {
            runId,
            at: new Date().toISOString(),
            servers: servers.map((s): McpServerInfo => {
                const config = (s.config ?? {}) as { type?: string; url?: string; command?: string; args?: string[] };
                const transport = config.type ?? (config.url ? 'http' : config.command ? 'stdio' : undefined);
                const target = config.url ?? (config.command ? [config.command, ...(config.args ?? [])].join(' ') : undefined);
                return {
                    name: s.name,
                    status: s.status,
                    ...(s.scope ? { scope: s.scope } : {}),
                    ...(s.source ? { source: s.source } : {}),
                    ...(s.serverInfo?.version ? { version: s.serverInfo.version } : {}),
                    ...(transport ? { transport } : {}),
                    ...(target ? { target } : {}),
                    ...(s.error ? { error: s.error } : {}),
                    tools: (s.tools ?? []).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })),
                };
            }),
        };
        this.emit('mcp', status);
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

    /**
     * Effort de la session : appliqué tout de suite à une session ouverte (tours suivants), retenu
     * pour l'onglet dans tous les cas.
     */
    async setEffort(runId: number, effort: EffortLevel): Promise<void> {
        const live = this.live.get(runId);
        if (!live) {
            updateRun(runId, { effort });
            const run = getRun(runId);
            if (run) this.emit('run', run);
            return;
        }
        await live.q.applyFlagSettings({ effortLevel: effort });
        this.patch(live, { effort });
    }

    /**
     * Nouvelle conversation dans le même onglet (comme `/clear`) : la session est fermée, l'onglet
     * oublie son identifiant de session et en démarre une neuve, avec les mêmes réglages.
     */
    async reset(runId: number): Promise<Run> {
        const live = this.live.get(runId);
        if (live && live.run.state === 'running') throw new Error('Claude travaille encore : interromps le tour avant de repartir de zéro.');
        this.close(runId);
        updateRun(runId, { sessionId: null, costUsd: 0, lastError: null });
        const run = await this.open(runId);
        this.emit('reset', runId);
        return run;
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

    /** Contexte utilisé par la session après chaque tour ; la conso du compte est relue à part. */
    private async refreshUsage(live: Live): Promise<void> {
        const usage: UsageInfo = { runId: live.run.id, at: new Date().toISOString() };
        try {
            const context = await live.q.getContextUsage({ detail: 'summary' });
            const parts = context.categories
                .filter((c) => c.kind === 'used' && c.tokens > 0)
                .map((c) => ({ id: c.id ?? c.name, name: c.name, tokens: c.tokens }))
                .sort((a, b) => b.tokens - a.tokens);
            usage.context = {
                tokens: context.totalTokens,
                max: context.maxTokens,
                percent: context.percentage,
                parts,
                memoryFiles: context.memoryFiles.map((f) => ({ path: f.path, tokens: f.tokens })),
                ...(context.isAutoCompactEnabled && context.autoCompactThreshold ? { autoCompactAt: context.autoCompactThreshold } : {}),
            };
        } catch {
            // session déjà fermée, ou CLI trop ancien
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
                // Un tour peut démarrer sans prompt de notre part : Claude reprend la main quand un
                // sous-agent (ou une commande) lancé en arrière-plan termine.
                if ((message.type === 'assistant' || message.type === 'stream_event') && message.parent_tool_use_id === null && live.run.state === 'idle') {
                    this.patch(live, { state: 'running' });
                }
                if (message.type === 'system' && message.subtype === 'init') {
                    this.patch(live, { sessionId: message.session_id, model: message.model, permissionMode: message.permissionMode });
                } else if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) {
                    this.patch(live, { permissionMode: message.permissionMode });
                } else if (message.type === 'result') {
                    this.patch(live, { state: 'idle', costUsd: message.total_cost_usd });
                    void this.refreshUsage(live);
                    void this.refreshAccount();
                } else if (message.type === 'rate_limit_event') {
                    // Une fenêtre a changé d'état (seuil franchi, limite atteinte) : on relit tout.
                    void this.refreshAccount(true);
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

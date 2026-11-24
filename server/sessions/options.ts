import { randomUUID } from 'node:crypto';
import type { CanUseTool, EffortLevel, HookCallbackMatcher, HookEvent, McpServerConfig, Options, PermissionMode, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageAttachment } from '../../shared/protocol.js';

type MessageParam = SDKUserMessage['message'];

/**
 * File de prompts consommée par le SDK en mode « entrée en flux » : la session reste ouverte entre
 * deux tours, comme dans un chat Claude Code.
 */
export class PromptQueue implements AsyncIterable<SDKUserMessage> {
    private readonly items: SDKUserMessage[] = [];
    private readonly waiters: Array<(result: IteratorResult<SDKUserMessage, void>) => void> = [];
    private closed = false;

    /** Ajoute un prompt (texte et images jointes) et renvoie le message tel qu'il sera envoyé (avec son uuid). */
    push(text: string, images: ImageAttachment[] = []): SDKUserMessage {
        if (this.closed) throw new Error('file de prompts fermée');
        const content: MessageParam['content'] =
            images.length === 0
                ? text
                : [...(text ? [{ type: 'text' as const, text }] : []), ...images.map((image) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } }))];
        const message: SDKUserMessage = {
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
            uuid: randomUUID(),
        };
        const waiter = this.waiters.shift();
        if (waiter) waiter({ value: message, done: false });
        else this.items.push(message);
        return message;
    }

    close(): void {
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    }

    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, void> {
        return {
            next: () => {
                const message = this.items.shift();
                if (message) return Promise.resolve({ value: message, done: false });
                if (this.closed) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => this.waiters.push(resolve));
            },
        };
    }
}

export interface SessionParams {
    cwd: string;
    resume?: string | undefined;
    permissionMode?: PermissionMode | undefined;
    model?: string | undefined;
    effort?: EffortLevel | undefined;
    /**
     * Seulement ces serveurs MCP (ni ceux du compte, ni des plugins, ni de claude.ai). Absent : tous
     * les serveurs, comme Claude Code.
     */
    onlyMcp?: Record<string, McpServerConfig> | undefined;
    includePartialMessages?: boolean;
    maxTurns?: number;
    abortController?: AbortController;
    canUseTool: CanUseTool;
    /** Ajouté au prompt système Claude Code (consignes propres à l'app). */
    appendSystemPrompt?: string;
    /** Hooks propres à l'onglet (garde-fous d'un chat en lecture seule). */
    hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined;
}

/**
 * Options d'une session « comme Claude Code » : prompt système Claude Code et toutes les sources de
 * réglages (CLAUDE.md, skills, hooks, plugins du repo et du compte). Les permissions sont décidées
 * par `canUseTool`, c'est-à-dire par l'app.
 */
export function sessionOptions(params: SessionParams): Options {
    const options: Options = {
        cwd: params.cwd,
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(params.appendSystemPrompt ? { append: params.appendSystemPrompt } : {}) },
        settingSources: ['user', 'project', 'local'],
        permissionMode: params.permissionMode ?? 'default',
        canUseTool: params.canUseTool,
        includePartialMessages: params.includePartialMessages ?? false,
        // Une app lancée depuis un terminal Claude Code ne doit pas passer pour une session imbriquée.
        env: { ...process.env, CLAUDECODE: undefined },
    };
    if (params.resume) options.resume = params.resume;
    if (params.model) options.model = params.model;
    if (params.effort) options.effort = params.effort;
    if (params.onlyMcp) {
        options.mcpServers = params.onlyMcp;
        options.strictMcpConfig = true;
        options.settings = { disableClaudeAiConnectors: true };
    }
    if (params.hooks) options.hooks = params.hooks;
    if (params.maxTurns) options.maxTurns = params.maxTurns;
    if (params.abortController) options.abortController = params.abortController;
    return options;
}

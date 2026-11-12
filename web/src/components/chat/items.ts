import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Un bloc de contenu de l'API, lu de façon tolérante. */
interface Block {
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
}

export interface ToolItem {
    kind: 'tool';
    key: string;
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: { content: string; isError: boolean };
    /** Messages d'un sous-agent lancé par cet outil. */
    children: Item[];
}

export type Item =
    | { kind: 'user'; key: string; text: string }
    | { kind: 'system-note'; key: string; title: string; text: string }
    | { kind: 'local'; key: string; text: string }
    | { kind: 'text'; key: string; text: string }
    | { kind: 'thinking'; key: string; text: string }
    | ToolItem
    | { kind: 'init'; key: string; model: string; version: string; commands: number; skills: number; mcp: string[] }
    | { kind: 'compact'; key: string; preTokens: number; postTokens: number | undefined }
    | { kind: 'result'; key: string; subtype: string; durationMs: number; costUsd: number; numTurns: number; errors: string[] };

function resultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part: Block) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`)).join('\n');
    }
    return content === undefined || content === null ? '' : JSON.stringify(content, null, 2);
}

const tag = (text: string, name: string): string | undefined => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

/**
 * Les messages « utilisateur » que le CLI fabrique lui-même : sortie d'une commande locale
 * (`/compact`, `/cost`…), écho d'une commande slash, résumé après compaction.
 */
function classifyUser(text: string, synthetic: boolean): Item | undefined {
    const stdout = tag(text, 'local-command-stdout');
    if (stdout !== undefined) return { kind: 'local', key: '', text: stdout || '(aucune sortie)' };
    const stderr = tag(text, 'local-command-stderr');
    if (stderr !== undefined) return { kind: 'local', key: '', text: stderr };
    const command = tag(text, 'command-name');
    if (command !== undefined) {
        const args = tag(text, 'command-args');
        return { kind: 'user', key: '', text: `${command}${args ? ` ${args}` : ''}` };
    }
    if (text.startsWith('This session is being continued from a previous conversation')) {
        return { kind: 'system-note', key: '', title: 'résumé après compaction', text };
    }
    if (synthetic || text.startsWith('<system-reminder>')) return { kind: 'system-note', key: '', title: 'message système', text };
    return undefined;
}

/** Transforme la suite brute des messages du SDK en éléments à afficher, résultats d'outils rattachés. */
export function buildItems(messages: SDKMessage[]): Item[] {
    const items: Item[] = [];
    const tools = new Map<string, ToolItem>();
    const target = (parent: string | null | undefined): Item[] => (parent && tools.get(parent)?.children) || items;
    let initShown = false;

    messages.forEach((message, index) => {
        const key = (message as { uuid?: string }).uuid ?? `m${index}`;
        switch (message.type) {
            case 'user': {
                const content = message.message.content as string | Block[];
                const list = target(message.parent_tool_use_id);
                const synthetic = Boolean((message as { isSynthetic?: boolean }).isSynthetic);
                const pushText = (text: string, k: string): void => {
                    if (!text.trim()) return;
                    const special = classifyUser(text, synthetic);
                    list.push(special ? { ...special, key: k } : { kind: 'user', key: k, text });
                };
                if (typeof content === 'string') {
                    pushText(content, key);
                    break;
                }
                content.forEach((block, i) => {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const tool = tools.get(block.tool_use_id);
                        if (tool) tool.result = { content: resultText(block.content), isError: Boolean(block.is_error) };
                    } else if (block.type === 'text' && block.text) {
                        pushText(block.text, `${key}-${i}`);
                    }
                });
                break;
            }
            case 'assistant': {
                const list = target(message.parent_tool_use_id);
                (message.message.content as Block[]).forEach((block, i) => {
                    if (block.type === 'text' && block.text) list.push({ kind: 'text', key: `${key}-${i}`, text: block.text });
                    else if (block.type === 'thinking' && block.thinking) list.push({ kind: 'thinking', key: `${key}-${i}`, text: block.thinking });
                    else if (block.type === 'tool_use' && block.id && block.name) {
                        const tool: ToolItem = { kind: 'tool', key: `${key}-${i}`, id: block.id, name: block.name, input: block.input ?? {}, children: [] };
                        tools.set(block.id, tool);
                        list.push(tool);
                    }
                });
                break;
            }
            case 'system': {
                if (message.subtype === 'init' && !initShown) {
                    initShown = true;
                    items.push({
                        kind: 'init',
                        key,
                        model: message.model,
                        version: message.claude_code_version,
                        commands: message.slash_commands.length,
                        skills: message.skills.length,
                        mcp: message.mcp_servers.map((s) => `${s.name} (${s.status})`),
                    });
                } else if (message.subtype === 'compact_boundary') {
                    items.push({ kind: 'compact', key, preTokens: message.compact_metadata.pre_tokens, postTokens: message.compact_metadata.post_tokens });
                }
                break;
            }
            case 'result': {
                // Une commande locale (`/compact`…) produit un résultat sans tour de modèle : rien à dire.
                if (message.num_turns === 0 && message.subtype === 'success') break;
                items.push({
                    kind: 'result',
                    key,
                    subtype: message.subtype,
                    durationMs: message.duration_ms,
                    costUsd: message.total_cost_usd,
                    numTurns: message.num_turns,
                    errors: message.subtype === 'success' ? [] : message.errors,
                });
                break;
            }
            default:
                break;
        }
    });
    return items;
}

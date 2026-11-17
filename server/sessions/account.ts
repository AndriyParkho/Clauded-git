import { homedir } from 'node:os';
import { query, type Query, type SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { PromptQueue } from './options.js';
import type { AccountUsage, RateWindow } from '../../shared/protocol.js';

type Limits = NonNullable<SDKControlGetUsageResponse['rate_limits']>;
type RawWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

const LABELS: Record<string, string> = {
    five_hour: '5 h',
    seven_day: '7 j',
    seven_day_opus: '7 j Opus',
    seven_day_sonnet: '7 j Sonnet',
};

/** Délai max d'une lecture : le CLI doit démarrer puis appeler l'API claude.ai. */
const TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`pas de réponse après ${ms / 1000} s`)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

function toWindows(limits: Limits): RateWindow[] {
    const windows: RateWindow[] = [];
    const add = (label: string, raw: RawWindow): void => {
        if (raw) windows.push({ label, utilization: raw.utilization, resetsAt: raw.resets_at });
    };
    add(LABELS.five_hour!, limits.five_hour);
    add(LABELS.seven_day!, limits.seven_day);
    add(LABELS.seven_day_opus!, limits.seven_day_opus);
    add(LABELS.seven_day_sonnet!, limits.seven_day_sonnet);
    for (const scoped of limits.model_scoped ?? []) add(`7 j ${scoped.display_name}`, scoped);
    return windows;
}

/** Réponse de `/usage` remise dans la forme de l'app. */
export function toAccountUsage(response: SDKControlGetUsageResponse): AccountUsage {
    const limits = response.rate_limits;
    const extra = limits?.extra_usage;
    return {
        at: new Date().toISOString(),
        subscription: response.subscription_type,
        available: response.rate_limits_available && limits !== null,
        windows: limits ? toWindows(limits) : [],
        ...(extra?.is_enabled ? { extra: { used: extra.used_credits, limit: extra.monthly_limit, utilization: extra.utilization, currency: extra.currency ?? null } } : {}),
    };
}

/** Lit la conso via une session déjà ouverte. */
export function readUsage(q: Query): Promise<AccountUsage> {
    return withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), TIMEOUT_MS).then(toAccountUsage);
}

/**
 * Lit la conso sans onglet ouvert : démarre un CLI « sonde » sans réglages ni MCP, qui ne reçoit
 * aucun prompt (donc ne consomme rien), le temps d'un appel de contrôle.
 */
export async function probeUsage(): Promise<AccountUsage> {
    const queue = new PromptQueue();
    const q = query({
        prompt: queue,
        options: { cwd: homedir(), settingSources: [], mcpServers: {}, env: { ...process.env, CLAUDECODE: undefined } },
    });
    // Le flux doit être consommé pour que le CLI réponde aux requêtes de contrôle.
    const drain = (async () => {
        try {
            for await (const _ of q) {
                // rien à afficher
            }
        } catch {
            // fermeture
        }
    })();
    try {
        return await readUsage(q);
    } finally {
        queue.close();
        try {
            q.close();
        } catch {
            // déjà fermé
        }
        void drain;
    }
}

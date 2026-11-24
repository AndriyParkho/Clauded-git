import { MAX_PARALLEL } from './config.js';
import { listRuns } from './db.js';
import type { RunState } from '../shared/protocol.js';

/**
 * Places d'implémentation : au plus `MAX_PARALLEL` onglets d'implémentation où Claude travaille (ou
 * attend ta réponse) en même temps, pour toute l'app. Un onglet au repos ne prend pas de place.
 */
const BUSY: RunState[] = ['starting', 'running', 'waiting'];

/** Lancements en cours (worktree, install, session pas encore partie) : ils comptent déjà. */
let launching = 0;

export function busySlots(): number {
    return listRuns().filter((run) => run.type === 'implement' && BUSY.includes(run.state)).length + launching;
}

export function slotFree(): boolean {
    return busySlots() < MAX_PARALLEL;
}

export function slots(): { max: number; busy: number } {
    return { max: MAX_PARALLEL, busy: busySlots() };
}

/** Compte `work` (un lancement) comme une place occupée jusqu'à ce que sa session tourne. */
export async function occupying<T>(work: () => Promise<T>): Promise<T> {
    launching++;
    try {
        return await work();
    } finally {
        launching--;
    }
}

export function queuedDetail(): string {
    return `en file : ${MAX_PARALLEL} implémentation${MAX_PARALLEL > 1 ? 's' : ''} en cours, elle part dès qu'une place se libère`;
}

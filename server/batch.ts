import { EventEmitter } from 'node:events';
import { deleteBatchItem, getBatchItem, getRepo, listBatchItems, saveBatchItem } from './db.js';
import { dependencyStatuses, launchOrder } from './dependencies.js';
import { getIssue } from './github.js';
import { implementIssue, reopenableImplementRun } from './implement.js';
import { Progress, SubProgress } from './progress.js';
import { sessions } from './sessions/manager.js';
import type { BatchItem, BatchResult, DependencyStatus, IssueDependency, Repo, Run } from '../shared/protocol.js';

/** Diffuse la liste des issues en attente à chaque changement. */
export const batchEvents = new EventEmitter<{ batch: [items: BatchItem[]] }>();

function changed(): void {
    batchEvents.emit('batch', listBatchItems());
}

// Les lancements d'un même dépôt passent un par un : `git worktree add` et `git fetch` en parallèle
// sur un même dépôt se disputent les verrous. Les sessions, elles, tournent ensuite en parallèle.
const launchChains = new Map<number, Promise<unknown>>();

function serialized<T>(repoId: number, work: () => Promise<T>): Promise<T> {
    const previous = launchChains.get(repoId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    launchChains.set(repoId, next.catch(() => undefined));
    return next;
}

/** Ce qu'attend une issue, en clair : `pending` sont les dépendances elles-mêmes en attente (ou en échec). */
function waitingDetail(missing: number[], pending: Set<number>): string {
    return `attend ${missing.map((n) => (pending.has(n) ? `#${n} (pas encore lancée)` : `#${n} (pas encore de PR)`)).join(', ')}`;
}

/** Précision affichée au lancement d'une issue dépendante. */
function stackDetail(statuses: DependencyStatus[]): string | undefined {
    const stacked = statuses.find((s) => s.openPr);
    return stacked?.openPr ? `empilée sur la PR #${stacked.openPr.number} (${stacked.openPr.branch})` : undefined;
}

async function launch(repo: Repo, number: number, planMode: boolean, dependencies: DependencyStatus[], progress: Progress): Promise<Run> {
    return serialized(repo.id, () => implementIssue(repo, number, { planMode, dependencies }, progress));
}

export interface BatchRequest {
    issues: number[];
    dependencies: Array<Pick<IssueDependency, 'issue' | 'dependsOn'>>;
    planMode: boolean;
    opId?: string | undefined;
}

/**
 * Lance l'implémentation de plusieurs issues, chacune dans son worktree et son onglet. Celles dont
 * les dépendances sont prêtes (fermées, ou avec une PR ouverte sur laquelle empiler) partent tout de
 * suite ; les autres sont mises en attente et partiront quand la PR de leurs dépendances existera.
 */
export async function startBatch(repo: Repo, request: BatchRequest): Promise<BatchResult> {
    const numbers = [...new Set(request.issues)];
    if (numbers.length === 0) throw new Error('aucune issue sélectionnée');
    const order = launchOrder(numbers, request.dependencies);
    const progress = new Progress(request.opId);
    const label = (n: number): string => `Issue #${n}`;
    progress.plan(order.map(label));

    const result: BatchResult = { started: [], waiting: [], failed: [] };
    const waitingNumbers = new Set<number>();
    for (const number of order) {
        const dependsOn = [...new Set(request.dependencies.filter((d) => d.issue === number).map((d) => d.dependsOn))];
        try {
            // Une dépendance du lot encore en attente : inutile d'interroger GitHub.
            const blockedInBatch = dependsOn.filter((d) => waitingNumbers.has(d));
            const reopened = await reopenableImplementRun(repo, number);
            const statuses = reopened || dependsOn.length === 0 ? new Map<number, DependencyStatus>() : await dependencyStatuses(repo, dependsOn.filter((d) => !blockedInBatch.includes(d)));
            const missing = reopened ? [] : dependsOn.filter((d) => blockedInBatch.includes(d) || !statuses.get(d)?.ready);
            if (missing.length > 0) {
                const title = (await getIssue(repo, number)).title;
                const item: Omit<BatchItem, 'createdAt'> = { repoId: repo.id, issueNumber: number, title, dependsOn, planMode: request.planMode, state: 'waiting', detail: waitingDetail(missing, waitingNumbers) };
                progress.step(label(number), `en attente : ${item.detail.replace(/^attend /, '')}`);
                saveBatchItem(item);
                waitingNumbers.add(number);
                result.waiting.push(getBatchItem(repo.id, number) ?? { ...item, createdAt: new Date().toISOString() });
                continue;
            }
            const deps = dependsOn.map((d) => statuses.get(d)).filter((s): s is DependencyStatus => s !== undefined);
            progress.step(label(number), reopened ? 'onglet existant rouvert' : (stackDetail(deps) ?? 'lancement'));
            const run = await launch(repo, number, request.planMode, deps, new SubProgress(progress));
            progress.detail(reopened ? 'onglet existant rouvert' : [stackDetail(deps), 'session lancée'].filter(Boolean).join(' · '));
            deleteBatchItem(repo.id, number);
            result.started.push(run);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            progress.detail(`échec : ${message}`);
            result.failed.push({ issueNumber: number, error: message });
            // Gardée en échec (relançable depuis l'issue) ; ses dépendantes du lot attendront.
            saveBatchItem({ repoId: repo.id, issueNumber: number, title: `#${number}`, dependsOn, planMode: request.planMode, state: 'failed', detail: message });
            waitingNumbers.add(number);
        }
    }
    progress.done();
    changed();
    return result;
}

// ---------------------------------------------------------------------------------------------
// Surveillance des issues en attente
// ---------------------------------------------------------------------------------------------

const CHECK_DELAY_MS = 5_000;
const POLL_MS = 5 * 60_000;
const timers = new Map<number, NodeJS.Timeout>();
const checking = new Map<number, Promise<void>>();

/** Relit, un peu plus tard, si les issues en attente d'un dépôt peuvent partir. */
export function scheduleCheck(repoId: number, delay = CHECK_DELAY_MS): void {
    clearTimeout(timers.get(repoId));
    timers.set(
        repoId,
        setTimeout(() => {
            timers.delete(repoId);
            void checkWaiting(repoId);
        }, delay).unref(),
    );
}

/** Lance les issues en attente d'un dépôt dont toutes les dépendances sont prêtes. */
export function checkWaiting(repoId: number): Promise<void> {
    const running = checking.get(repoId);
    if (running) return running;
    const work = (async () => {
        const repo = getRepo(repoId);
        const items = listBatchItems(repoId).filter((i) => i.state === 'waiting');
        if (!repo || items.length === 0) return;
        const statuses = await dependencyStatuses(repo, items.flatMap((i) => i.dependsOn)).catch(() => null);
        if (!statuses) return;
        const waiting = new Set(listBatchItems(repoId).map((i) => i.issueNumber));
        for (const item of items) {
            // Une dépendance elle-même en attente n'a pas de PR : rien à faire.
            const missing = item.dependsOn.filter((d) => waiting.has(d) || !statuses.get(d)?.ready);
            if (missing.length > 0) {
                const detail = waitingDetail(missing, waiting);
                if (detail !== item.detail) {
                    saveBatchItem({ ...item, detail });
                    changed();
                }
                continue;
            }
            await startItem(repo, item, item.dependsOn.map((d) => statuses.get(d)).filter((s): s is DependencyStatus => s !== undefined));
            waiting.delete(item.issueNumber);
        }
    })().finally(() => checking.delete(repoId));
    checking.set(repoId, work);
    return work;
}

async function startItem(repo: Repo, item: BatchItem, dependencies: DependencyStatus[]): Promise<Run | undefined> {
    try {
        const run = await launch(repo, item.issueNumber, item.planMode, dependencies, new Progress(undefined));
        deleteBatchItem(repo.id, item.issueNumber);
        changed();
        return run;
    } catch (error) {
        saveBatchItem({ ...item, state: 'failed', detail: error instanceof Error ? error.message : String(error) });
        changed();
        return undefined;
    }
}

/** Lance une issue en attente sans attendre : elle s'empile sur les dépendances qui ont déjà une PR. */
export async function forceStart(repo: Repo, issueNumber: number): Promise<Run> {
    const item = getBatchItem(repo.id, issueNumber);
    if (!item) throw new Error(`#${issueNumber} n'est pas en attente`);
    const statuses = await dependencyStatuses(repo, item.dependsOn);
    const run = await launch(repo, issueNumber, item.planMode, item.dependsOn.map((d) => statuses.get(d)).filter((s): s is DependencyStatus => s !== undefined), new Progress(undefined));
    deleteBatchItem(repo.id, issueNumber);
    changed();
    return run;
}

export function cancelItem(repoId: number, issueNumber: number): void {
    deleteBatchItem(repoId, issueNumber);
    changed();
}

/**
 * Surveille les issues en attente : dès qu'un onglet d'implémentation dont elles dépendent termine
 * un tour (sa PR vient sans doute d'être ouverte), puis toutes les 5 min (PR ouverte ailleurs).
 */
export function watchBatches(): void {
    sessions.on('run', (run) => {
        if (run.type !== 'implement' || run.state !== 'idle' || run.repoId === null || run.issueNumber === null) return;
        const issue = run.issueNumber;
        if (listBatchItems(run.repoId).some((i) => i.state === 'waiting' && i.dependsOn.includes(issue))) scheduleCheck(run.repoId);
    });
    const all = (): void => {
        for (const repoId of new Set(listBatchItems().map((i) => i.repoId))) scheduleCheck(repoId, 0);
    };
    setInterval(all, POLL_MS).unref();
    all();
}

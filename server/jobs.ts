import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { JobInfo } from '../shared/protocol.js';

export interface JobStep {
    /** Commande shell (`yarn test`) ou programme avec arguments. */
    command: string | { file: string; args: string[] };
    cwd: string;
    /** Message affiché en tête de l'étape. Par défaut, la commande. */
    label?: string;
}

const OUTPUT_LIMIT = 2 * 1024 * 1024;
const FLUSH_MS = 150;
const KEEP_PER_RUN = 20;

/**
 * Commandes lancées par l'app elle-même (install, tests, merges), hors de la session Claude.
 * La sortie est diffusée au fil de l'eau, au plus toutes les 150 ms.
 */
export class JobRunner extends EventEmitter<{ job: [JobInfo] }> {
    private readonly jobs = new Map<string, JobInfo>();
    private readonly timers = new Map<string, NodeJS.Timeout>();
    /** Processus en cours par job, pour pouvoir l'arrêter. */
    private readonly children = new Map<string, ChildProcess>();
    private readonly stopped = new Set<string>();

    listForRun(runId: number): JobInfo[] {
        return [...this.jobs.values()].filter((job) => job.runId === runId);
    }

    get(id: string): JobInfo | undefined {
        return this.jobs.get(id);
    }

    /** Démarre les étapes en séquence ; la première qui échoue arrête le job. */
    start(runId: number, name: string, steps: JobStep[], options: { onDone?: (job: JobInfo) => void; dir?: string } = {}): JobInfo {
        const job: JobInfo = { id: randomUUID(), runId, name, status: 'running', code: null, startedAt: new Date().toISOString(), endedAt: null, output: '', ...(options.dir ? { dir: options.dir } : {}) };
        this.jobs.set(job.id, job);
        this.prune(runId);
        this.emit('job', { ...job });
        void this.runSteps(job, steps).then(() => options.onDone?.(job));
        return job;
    }

    /**
     * Un job dont le travail est du code de l'app (pas une commande) : il écrit sa sortie avec `log`
     * et finit en échec s'il lève une erreur ou renvoie `false`.
     */
    task(runId: number, name: string, work: (log: (text: string) => void) => Promise<boolean | void>): JobInfo {
        const job: JobInfo = { id: randomUUID(), runId, name, status: 'running', code: null, startedAt: new Date().toISOString(), endedAt: null, output: '' };
        this.jobs.set(job.id, job);
        this.prune(runId);
        this.emit('job', { ...job });
        void work((text) => this.append(job, text.endsWith('\n') ? text : `${text}\n`)).then(
            (ok) => this.finish(job, ok === false ? 'failed' : 'ok', ok === false ? 1 : 0),
            (error: unknown) => {
                this.append(job, `\n${error instanceof Error ? error.message : String(error)}\n`);
                this.finish(job, 'failed', 1);
            },
        );
        return job;
    }

    private async runSteps(job: JobInfo, steps: JobStep[]): Promise<void> {
        for (const step of steps) {
            const label = step.label ?? (typeof step.command === 'string' ? step.command : `${step.command.file} ${step.command.args.join(' ')}`);
            this.append(job, `${job.output ? '\n' : ''}$ ${label}\n`);
            const code = this.stopped.has(job.id) ? 130 : await this.runStep(job, step);
            if (code !== 0) {
                if (this.stopped.has(job.id)) this.append(job, '\n(arrêté)\n');
                this.stopped.delete(job.id);
                this.finish(job, 'failed', code);
                return;
            }
        }
        this.finish(job, 'ok', 0);
    }

    private runStep(job: JobInfo, step: JobStep): Promise<number> {
        return new Promise((resolve) => {
            const child =
                typeof step.command === 'string'
                    ? spawn('/bin/zsh', ['-lc', step.command], { cwd: step.cwd, env: { ...process.env, FORCE_COLOR: '0', CI: '1' }, detached: true })
                    : spawn(step.command.file, step.command.args, { cwd: step.cwd, env: { ...process.env, FORCE_COLOR: '0' }, detached: true });
            // Groupe de processus à part : « Arrêter » tue aussi ce que la commande a lancé (yarn → node…).
            this.children.set(job.id, child);
            child.stdout.on('data', (chunk: Buffer) => this.append(job, chunk.toString()));
            child.stderr.on('data', (chunk: Buffer) => this.append(job, chunk.toString()));
            child.on('error', (error) => {
                this.append(job, `\n${String(error)}\n`);
                resolve(1);
            });
            child.on('close', (code) => {
                this.children.delete(job.id);
                resolve(code ?? 1);
            });
        });
    }

    private append(job: JobInfo, text: string): void {
        job.output += text;
        if (job.output.length > OUTPUT_LIMIT) job.output = `… (début tronqué)\n${job.output.slice(job.output.length - OUTPUT_LIMIT)}`;
        if (this.timers.has(job.id)) return;
        this.timers.set(
            job.id,
            setTimeout(() => {
                this.timers.delete(job.id);
                this.emit('job', { ...job });
            }, FLUSH_MS),
        );
    }

    private finish(job: JobInfo, status: 'ok' | 'failed', code: number): void {
        const timer = this.timers.get(job.id);
        if (timer) clearTimeout(timer);
        this.timers.delete(job.id);
        job.status = status;
        job.code = code;
        job.endedAt = new Date().toISOString();
        this.emit('job', { ...job });
    }

    /** Arrête un job en cours : son processus et tout ce qu'il a lancé. */
    stop(id: string): boolean {
        const job = this.jobs.get(id);
        if (!job || job.status !== 'running') return false;
        this.stopped.add(id);
        const child = this.children.get(id);
        if (child?.pid) {
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch {
                child.kill('SIGTERM');
            }
            const pid = child.pid;
            setTimeout(() => {
                if (this.children.get(id)?.pid === pid) {
                    try {
                        process.kill(-pid, 'SIGKILL');
                    } catch {
                        // déjà terminé
                    }
                }
            }, 3000).unref();
        }
        return true;
    }

    /** À l'arrêt du serveur : rien ne doit survivre (les groupes détachés ne meurent pas seuls). */
    stopAll(): void {
        for (const id of this.children.keys()) this.stop(id);
    }

    /** Ne garde que les derniers jobs d'un onglet. */
    private prune(runId: number): void {
        const mine = this.listForRun(runId);
        for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_PER_RUN))) {
            if (old.status !== 'running') this.jobs.delete(old.id);
        }
    }
}

export const jobs = new JobRunner();

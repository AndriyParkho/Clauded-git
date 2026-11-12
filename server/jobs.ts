import { spawn } from 'node:child_process';
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

    listForRun(runId: number): JobInfo[] {
        return [...this.jobs.values()].filter((job) => job.runId === runId);
    }

    get(id: string): JobInfo | undefined {
        return this.jobs.get(id);
    }

    /** Démarre les étapes en séquence ; la première qui échoue arrête le job. */
    start(runId: number, name: string, steps: JobStep[], options: { onDone?: (job: JobInfo) => void } = {}): JobInfo {
        const job: JobInfo = { id: randomUUID(), runId, name, status: 'running', code: null, startedAt: new Date().toISOString(), endedAt: null, output: '' };
        this.jobs.set(job.id, job);
        this.prune(runId);
        this.emit('job', { ...job });
        void this.runSteps(job, steps).then(() => options.onDone?.(job));
        return job;
    }

    private async runSteps(job: JobInfo, steps: JobStep[]): Promise<void> {
        for (const step of steps) {
            const label = step.label ?? (typeof step.command === 'string' ? step.command : `${step.command.file} ${step.command.args.join(' ')}`);
            this.append(job, `${job.output ? '\n' : ''}$ ${label}\n`);
            const code = await this.runStep(job, step);
            if (code !== 0) {
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
                    ? spawn('/bin/zsh', ['-lc', step.command], { cwd: step.cwd, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } })
                    : spawn(step.command.file, step.command.args, { cwd: step.cwd, env: { ...process.env, FORCE_COLOR: '0' } });
            child.stdout.on('data', (chunk: Buffer) => this.append(job, chunk.toString()));
            child.stderr.on('data', (chunk: Buffer) => this.append(job, chunk.toString()));
            child.on('error', (error) => {
                this.append(job, `\n${String(error)}\n`);
                resolve(1);
            });
            child.on('close', (code) => resolve(code ?? 1));
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

    /** Ne garde que les derniers jobs d'un onglet. */
    private prune(runId: number): void {
        const mine = this.listForRun(runId);
        for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_PER_RUN))) {
            if (old.status !== 'running') this.jobs.delete(old.id);
        }
    }
}

export const jobs = new JobRunner();

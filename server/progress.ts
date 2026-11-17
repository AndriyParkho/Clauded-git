import { EventEmitter } from 'node:events';
import type { ProgressStep } from '../shared/protocol.js';

/** Diffuse l'avancement d'une opération longue lancée par le client (`opId`), étape par étape. */
export const progressEvents = new EventEmitter<{ progress: [opId: string, steps: ProgressStep[]] }>();

/**
 * Étapes d'une opération (ouverture d'une PR, implémentation d'une issue) : celles prévues sont
 * annoncées en attente, puis passent en cours et terminées. Sans `opId`, rien n'est diffusé.
 */
export class Progress {
    private steps: ProgressStep[] = [];

    constructor(private readonly opId: string | undefined) {}

    /** Annonce les étapes à venir (en attente), à la suite de celles déjà connues. */
    plan(labels: string[]): this {
        for (const label of labels) if (!this.steps.some((s) => s.label === label)) this.steps.push({ label, state: 'pending' });
        this.emit();
        return this;
    }

    /** Termine l'étape en cours et démarre `label` (ajoutée si elle n'était pas prévue). */
    step(label: string, detail?: string): void {
        this.finishRunning();
        const startedAt = new Date().toISOString();
        const existing = this.steps.find((s) => s.label === label);
        const next: ProgressStep = { label, state: 'running', startedAt, ...(detail ? { detail } : {}) };
        if (existing) Object.assign(existing, next);
        else {
            // Étape imprévue : avant celles encore en attente, pour garder l'ordre réel.
            const firstPending = this.steps.findIndex((s) => s.state === 'pending');
            this.steps.splice(firstPending === -1 ? this.steps.length : firstPending, 0, next);
        }
        this.emit();
    }

    /** Retire des étapes prévues qui n'auront pas lieu (worktree déjà là, par exemple). */
    skip(...labels: string[]): void {
        this.steps = this.steps.filter((s) => !(labels.includes(s.label) && s.state === 'pending'));
        this.emit();
    }

    /** Remplace la précision affichée sous l'étape en cours. */
    detail(text: string): void {
        const running = this.steps.find((s) => s.state === 'running');
        if (!running) return;
        running.detail = text;
        this.emit();
    }

    done(): void {
        this.finishRunning();
        this.steps = this.steps.filter((s) => s.state !== 'pending');
        this.emit();
    }

    fail(error: unknown): void {
        const running = this.steps.find((s) => s.state === 'running');
        if (running) Object.assign(running, { state: 'failed', detail: String(error) });
        this.emit();
    }

    /** Lance `work` en marquant l'opération terminée, ou l'étape en cours en échec. */
    async run<T>(work: () => Promise<T>): Promise<T> {
        try {
            const result = await work();
            this.done();
            return result;
        } catch (error) {
            this.fail(error);
            throw error;
        }
    }

    private finishRunning(): void {
        for (const step of this.steps) if (step.state === 'running') step.state = 'done';
    }

    private emit(): void {
        if (this.opId) progressEvents.emit('progress', this.opId, this.steps.map((s) => ({ ...s })));
    }
}

/**
 * Étapes d'une sous-opération (l'implémentation d'une issue dans un lot) rapportées comme précision
 * de l'étape en cours de `parent`, qui garde sa propre liste.
 */
export class SubProgress extends Progress {
    constructor(private readonly parent: Progress) {
        super(undefined);
    }

    override plan(): this {
        return this;
    }

    override step(label: string, detail?: string): void {
        this.parent.detail(detail ? `${label} — ${detail}` : label);
    }

    override skip(): void {}

    override done(): void {}

    override fail(): void {}
}

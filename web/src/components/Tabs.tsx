import type { ReactElement } from 'react';
import { useUi } from '../ui';
import { useBackgroundTasks } from './chat/TasksStrip';
import type { IconName } from './Icon';
import type { Repo, Run, RunIntent, RunState, RunType } from '../../../shared/protocol';

export const STATE_LABEL: Record<RunState, string> = {
    closed: 'fermé',
    starting: 'démarrage',
    idle: 'prêt',
    running: 'en cours',
    waiting: 'attend ta réponse',
    error: 'erreur',
};

export const RUN_ICON: Record<RunType, IconName> = {
    chat: 'chat',
    implement: 'code',
    pr: 'pr',
    merge: 'merge',
    spec: 'spec',
};

/** Libellé de l'intention d'un chat. */
export const INTENT_LABEL: Record<RunIntent, string> = { investigation: 'investigation', question: 'question' };

/** Icône d'un onglet : celle de son intention (investigation, question), sinon celle de son type. */
export function runIcon(run: Run): IconName {
    if (run.intent === 'investigation') return 'investigate';
    if (run.intent === 'question') return 'question';
    return RUN_ICON[run.type];
}

/** Classe de couleur d'un onglet selon son intention et son environnement (`intent-investigation env-prod`). */
export function intentClass(run: Run): string {
    if (!run.intent) return '';
    return `intent-${run.intent}${run.env ? ` env-${run.env}` : ''}`;
}

/** Pastille de l'intention dans l'en-tête d'un onglet : « Investigation · prod », « Question ». */
export function IntentBadge({ run }: { run: Run }): ReactElement | null {
    if (!run.intent) return null;
    const label = run.intent === 'investigation' ? `Investigation${run.env ? ` · ${run.env}` : ''}` : 'Question';
    const title = run.intent === 'investigation' ? `Lecture seule, serveurs MCP de ${run.env ?? 'prod'} seulement ; se termine par un rapport` : 'Lecture seule, effort bas';
    return (
        <span className={`intent-badge ${intentClass(run)}`} title={title}>
            {label}
        </span>
    );
}

export function stateDot(state: RunState): ReactElement {
    return <span className={`dot dot-${state}`} title={STATE_LABEL[state]} />;
}

/** Point d'état d'un onglet ; un onglet au repos dont des tâches tournent encore en arrière-plan le montre. */
export function TabDot({ run }: { run: Run }): ReactElement {
    const tasks = useBackgroundTasks(run).length;
    if (tasks > 0 && run.state === 'idle') return <span className="dot dot-background" title={`${tasks} tâche${tasks > 1 ? 's' : ''} en arrière-plan`} />;
    return stateDot(run.state);
}

/** Nom affiché d'un dépôt : `owner/nom` si connu, sinon le dossier. */
export function repoLabel(repo: Repo, withOwner = true): string {
    const name = repo.name ?? repo.path.split('/').at(-1) ?? repo.path;
    return withOwner && repo.owner ? `${repo.owner}/${name}` : name;
}

/** Libellé court du dépôt d'un onglet. */
export function repoName(run: Run, repos: Repo[]): string {
    const repo = repos.find((r) => r.id === run.repoId);
    return repo ? repoLabel(repo, false) : 'Hors dépôt';
}

/** Seconde ligne d'un onglet : ce sur quoi il travaille. */
export function runMeta(run: Run): string {
    if (run.intent) {
        const link = run.issueNumber !== null ? ` · #${run.issueNumber}` : run.prNumber !== null ? ` · PR #${run.prNumber}` : '';
        return `${INTENT_LABEL[run.intent]}${run.env ? ` ${run.env}` : ''}${link}`;
    }
    if (run.type === 'pr') return `PR #${run.prNumber ?? '?'}${run.branch ? ` · ${run.branch}` : ''}`;
    if (run.type === 'spec') return `spec${run.specPath ? ` · ${run.specPath.split('/').at(-1)}` : ''}`;
    if (run.issueNumber !== null) return `#${run.issueNumber}${run.branch ? ` · ${run.branch}` : ''}`;
    if (run.branch) return run.branch;
    return run.type === 'merge' ? 'merge' : 'chat';
}

export interface RunGroup {
    /** Clé stable de la section (`pinned` ou `repo:<nom>`). */
    key: string;
    /** Titre de la section : « Épinglés » ou le nom du dépôt. */
    repo: string;
    pinned: boolean;
    runs: Run[];
}

/**
 * Onglets dans l'ordre d'affichage du rail : les épinglés d'abord, puis groupés par dépôt, chaque
 * section triée selon l'ordre choisi à la souris (les nouveaux onglets à la fin). C'est aussi l'ordre
 * des raccourcis ⌥1…⌥9 et ⌥↑/⌥↓. Épingles et ordre sont lus dans `useUi` : les composants qui
 * doivent suivre leurs changements s'abonnent à `pinnedRuns` et `runOrder`.
 */
export function groupRuns(runs: Run[], repos: Repo[]): RunGroup[] {
    const { pinnedRuns, runOrder } = useUi.getState();
    const rank = new Map(runOrder.map((id, i) => [id, i]));
    // Tri stable : rang choisi, sinon ordre d'arrivée (Infinity - Infinity donne NaN, d'où le repli).
    const sorted = runs
        .map((run, i) => ({ run, i }))
        .sort((a, b) => (rank.get(a.run.id) ?? Infinity) - (rank.get(b.run.id) ?? Infinity) || a.i - b.i)
        .map((entry) => entry.run);
    const pinned = new Set(pinnedRuns);
    const groups = new Map<string, Run[]>();
    for (const run of sorted) {
        if (pinned.has(run.id)) continue;
        const name = repoName(run, repos);
        groups.set(name, [...(groups.get(name) ?? []), run]);
    }
    const top = sorted.filter((run) => pinned.has(run.id));
    return [
        ...(top.length > 0 ? [{ key: 'pinned', repo: 'Épinglés', pinned: true, runs: top }] : []),
        ...[...groups.entries()].map(([repo, list]) => ({ key: `repo:${repo}`, repo, pinned: false, runs: list })),
    ];
}

export function orderedRuns(runs: Run[], repos: Repo[]): Run[] {
    return groupRuns(runs, repos).flatMap((g) => g.runs);
}

/**
 * Déplace un onglet juste avant ou après un autre de la même section du rail, et garde l'ordre
 * complet obtenu.
 */
export function moveRun(runs: Run[], repos: Repo[], runId: number, targetId: number, after: boolean): void {
    if (runId === targetId) return;
    const ids = orderedRuns(runs, repos)
        .map((r) => r.id)
        .filter((id) => id !== runId);
    const at = ids.indexOf(targetId);
    if (at === -1) return;
    ids.splice(after ? at + 1 : at, 0, runId);
    useUi.getState().setRunOrder(ids);
}

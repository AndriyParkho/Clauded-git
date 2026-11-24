import type { ReactElement } from 'react';
import { useBackgroundTasks } from './chat/TasksStrip';
import type { IconName } from './Icon';
import type { Repo, Run, RunState, RunType } from '../../../shared/protocol';

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
    if (run.type === 'pr') return `PR #${run.prNumber ?? '?'}${run.branch ? ` · ${run.branch}` : ''}`;
    if (run.type === 'spec') return `spec${run.specPath ? ` · ${run.specPath.split('/').at(-1)}` : ''}`;
    if (run.issueNumber !== null) return `#${run.issueNumber}${run.branch ? ` · ${run.branch}` : ''}`;
    if (run.branch) return run.branch;
    return run.type === 'merge' ? 'merge' : 'chat';
}

/**
 * Onglets groupés par dépôt, dans l'ordre d'affichage du rail : c'est aussi l'ordre des raccourcis
 * ⌥1…⌥9 et ⌥↑/⌥↓.
 */
export function groupRuns(runs: Run[], repos: Repo[]): Array<{ repo: string; runs: Run[] }> {
    const groups = new Map<string, Run[]>();
    for (const run of runs) {
        const name = repoName(run, repos);
        groups.set(name, [...(groups.get(name) ?? []), run]);
    }
    return [...groups.entries()].map(([repo, list]) => ({ repo, runs: list }));
}

export function orderedRuns(runs: Run[], repos: Repo[]): Run[] {
    return groupRuns(runs, repos).flatMap((g) => g.runs);
}

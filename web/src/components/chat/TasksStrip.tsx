import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useStore, type BackgroundTask } from '../../store';
import type { Run } from '../../../../shared/protocol';

const NO_TASKS: Record<string, BackgroundTask> = {};

/** Tâches en arrière-plan d'un onglet (vides si sa session est fermée : ses tâches sont mortes avec elle). */
export function useBackgroundTasks(run: Run): BackgroundTask[] {
    const tasks = useStore((s) => s.views[run.id]?.tasks ?? NO_TASKS);
    if (run.state === 'closed' || run.state === 'error') return [];
    return Object.values(tasks).filter((t) => t.background);
}

const KINDS: Record<string, string> = { local_agent: 'sous-agent', local_bash: 'commande', local_workflow: 'workflow', mcp_task: 'tâche MCP' };

function elapsed(since: number, now: number): string {
    const s = Math.max(0, Math.round((now - since) / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

/**
 * Ce que Claude a lancé en arrière-plan et qui tourne encore : le tour peut être fini, une réponse
 * arrivera quand ces tâches termineront.
 */
export function TasksStrip({ run }: { run: Run }): ReactElement | null {
    const tasks = useBackgroundTasks(run);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (tasks.length === 0) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [tasks.length]);
    if (tasks.length === 0) return null;
    return (
        <div className="tasks-strip">
            <div className="tasks-strip-head">
                <span className="spinner small" /> {tasks.length} tâche{tasks.length > 1 ? 's' : ''} en arrière-plan
                {run.state !== 'running' && <span className="muted"> · Claude reprend la main quand {tasks.length > 1 ? 'elles terminent' : 'elle termine'}</span>}
            </div>
            {tasks.map((task) => (
                <div key={task.id} className="tasks-strip-row">
                    <span className="muted">{task.agent ?? KINDS[task.type] ?? task.type}</span>
                    <span className="tasks-strip-desc">{task.summary ?? task.description}</span>
                    <span className="muted mono">
                        {task.toolUses > 0 && `${task.toolUses} outil${task.toolUses > 1 ? 's' : ''} · `}
                        {task.lastTool && `${task.lastTool} · `}
                        {elapsed(task.startedAt, now)}
                    </span>
                </div>
            ))}
        </div>
    );
}

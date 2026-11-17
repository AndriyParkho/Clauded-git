import type { ReactElement } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { Run, RunState } from '../../../shared/protocol';

const STATE_LABEL: Record<RunState, string> = {
    closed: 'fermé',
    starting: 'démarrage',
    idle: 'prêt',
    running: 'en cours',
    waiting: 'attend ta réponse',
    error: 'erreur',
};

export function stateDot(state: RunState): ReactElement {
    return <span className={`dot dot-${state}`} title={STATE_LABEL[state]} />;
}

export function Tabs(): ReactElement {
    const runs = useStore((s) => s.runs);
    const activeRunId = useStore((s) => s.activeRunId);
    const page = useStore((s) => s.page);
    const setActive = useStore((s) => s.setActive);
    const setPage = useStore((s) => s.setPage);
    const removeRun = useStore((s) => s.removeRun);

    const close = async (run: Run, event: React.MouseEvent): Promise<void> => {
        event.stopPropagation();
        await api.deleteRun(run.id);
        removeRun(run.id);
    };

    return (
        <div className="tabs">
            <button className={`tab ${page === 'issues' ? 'active' : ''}`} onClick={() => setPage('issues')}>
                Issues
            </button>
            <button className={`tab ${page === 'pulls' ? 'active' : ''}`} onClick={() => setPage('pulls')}>
                PR
            </button>
            <button className={`tab ${page === 'repos' ? 'active' : ''}`} onClick={() => setPage('repos')}>
                Dépôts
            </button>
            {runs.map((run) => (
                <button key={run.id} className={`tab ${page === 'chat' && run.id === activeRunId ? 'active' : ''}`} onClick={() => setActive(run.id)} title={`${run.cwd}\n${STATE_LABEL[run.state]}`}>
                    {stateDot(run.state)}
                    <span className="tab-title">{run.title}</span>
                    <span className="tab-close" onClick={(e) => void close(run, e)} title="Fermer l'onglet (la session reste reprenable)">
                        ×
                    </span>
                </button>
            ))}
        </div>
    );
}

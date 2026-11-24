import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { GithubLink, Run, RunLinks, WorkflowLink } from '../../../../shared/protocol';

const STATES: Record<GithubLink['state'], string> = { OPEN: 'ouverte', CLOSED: 'fermée', MERGED: 'mergée' };
const EMPTY: RunLinks = { links: [], workflows: [] };
/** Tant qu'un workflow tourne, son état est relu à cet intervalle. */
const POLL_MS = 30_000;

function workflowIcon(w: WorkflowLink): string {
    if (w.status !== 'completed') return '⏳';
    if (w.conclusion === 'success') return '✓';
    if (w.conclusion === 'skipped' || w.conclusion === 'neutral') return '–';
    return '✗';
}

function workflowState(w: WorkflowLink): string {
    if (w.status !== 'completed') return 'running';
    return w.conclusion === 'success' ? 'success' : w.conclusion === 'skipped' || w.conclusion === 'neutral' ? 'neutral' : 'failure';
}

/**
 * Liens GitHub de l'onglet : son issue et sa PR (ou sa PR et ses issues), et les workflows GitHub
 * Actions lancés par leur merge dans develop ou master. Relus à l'ouverture et à la fin de chaque
 * tour (la PR apparaît dès que Claude l'a ouverte), et toutes les 30 s tant qu'un workflow tourne.
 */
export function GithubLinks({ run }: { run: Run }): ReactElement | null {
    const [data, setData] = useState<RunLinks>(EMPTY);
    const [tick, setTick] = useState(0);
    const linked = run.repoId !== null && (run.issueNumber !== null || run.prNumber !== null || run.branch !== null);
    const turnOver = run.state !== 'running' && run.state !== 'starting';
    const pending = data.workflows.some((w) => w.status !== 'completed');

    useEffect(() => {
        if (!linked || !turnOver) return;
        let live = true;
        api.runLinks(run.id)
            .then((result) => live && setData(result))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [run.id, linked, turnOver, tick]);

    useEffect(() => {
        if (!pending) return;
        const timer = setTimeout(() => setTick((t) => t + 1), POLL_MS);
        return () => clearTimeout(timer);
    }, [pending, data]);

    if (data.links.length === 0 && data.workflows.length === 0) return null;
    return (
        <span className="github-links">
            {data.links.map((link) => (
                <a
                    key={`${link.kind}${link.number}`}
                    className={`github-link state-${link.state.toLowerCase()}`}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`${link.title}\n${link.kind === 'pr' ? 'PR' : 'Issue'} ${STATES[link.state]}${link.isDraft ? ' (draft)' : ''} · ouvrir sur GitHub`}
                >
                    {link.kind === 'pr' ? 'PR' : 'Issue'} #{link.number}
                    {link.isDraft && link.state === 'OPEN' ? ' draft' : link.state !== 'OPEN' ? ` ${STATES[link.state]}` : ''} ↗
                </a>
            ))}
            {data.workflows.map((w) => (
                <a
                    key={w.id}
                    className={`github-link workflow-${workflowState(w)}`}
                    href={w.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`Workflow « ${w.name} » lancé par le merge dans ${w.target}\n${w.status === 'completed' ? `terminé : ${w.conclusion ?? '?'}` : 'en cours'} · ouvrir sur GitHub`}
                >
                    {workflowIcon(w)} {w.target} · {w.name} ↗
                </a>
            ))}
        </span>
    );
}

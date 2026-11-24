import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Icon } from '../Icon';
import { Menu, MenuLabel } from '../Menu';
import type { GithubLink, Run, RunLinks, WorkflowLink } from '../../../../shared/protocol';

const STATES: Record<GithubLink['state'], string> = { OPEN: 'ouverte', CLOSED: 'fermée', MERGED: 'mergée' };
const EMPTY: RunLinks = { links: [], workflows: [] };
/** Tant qu'un workflow tourne, son état est relu à cet intervalle. */
const POLL_MS = 30_000;

function workflowIcon(w: WorkflowLink): string {
    if (w.status !== 'completed') return '◷';
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
    // Une pastille courte par issue / PR (l'état est porté par la couleur et l'infobulle) ; les
    // workflows sont résumés en une seule pastille, leur détail dans un menu.
    const counts = { success: 0, running: 0, failure: 0, neutral: 0 };
    for (const w of data.workflows) counts[workflowState(w) as keyof typeof counts]++;
    const overall = counts.failure ? 'failure' : counts.running ? 'running' : counts.success ? 'success' : 'neutral';
    return (
        <span className="github-links">
            {data.links.map((link) => (
                <a
                    key={`${link.kind}${link.number}`}
                    className={`github-link state-${link.isDraft && link.state === 'OPEN' ? 'draft' : link.state.toLowerCase()}`}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`${link.title}\n${link.kind === 'pr' ? 'PR' : 'Issue'} ${STATES[link.state]}${link.isDraft ? ' (draft)' : ''} · ouvrir sur GitHub`}
                >
                    <Icon name={link.kind === 'pr' ? 'pr' : 'issue'} size={12} />
                    {link.kind === 'pr' ? 'PR ' : ''}#{link.number}
                </a>
            ))}
            {data.workflows.length > 0 && (
                <Menu
                    className={`github-workflows workflow-${overall}`}
                    small
                    title="Workflows GitHub Actions lancés par les merges"
                    label={
                        <>
                            Déploiements
                            {counts.success > 0 && <span className="wf-count workflow-success">✓{counts.success}</span>}
                            {counts.running > 0 && <span className="wf-count workflow-running">◷{counts.running}</span>}
                            {counts.failure > 0 && <span className="wf-count workflow-failure">✗{counts.failure}</span>}
                        </>
                    }
                >
                    <MenuLabel>Lancés par les merges</MenuLabel>
                    {data.workflows.map((w) => (
                        <a
                            key={w.id}
                            role="menuitem"
                            className={`menu-link workflow-${workflowState(w)}`}
                            href={w.url}
                            target="_blank"
                            rel="noreferrer"
                            title={`${w.status === 'completed' ? `terminé : ${w.conclusion ?? '?'}` : 'en cours'} · ouvrir sur GitHub`}
                        >
                            <span className="wf-icon">{workflowIcon(w)}</span>
                            <span className="wf-name">{w.name}</span>
                            <span className="menu-hint mono">{w.target}</span>
                        </a>
                    ))}
                </Menu>
            )}
        </span>
    );
}

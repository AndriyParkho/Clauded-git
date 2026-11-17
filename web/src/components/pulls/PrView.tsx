import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { reviewKey, useStore, type Panel } from '../../store';
import { ChatView } from '../chat/ChatView';
import { IssueBody } from '../issues/IssueBody';
import { CommandTools, JobsPanel } from '../jobs/Commands';
import { MergeBaseButton, MergeIntegrationButton } from '../MergeIntegration';
import { BrunoButton } from '../BrunoButton';
import { OpenMenu } from '../OpenMenu';
import { PullInfo } from './PullInfo';
import { ReviewPanel } from './ReviewPanel';
import { ReviewSkillSelect } from './ReviewSkillSelect';
import type { JobInfo, PullDetail, Run, SlashCommandInfo } from '../../../../shared/protocol';

const NO_COMMANDS: SlashCommandInfo[] = [];
const NO_JOBS: JobInfo[] = [];

function InfoPanel({ pull, error, repoId, onRefresh, onOpenIssue }: { pull: PullDetail | null | undefined; error: string | undefined; repoId: number; onRefresh: () => void; onOpenIssue: (number: number) => void }): ReactElement {
    if (error) return <div className="error pad">{error}</div>;
    if (pull === undefined) return <div className="muted pad">chargement…</div>;
    if (pull === null) return <div className="muted pad">PR introuvable.</div>;
    return (
        <PullInfo
            pull={pull}
            repoId={repoId}
            onOpenIssue={onOpenIssue}
            actions={
                <button className="small" onClick={onRefresh}>
                    ↻ rafraîchir
                </button>
            }
        />
    );
}

/**
 * Onglet d'une PR : chat dans un worktree sur sa branche, review par le skill du profil, brouillons
 * sur le diff et publication.
 */
export function PrView({ run }: { run: Run }): ReactElement {
    const repo = useStore((s) => s.repos.find((r) => r.id === run.repoId));
    // Le panneau de review est ouvert par défaut : c'est la raison d'être de l'onglet.
    const panel = useStore((s) => (s.panels[run.id] === undefined ? 'review' : s.panels[run.id]));
    const setPanel = useStore((s) => s.setPanel);
    const notify = useStore((s) => s.notify);
    const commands = useStore((s) => s.views[run.id]?.commands ?? NO_COMMANDS);
    const jobs = useStore((s) => s.views[run.id]?.jobs ?? NO_JOBS);
    const drafts = useStore((s) => (repo && run.prNumber !== null ? (s.reviews[reviewKey(repo.id, run.prNumber)]?.drafts.length ?? 0) : 0));
    const [starting, setStarting] = useState(false);
    const [pull, setPull] = useState<PullDetail | null | undefined>();
    const [pullError, setPullError] = useState<string | undefined>();
    const [issueNumber, setIssueNumber] = useState<number | null>(null);

    const loadPull = useCallback(() => {
        setPullError(undefined);
        api.runPull(run.id)
            .then((r) => setPull(r.pull))
            .catch((e: unknown) => setPullError(String(e)));
    }, [run.id]);
    useEffect(loadPull, [loadPull]);

    const openIssue = (number: number): void => {
        setIssueNumber(number);
        setPanel(run.id, 'issue');
    };
    const linked = pull?.issues ?? [];
    // L'issue affichée : celle choisie, sinon la première liée.
    const shownIssue = issueNumber ?? linked[0]?.number ?? null;

    // Skills de review chargés par la session, en plus de ceux trouvés sur le disque.
    const sessionSkills = commands.map((c) => c.name).filter((name) => /review/i.test(name));

    const review = async (): Promise<void> => {
        setStarting(true);
        setPanel(run.id, 'review');
        try {
            await api.startReview(run.id);
        } catch (error) {
            notify(String(error), run.id);
        } finally {
            setStarting(false);
        }
    };

    const toggle = (next: Panel): void => setPanel(run.id, panel === next ? null : next);
    const busy = starting || run.state === 'running';

    const toolbar = (
        <>
            <OpenMenu path={run.cwd} runId={run.id} label="Ouvrir le worktree ▾" />
            {repo && <BrunoButton repoId={repo.id} path={run.worktree ?? run.cwd} />}
            <button className="primary" disabled={busy} onClick={() => void review()} title="Relit la PR et écrit les brouillons ; rien n'est publié">
                {starting ? 'Lancement…' : 'Lancer la review'}
            </button>
            {repo && <ReviewSkillSelect repoId={repo.id} extra={sessionSkills} />}
            <button className={panel === 'review' ? 'active' : ''} onClick={() => toggle('review')}>
                Brouillons{drafts ? ` (${drafts})` : ''}
            </button>
            <button className={panel === 'info' ? 'active' : ''} onClick={() => toggle('info')}>
                Description
            </button>
            {linked.map((issue) => (
                <button
                    key={issue.number}
                    className={panel === 'issue' && shownIssue === issue.number ? 'active' : ''}
                    onClick={() => (panel === 'issue' && shownIssue === issue.number ? setPanel(run.id, null) : openIssue(issue.number))}
                    title={issue.title}
                >
                    Issue #{issue.number}
                </button>
            ))}
            <CommandTools run={run} jobs={jobs} jobsOpen={panel === 'jobs'} onShowJobs={(open) => setPanel(run.id, open ? 'jobs' : null)} />
            {repo && pull && !pull.isCrossRepository && pull.state === 'OPEN' && (
                <>
                    <MergeBaseButton repoId={repo.id} base={pull.baseRefName} what={pull.headRefName} start={() => api.mergeBase(run.id)} />
                    <MergeIntegrationButton repoId={repo.id} what={pull.headRefName} start={() => api.mergeIntegration(run.id)} />
                </>
            )}
        </>
    );

    const subtitle = <span className="muted mono">{run.branch && `${run.branch} → ${run.baseBranch ?? '?'}`}</span>;

    const content =
        panel === 'review' && repo && run.prNumber !== null ? (
            <ReviewPanel repoId={repo.id} prNumber={run.prNumber} runId={run.id} />
        ) : panel === 'info' && repo ? (
            <InfoPanel pull={pull} error={pullError} repoId={repo.id} onRefresh={loadPull} onOpenIssue={openIssue} />
        ) : panel === 'issue' && repo && shownIssue !== null ? (
            <IssueBody repoId={repo.id} number={shownIssue} compact />
        ) : panel === 'jobs' ? (
            <JobsPanel run={run} jobs={jobs} />
        ) : null;
    const panelTitle = panel === 'review' ? `Review de la PR #${run.prNumber ?? '?'}` : panel === 'issue' ? `Issue #${shownIssue ?? '?'}` : panel === 'jobs' ? 'Logs des commandes' : 'Description';

    return (
        <ChatView
            run={run}
            toolbar={toolbar}
            subtitle={subtitle}
            wide={panel === 'review'}
            panel={
                panel && (
                    <>
                        <div className="panel-head">
                            <span>{panelTitle}</span>
                            <button className="small" onClick={() => setPanel(run.id, null)}>
                                ×
                            </button>
                        </div>
                        <div className="panel-body">{content}</div>
                    </>
                )
            }
        />
    );
}

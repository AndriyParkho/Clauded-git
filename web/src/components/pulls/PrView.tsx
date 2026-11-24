import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { reviewKey, useStore, type Panel } from '../../store';
import { ChatView } from '../chat/ChatView';
import { IssueBody } from '../issues/IssueBody';
import { CommandsMenu, JobsPanel, LogsLabel } from '../jobs/Commands';
import { GitMenu } from '../MergeIntegration';
import { BrunoButton } from '../BrunoButton';
import { Icon } from '../Icon';
import { OpenMenu } from '../OpenMenu';
import { ViewSwitch } from '../ViewSwitch';
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

    // Les issues liées partagent la valeur « issue » : on distingue l'active par son numéro.
    const views = (
        <ViewSwitch<Panel>
            value={panel ?? null}
            onChange={(next) => toggle(next)}
            options={[
                { value: 'review', label: `Brouillons${drafts ? ` ${drafts}` : ''}`, title: 'Brouillons de review sur le diff' },
                { value: 'info', label: 'Description', title: 'Description, checks et commentaires de la PR' },
                ...linked.map((issue) => ({
                    value: 'issue' as const,
                    key: `issue-${issue.number}`,
                    label: `#${issue.number}`,
                    title: `Issue liée : ${issue.title}`,
                    active: panel === 'issue' && shownIssue === issue.number,
                    // Affiche cette issue ; ne ferme le panneau que si c'est déjà elle.
                    onSelect: () => (panel === 'issue' && shownIssue === issue.number ? setPanel(run.id, null) : openIssue(issue.number)),
                })),
                { value: 'jobs', label: <LogsLabel jobs={jobs} />, title: 'Logs des commandes lancées dans cet onglet' },
            ]}
        />
    );

    const actions = (
        <>
            <CommandsMenu run={run} jobs={jobs} onShowJobs={(open) => setPanel(run.id, open ? 'jobs' : null)} />
            {repo && pull && !pull.isCrossRepository && pull.state === 'OPEN' && (
                <GitMenu repoId={repo.id} base={pull.baseRefName} what={pull.headRefName} mergeBase={() => api.mergeBase(run.id)} mergeIntegration={() => api.mergeIntegration(run.id)} runId={run.id} />
            )}
            <OpenMenu path={run.cwd} runId={run.id}>
                {repo && <BrunoButton repoId={repo.id} path={run.worktree ?? run.cwd} />}
            </OpenMenu>
            <span className="split-action">
                <button className="primary" disabled={busy} onClick={() => void review()} title="Relit la PR et écrit les brouillons ; rien n'est publié">
                    {starting ? 'Lancement…' : 'Lancer la review'}
                </button>
                {repo && <ReviewSkillSelect repoId={repo.id} extra={sessionSkills} />}
            </span>
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
            views={views}
            actions={actions}
            subtitle={subtitle}
            wide={panel === 'review'}
            panel={
                panel && (
                    <>
                        <div className="panel-head">
                            <span>{panelTitle}</span>
                            <button className="icon-button" onClick={() => setPanel(run.id, null)} title="Fermer le panneau" aria-label="Fermer le panneau">
                                <Icon name="x" size={14} />
                            </button>
                        </div>
                        <div className="panel-body">{content}</div>
                    </>
                )
            }
        />
    );
}

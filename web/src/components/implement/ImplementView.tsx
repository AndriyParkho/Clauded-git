import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api, type Profile } from '../../api';
import { useStore, type Panel } from '../../store';
import { ChatView } from '../chat/ChatView';
import { IssueBody } from '../issues/IssueBody';
import { DiffBrowser, DiffSummary } from '../DiffView';
import { CommandTools, JobsPanel } from '../jobs/Commands';
import { MergeBaseButton, MergeIntegrationButton } from '../MergeIntegration';
import { parseDiff } from '../../../../shared/diff';
import { BrunoButton } from '../BrunoButton';
import { OpenMenu } from '../OpenMenu';
import { PullInfo } from '../pulls/PullInfo';
import type { JobInfo, PullDetail, Run, WorktreeInfo } from '../../../../shared/protocol';

function DiffPanel({ run }: { run: Run }): ReactElement {
    const [diff, setDiff] = useState<{ stat: string; patch: string } | undefined>();
    const [error, setError] = useState<string | undefined>();
    const load = useCallback(() => {
        setError(undefined);
        api.diff(run.id)
            .then(setDiff)
            .catch((e: unknown) => setError(String(e)));
    }, [run.id]);
    useEffect(load, [load, run.state]);
    if (error) return <div className="error pad">{error}</div>;
    if (!diff) return <div className="muted pad">chargement du diff…</div>;
    if (!diff.patch.trim()) return <div className="muted pad">Aucune différence avec origin/{run.baseBranch ?? 'base'}.</div>;
    const files = parseDiff(diff.patch);
    return (
        <div className="review">
            <div className="review-head diff-head">
                <span className="muted">
                    Changements par rapport à <span className="mono">origin/{run.baseBranch ?? 'base'}</span>
                </span>
                <span className="spacer" />
                <DiffSummary files={files} />
                <button className="small" onClick={load} title="Recharger le diff">
                    ↻
                </button>
            </div>
            <DiffBrowser files={files} />
        </div>
    );
}

/** PR de la branche : checks, reviews et commentaires, avec l'envoi des commentaires non résolus au chat. */
function PullOfBranch({ run, number }: { run: Run; number: number }): ReactElement {
    const notify = useStore((s) => s.notify);
    const [pull, setPull] = useState<PullDetail | null | undefined>();
    const [sending, setSending] = useState(false);
    useEffect(() => {
        api.runPull(run.id)
            .then((r) => setPull(r.pull))
            .catch((e: unknown) => notify(String(e), run.id));
    }, [run.id, number, notify]);

    const sendComments = async (): Promise<void> => {
        setSending(true);
        try {
            const { sent } = await api.sendReviewComments(run.id);
            if (sent === 0) notify('Aucun commentaire de review non résolu.', run.id);
        } catch (error) {
            notify(String(error), run.id);
        } finally {
            setSending(false);
        }
    };

    if (pull === undefined) return <div className="muted">chargement de la PR…</div>;
    if (pull === null) return <div className="muted">PR introuvable.</div>;
    const open = pull.threads.filter((t) => !t.isResolved).length;
    return (
        <PullInfo
            pull={pull}
            repoId={run.repoId ?? 0}
            actions={
                <button className="small" disabled={sending || open === 0 || run.state === 'running'} onClick={() => void sendComments()} title="Envoie les commentaires de review non résolus à la session, qui les traite">
                    Envoyer les commentaires au chat ({open})
                </button>
            }
        />
    );
}

function PrPanel({ run, info, onRefresh }: { run: Run; info: WorktreeInfo | undefined; onRefresh: () => void }): ReactElement {
    return (
        <div className="pad pr-panel">
            <div className="form-row">
                <button className="small" onClick={onRefresh}>
                    ↻ rafraîchir
                </button>
            </div>
            {!info && <div className="muted">chargement…</div>}
            {info && (
                <>
                    <div className="mono">
                        {info.branch ?? '(détachée)'} · {info.dirty ? `${info.changedFiles} fichiers modifiés non commités` : 'propre'}
                        {info.hasUpstream ? ` · ↑${info.ahead} ↓${info.behind}` : ' · pas poussée'}
                    </div>
                    {info.conflicted.length > 0 && <div className="error">Conflits : {info.conflicted.join(', ')}</div>}
                    {info.pr ? (
                        <PullOfBranch run={run} number={info.pr.number} />
                    ) : (
                        <div className="muted">Pas encore de PR pour {run.branch}. Claude l'ouvre à la fin de l'implémentation ; sinon demande-lui dans le chat.</div>
                    )}
                </>
            )}
        </div>
    );
}

const PANEL_TITLES: Partial<Record<Panel, string>> = { issue: 'Issue', diff: 'Diff', jobs: 'Logs des commandes', pr: 'Branche et PR', review: 'Review', info: 'Description' };

// Référence stable : `?? []` dans un sélecteur zustand recrée un tableau à chaque lecture et boucle.
const NO_JOBS: JobInfo[] = [];

export function ImplementView({ run }: { run: Run }): ReactElement {
    const repo = useStore((s) => s.repos.find((r) => r.id === run.repoId));
    const panel = useStore((s) => s.panels[run.id] ?? null);
    const setPanel = useStore((s) => s.setPanel);
    const jobs = useStore((s) => s.views[run.id]?.jobs ?? NO_JOBS);
    const notify = useStore((s) => s.notify);
    const [profile, setProfile] = useState<Profile | undefined>();
    const [info, setInfo] = useState<WorktreeInfo | undefined>();

    useEffect(() => {
        if (!repo) return;
        api.profile(repo.id)
            .then((r) => setProfile(r.profile))
            .catch((e: unknown) => notify(String(e), run.id));
    }, [repo, run.id, notify]);

    const refreshInfo = useCallback(() => {
        api.worktree(run.id)
            .then(setInfo)
            .catch(() => undefined);
    }, [run.id]);

    // État de la branche à l'ouverture, puis après chaque tour de Claude et chaque commande.
    useEffect(() => {
        if (run.state === 'idle' || run.state === 'closed') refreshInfo();
    }, [run.state, refreshInfo]);
    useEffect(() => {
        if (jobs.every((j) => j.status !== 'running')) refreshInfo();
    }, [jobs, refreshInfo]);

    const toggle = (next: Panel): void => setPanel(run.id, panel === next ? null : next);
    const running = jobs.some((j) => j.status === 'running');
    const base = run.baseBranch ?? profile?.baseBranch ?? 'master';

    const toolbar = (
        <>
            <OpenMenu path={run.cwd} runId={run.id} />
            {repo && <BrunoButton repoId={repo.id} path={run.worktree ?? run.cwd} />}
            <button className={panel === 'issue' ? 'active' : ''} onClick={() => toggle('issue')}>
                Issue
            </button>
            <button className={panel === 'diff' ? 'active' : ''} onClick={() => toggle('diff')}>
                Diff
            </button>
            {repo && run.type !== 'merge' && (
                <>
                    <MergeBaseButton repoId={repo.id} base={base} what={run.branch ?? 'la branche'} start={() => api.mergeBase(run.id)} disabled={running} />
                    <MergeIntegrationButton repoId={repo.id} what={run.branch ?? 'la branche'} start={() => api.mergeIntegration(run.id)} disabled={running} />
                </>
            )}
            <CommandTools run={run} jobs={jobs} jobsOpen={panel === 'jobs'} onShowJobs={(open) => setPanel(run.id, open ? 'jobs' : null)} />
            <button className={panel === 'pr' ? 'active' : ''} onClick={() => toggle('pr')}>
                {info?.pr ? `PR #${info.pr.number}` : 'PR'}
            </button>
        </>
    );

    const subtitle = (
        <span className="muted mono">
            {run.branch && `${run.branch} ← ${base}`}
            {info && (info.dirty ? ` · ${info.changedFiles} modif.` : ' · propre')}
            {info?.hasUpstream && ` · ↑${info.ahead} ↓${info.behind}`}
            {run.installStatus && run.installStatus !== 'ok' && <span className={run.installStatus === 'failed' ? 'error' : 'warn'}> · install {run.installStatus === 'running' ? 'en cours' : run.installStatus === 'failed' ? 'en échec' : run.installStatus}</span>}
        </span>
    );

    const content =
        panel === 'issue' && repo && run.issueNumber !== null ? (
            <IssueBody repoId={repo.id} number={run.issueNumber} compact />
        ) : panel === 'diff' ? (
            <DiffPanel run={run} />
        ) : panel === 'jobs' ? (
            <JobsPanel run={run} jobs={jobs} />
        ) : panel === 'pr' ? (
            <PrPanel run={run} info={info} onRefresh={refreshInfo} />
        ) : null;

    return (
        <ChatView
            run={run}
            toolbar={toolbar}
            subtitle={subtitle}
            wide={panel === 'diff'}
            panel={
                panel && (
                    <>
                        <div className="panel-head">
                            <span>{PANEL_TITLES[panel]}</span>
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

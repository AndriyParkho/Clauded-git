import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api, type Profile } from '../../api';
import { useStore, type Panel } from '../../store';
import { send } from '../../ws';
import { ChatView } from '../chat/ChatView';
import { IssueBody } from '../issues/IssueBody';
import type { JobInfo, Run, WorktreeInfo } from '../../../../shared/protocol';

function duration(job: JobInfo): string {
    const end = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
    const seconds = Math.round((end - new Date(job.startedAt).getTime()) / 1000);
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')}`;
}

function OpenMenu({ run }: { run: Run }): ReactElement {
    const notify = useStore((s) => s.notify);
    const [open, setOpen] = useState(false);
    const openIn = async (app: 'vscode' | 'finder' | 'terminal' | 'iterm'): Promise<void> => {
        setOpen(false);
        try {
            await api.openIn(run.id, app);
        } catch (error) {
            notify(String(error), run.id);
        }
    };
    return (
        <span className="menu">
            <button onClick={() => setOpen(!open)} title={run.cwd}>
                Ouvrir ▾
            </button>
            {open && (
                <div className="menu-items" onMouseLeave={() => setOpen(false)}>
                    <button onClick={() => void openIn('vscode')}>VS Code</button>
                    <button onClick={() => void openIn('finder')}>Finder</button>
                    <button onClick={() => void openIn('terminal')}>Terminal</button>
                    <button onClick={() => void openIn('iterm')}>iTerm</button>
                </div>
            )}
        </span>
    );
}

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
    return (
        <div className="patch-wrap">
            <pre className="patch-stat">{diff.stat}</pre>
            <pre className="patch">
                {diff.patch.split('\n').map((line, i) => (
                    <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : line.startsWith('diff ') ? 'file' : ''}>
                        {line}
                        {'\n'}
                    </span>
                ))}
            </pre>
        </div>
    );
}

function JobsPanel({ run, jobs }: { run: Run; jobs: JobInfo[] }): ReactElement {
    const notify = useStore((s) => s.notify);
    const upsertRun = useStore((s) => s.upsertRun);
    const setActive = useStore((s) => s.setActive);
    const ordered = [...jobs].reverse();

    const sendToChat = (job: JobInfo): void => {
        const tail = job.output.slice(-8000);
        const text = job.status === 'failed' ? `La commande « ${job.name} » lancée par l'app a échoué (code ${job.code}). Analyse la sortie ci-dessous, corrige, et relance ce qu'il faut.` : `Sortie de la commande « ${job.name} » lancée par l'app :`;
        send({ type: 'prompt', runId: run.id, text: `${text}\n\n\`\`\`\n${tail}\n\`\`\`` });
    };

    const resolve = async (job: JobInfo): Promise<void> => {
        try {
            const merge = await api.resolveMerge(run.id, job.id);
            upsertRun(merge);
            setActive(merge.id);
        } catch (error) {
            notify(String(error), run.id);
        }
    };

    if (ordered.length === 0) return <div className="muted pad">Aucune commande lancée pour cet onglet.</div>;
    return (
        <div className="jobs">
            {ordered.map((job) => (
                <details key={job.id} className={`job job-${job.status}`} open={job === ordered[0]}>
                    <summary>
                        <span className={`dot dot-${job.status === 'running' ? 'running' : job.status === 'ok' ? 'idle' : 'error'}`} />
                        <span className="job-name">{job.name}</span>
                        <span className="muted">
                            {job.status === 'running' ? 'en cours' : job.status === 'ok' ? 'ok' : `échec (${job.code})`} · {duration(job)}
                        </span>
                    </summary>
                    <div className="job-actions">
                        <button className="small" onClick={() => sendToChat(job)}>
                            Envoyer au chat
                        </button>
                        {job.status === 'failed' && job.name.startsWith('Merge →') && (
                            <button className="small" onClick={() => void resolve(job)}>
                                Résoudre les conflits dans un chat
                            </button>
                        )}
                    </div>
                    <pre className="job-output">{job.output || '…'}</pre>
                </details>
            ))}
        </div>
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
                        <div className="pr-card">
                            <div>
                                <span className={`badge ${info.pr.state === 'OPEN' ? 'open' : info.pr.state === 'MERGED' ? 'merged' : 'closed'}`}>{info.pr.isDraft ? 'draft' : info.pr.state.toLowerCase()}</span>{' '}
                                <a href={info.pr.url} target="_blank" rel="noreferrer">
                                    PR #{info.pr.number}
                                </a>{' '}
                                → {info.pr.baseRefName}
                            </div>
                            <div>{info.pr.title}</div>
                            <div className="muted">Checks, commentaires de review et envoi au chat : phase 2.</div>
                        </div>
                    ) : (
                        <div className="muted">Pas encore de PR pour {run.branch}. Claude l'ouvre à la fin de l'implémentation ; sinon demande-lui dans le chat.</div>
                    )}
                </>
            )}
        </div>
    );
}

const PANEL_TITLES: Record<Panel, string> = { issue: 'Issue', diff: 'Diff', jobs: 'Commandes', pr: 'Branche et PR' };

export function ImplementView({ run }: { run: Run }): ReactElement {
    const repo = useStore((s) => s.repos.find((r) => r.id === run.repoId));
    const panel = useStore((s) => s.panels[run.id] ?? null);
    const setPanel = useStore((s) => s.setPanel);
    const jobs = useStore((s) => s.views[run.id]?.jobs ?? []);
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
    const runJob = async (action: () => Promise<JobInfo>): Promise<void> => {
        setPanel(run.id, 'jobs');
        try {
            await action();
        } catch (error) {
            notify(String(error), run.id);
        }
    };

    const running = jobs.some((j) => j.status === 'running');
    const base = run.baseBranch ?? profile?.baseBranch ?? 'master';
    const integration = profile?.integrationBranch ?? null;
    const commands = Object.keys(profile?.commands ?? {});

    const toolbar = (
        <>
            <OpenMenu run={run} />
            <button className={panel === 'issue' ? 'active' : ''} onClick={() => toggle('issue')}>
                Issue
            </button>
            <button className={panel === 'diff' ? 'active' : ''} onClick={() => toggle('diff')}>
                Diff
            </button>
            {commands.map((name) => (
                <button key={name} disabled={running} onClick={() => void runJob(() => api.command(run.id, name))} title={profile?.commands[name]}>
                    {name}
                </button>
            ))}
            <button disabled={running} onClick={() => void runJob(() => api.mergeBase(run.id))} title={`git fetch && git merge origin/${base} && git push`}>
                Merge {base}
            </button>
            {integration && (
                <button disabled={running} onClick={() => void runJob(() => api.mergeIntegration(run.id))} title={`Merge de ${run.branch} dans ${integration}, puis push`}>
                    Merge → {integration}
                </button>
            )}
            <button className={panel === 'jobs' ? 'active' : ''} onClick={() => toggle('jobs')}>
                Commandes{jobs.length ? ` (${jobs.length})` : ''}
            </button>
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

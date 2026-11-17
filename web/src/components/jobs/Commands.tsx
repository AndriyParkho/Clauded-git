import type { ReactElement } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type Profile, type ProjectsInfo } from '../../api';
import { useStore } from '../../store';
import { send } from '../../ws';
import { useResolveMerge } from '../MergeIntegration';
import type { JobInfo, Run } from '../../../../shared/protocol';

// ---------------------------------------------------------------------------------------------
// Petits stockages locaux (projet choisi par onglet, dernières commandes tapées par dépôt)
// ---------------------------------------------------------------------------------------------

function load<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
}

function save(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // stockage indisponible : le choix ne sera pas retenu
    }
}

const RECENT_MAX = 15;

function duration(job: JobInfo): string {
    const end = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
    const seconds = Math.round((end - new Date(job.startedAt).getTime()) / 1000);
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')}`;
}

/** Projets du worktree de l'onglet, et celui où lancer les commandes (retenu par onglet, sinon celui que la branche touche le plus). */
function useProject(run: Run): { info: ProjectsInfo | undefined; project: string; setProject: (p: string) => void; reload: () => void } {
    const key = `clauded.project.${run.id}`;
    const [info, setInfo] = useState<ProjectsInfo | undefined>();
    const [chosen, setChosen] = useState<string | null>(() => load<string | null>(key, null));
    const reload = useCallback(() => {
        api.projects(run.id)
            .then(setInfo)
            .catch(() => setInfo({ projects: ['.'], touched: [], suggested: '.' }));
    }, [run.id]);
    useEffect(reload, [reload]);
    const project = chosen !== null && (!info || info.projects.includes(chosen)) ? chosen : (info?.suggested ?? '.');
    const setProject = (p: string): void => {
        setChosen(p);
        save(key, p);
    };
    return { info, project, setProject, reload };
}

function ProjectSelect({ info, project, onChange, onReload }: { info: ProjectsInfo | undefined; project: string; onChange: (p: string) => void; onReload: () => void }): ReactElement {
    if (!info) return <span className="muted small-text">projets…</span>;
    if (info.projects.length <= 1) return <span className="muted small-text" title="Pas de workspaces : les commandes tournent à la racine du worktree">racine</span>;
    const touched = info.touched.filter((t) => t.path !== '.');
    const others = info.projects.filter((p) => p !== '.' && !touched.some((t) => t.path === p));
    return (
        <select
            className="project-select"
            value={project}
            onChange={(e) => onChange(e.target.value)}
            onFocus={onReload}
            title={`Dossier où lancer les commandes (lint, tests, typecheck, commande libre).\nProposé : ${info.suggested}, le projet le plus touché par la branche.`}
        >
            {touched.length > 0 && (
                <optgroup label="Touchés par la branche (nb de fichiers)">
                    {touched.map((t) => (
                        <option key={t.path} value={t.path}>
                            {t.path} · {t.files}
                        </option>
                    ))}
                </optgroup>
            )}
            <optgroup label="Racine">
                <option value=".">. (tout le dépôt)</option>
            </optgroup>
            <optgroup label="Autres projets">
                {others.map((p) => (
                    <option key={p} value={p}>
                        {p}
                    </option>
                ))}
            </optgroup>
        </select>
    );
}

/** Saisie d'une commande libre, avec les dernières commandes tapées dans ce dépôt. */
function CustomCommand({ repoId, project, onRun }: { repoId: number | null; project: string; onRun: (command: string) => void }): ReactElement {
    const key = `clauded.recentCommands.${repoId ?? 0}`;
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [recent, setRecent] = useState<string[]>(() => load<string[]>(key, []));
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const close = (e: MouseEvent): void => {
            if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    const run = (command: string): void => {
        const clean = command.trim();
        if (!clean) return;
        const next = [clean, ...recent.filter((c) => c !== clean)].slice(0, RECENT_MAX);
        setRecent(next);
        save(key, next);
        setText('');
        setOpen(false);
        onRun(clean);
    };

    return (
        <div className="menu custom-command" ref={box}>
            <button onClick={() => setOpen(!open)} title="Lancer une commande de ton choix dans le projet choisi">
                ▶ Commande…
            </button>
            {open && (
                <div className="command-popover">
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            run(text);
                        }}
                    >
                        <input className="mono" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="yarn test src/foo.test.ts" />
                        <button className="primary small" type="submit" disabled={!text.trim()}>
                            Lancer
                        </button>
                    </form>
                    <div className="muted command-where">
                        dans <span className="mono">{project === '.' ? 'la racine du worktree' : project}</span> (zsh -lc)
                    </div>
                    {recent.length > 0 && (
                        <div className="command-recent">
                            {recent.map((c) => (
                                <div key={c} className="command-recent-row">
                                    <button className="link mono" onClick={() => run(c)} title="Relancer">
                                        {c}
                                    </button>
                                    <button className="link muted" onClick={() => setText(c)} title="Modifier avant de lancer">
                                        ✎
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Boutons de commandes d'un onglet qui a un worktree : projet où se placer, commandes du profil
 * (Lint, Tests…), install, commande libre, et accès aux logs. Chaque lancement ouvre les logs.
 */
export function CommandTools({ run, jobs, onShowJobs, jobsOpen }: { run: Run; jobs: JobInfo[]; onShowJobs: (open: boolean) => void; jobsOpen: boolean }): ReactElement {
    const notify = useStore((s) => s.notify);
    const [profile, setProfile] = useState<Profile | undefined>();
    const { info, project, setProject, reload } = useProject(run);

    useEffect(() => {
        if (run.repoId === null) return;
        api.profile(run.repoId)
            .then((r) => setProfile(r.profile))
            .catch((e: unknown) => notify(String(e), run.id));
    }, [run.repoId, run.id, notify]);

    const launch = async (action: () => Promise<JobInfo>): Promise<void> => {
        onShowJobs(true);
        try {
            await action();
        } catch (error) {
            notify(String(error), run.id);
        }
    };

    const where = project === '.' ? '' : ` (dans ${project})`;
    const running = jobs.filter((j) => j.status === 'running').length;
    const failed = jobs.length > 0 && jobs[jobs.length - 1]?.status === 'failed';

    return (
        <>
            <span className="command-group">
                <ProjectSelect info={info} project={project} onChange={setProject} onReload={reload} />
                {Object.entries(profile?.commands ?? {}).map(([name, command]) => (
                    <button key={name} onClick={() => void launch(() => api.command(run.id, name, project))} title={`${command}${where}`}>
                        {name}
                    </button>
                ))}
                {profile?.install && (
                    <button onClick={() => void launch(() => api.install(run.id))} title={`${profile.install} (à la racine du worktree)`}>
                        Install
                    </button>
                )}
                <CustomCommand repoId={run.repoId} project={project} onRun={(command) => void launch(() => api.exec(run.id, command, project))} />
            </span>
            <button className={`${jobsOpen ? 'active' : ''} ${failed ? 'has-error' : ''}`} onClick={() => onShowJobs(!jobsOpen)} title="Logs des commandes lancées dans cet onglet">
                Logs{jobs.length ? ` (${jobs.length})` : ''}
                {running > 0 && <span className="dot dot-running inline-dot" />}
            </button>
        </>
    );
}

/** Sortie d'une commande ; suit la fin tant que la commande tourne (sauf si on remonte lire). */
function JobOutput({ job, className }: { job: JobInfo; className?: string }): ReactElement {
    const ref = useRef<HTMLPreElement>(null);
    const stick = useRef(true);
    useLayoutEffect(() => {
        const el = ref.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [job.output]);
    return (
        <pre
            ref={ref}
            className={`job-output ${className ?? ''}`}
            onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
        >
            {job.output || '…'}
        </pre>
    );
}

/** Logs des commandes d'un onglet : état, dossier, sortie en direct, arrêt, envoi au chat. */
export function JobsPanel({ run, jobs }: { run: Run; jobs: JobInfo[] }): ReactElement {
    const notify = useStore((s) => s.notify);
    const resolve = useResolveMerge();
    const [full, setFull] = useState<string | null>(null);
    const ordered = [...jobs].reverse();
    const fullJob = jobs.find((j) => j.id === full);

    const sendToChat = (job: JobInfo): void => {
        const tail = job.output.slice(-8000);
        const where = job.dir ? ` (dans \`${job.dir}\`)` : '';
        const text = job.status === 'failed' ? `La commande « ${job.name} »${where} lancée par l'app a échoué (code ${job.code}). Analyse la sortie ci-dessous, corrige, et relance ce qu'il faut.` : `Sortie de la commande « ${job.name} »${where} lancée par l'app :`;
        send({ type: 'prompt', runId: run.id, text: `${text}\n\n\`\`\`\n${tail}\n\`\`\`` });
    };

    const stop = async (job: JobInfo): Promise<void> => {
        try {
            await api.stopJob(job.id);
        } catch (error) {
            notify(String(error), run.id);
        }
    };

    if (ordered.length === 0) return <div className="muted pad">Aucune commande lancée dans cet onglet. Choisis un projet puis lance Lint, Tests, Install ou une commande libre.</div>;
    return (
        <div className="jobs">
            {ordered.map((job) => (
                <details key={job.id} className={`job job-${job.status}`} open={job === ordered[0]}>
                    <summary>
                        <span className={`dot dot-${job.status === 'running' ? 'running' : job.status === 'ok' ? 'idle' : 'error'}`} />
                        <span className="job-name mono">{job.name}</span>
                        {job.dir && <span className="job-dir mono">{job.dir}</span>}
                        <span className="spacer" />
                        <span className="muted">
                            {job.status === 'running' ? 'en cours' : job.status === 'ok' ? 'ok' : `échec (${job.code})`} · {duration(job)}
                        </span>
                    </summary>
                    <div className="job-actions">
                        {job.status === 'running' && (
                            <button className="small danger" onClick={() => void stop(job)} title="Arrête la commande et ce qu'elle a lancé">
                                ■ Arrêter
                            </button>
                        )}
                        <button className="small" disabled={job.status === 'running' || run.state === 'closed'} onClick={() => sendToChat(job)} title="Envoie la fin de la sortie à la session (8000 derniers caractères)">
                            Envoyer au chat
                        </button>
                        <button className="small" onClick={() => setFull(job.id)} title="Afficher la sortie en grand">
                            ⤢ Plein écran
                        </button>
                        {job.status === 'failed' && / → /.test(job.name) && job.name.startsWith('Merge ') && (
                            <button className="small" onClick={() => void resolve(job)}>
                                Résoudre les conflits dans un chat
                            </button>
                        )}
                    </div>
                    <JobOutput job={job} />
                </details>
            ))}
            {fullJob && (
                <div className="modal-backdrop" onClick={() => setFull(null)}>
                    <div className="modal job-modal wide-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="panel-head">
                            <span className="mono">
                                {fullJob.name}
                                {fullJob.dir && <span className="muted"> · {fullJob.dir}</span>}
                                <span className="muted"> · {fullJob.status === 'running' ? 'en cours' : fullJob.status === 'ok' ? 'ok' : `échec (${fullJob.code})`}</span>
                            </span>
                            <button className="small" onClick={() => setFull(null)}>
                                ×
                            </button>
                        </div>
                        <JobOutput job={fullJob} />
                    </div>
                </div>
            )}
        </div>
    );
}

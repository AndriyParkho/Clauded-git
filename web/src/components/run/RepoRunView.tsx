import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Profile } from '../../api';
import { reviewKey, useStore, type Panel } from '../../store';
import { ChatView } from '../chat/ChatView';
import { IssueBody } from '../issues/IssueBody';
import { DiffBrowser, DiffSummary } from '../DiffView';
import { CommandsMenu, JobsPanel, LogsLabel } from '../jobs/Commands';
import { GitMenu } from '../MergeIntegration';
import { ViewSwitch, type ViewOption } from '../ViewSwitch';
import { parseDiff } from '../../../../shared/diff';
import { BrunoButton } from '../BrunoButton';
import { OpenMenu } from '../OpenMenu';
import { Icon } from '../Icon';
import { PullInfo } from '../pulls/PullInfo';
import { ReviewPanel } from '../pulls/ReviewPanel';
import { ReviewSkillSelect } from '../pulls/ReviewSkillSelect';
import { Markdown } from '../Markdown';
import { withProgress } from '../Progress';
import { send } from '../../ws';
import { showRun } from '../../ui';
import type { InvestigationReport, JobInfo, PullDetail, Run, SlashCommandInfo, WorktreeInfo } from '../../../../shared/protocol';

// Références stables : `?? []` dans un sélecteur zustand recrée un tableau à chaque lecture et boucle.
const NO_JOBS: JobInfo[] = [];
const NO_COMMANDS: SlashCommandInfo[] = [];

/** Nom du job lancé par le bouton « Commit & push » (voir server/commit.ts). */
const COMMIT_JOB = 'Commit & push';

function DiffPanel({ run, base }: { run: Run; base: string }): ReactElement {
    const [diff, setDiff] = useState<{ stat: string; patch: string } | undefined>();
    const [error, setError] = useState<string | undefined>();
    const load = useCallback(() => {
        setError(undefined);
        api.diff(run.id)
            .then(setDiff)
            .catch((e: unknown) => setError(String(e)));
    }, [run.id]);
    useEffect(load, [load, run.state]);
    // Reparsé seulement quand le diff change, pas à chaque rendu de l'onglet.
    const files = useMemo(() => (diff?.patch.trim() ? parseDiff(diff.patch) : []), [diff]);
    if (error) return <div className="error pad">{error}</div>;
    if (!diff) return <div className="muted pad">chargement du diff…</div>;
    if (!diff.patch.trim()) return <div className="muted pad">Aucun commit par rapport à origin/{base} (les modifications non commitées n'apparaissent pas ici).</div>;
    return (
        <div className="review">
            <div className="review-head diff-head">
                <span className="muted">
                    Commits par rapport à <span className="mono">origin/{base}</span>
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

/** État de la branche du dossier, puis sa PR : checks, reviews, commentaires, envoi des commentaires non résolus au chat. */
function BranchPanel({ run, info, pull, pullError, onRefresh, onOpenIssue }: { run: Run; info: WorktreeInfo | undefined; pull: PullDetail | null | undefined; pullError: string | undefined; onRefresh: () => void; onOpenIssue: (n: number) => void }): ReactElement {
    const notify = useStore((s) => s.notify);
    const [sending, setSending] = useState(false);
    const sendComments = async (): Promise<void> => {
        setSending(true);
        try {
            const { sent } = await api.sendReviewComments(run.id);
            if (sent === 0) notify('Aucun commentaire de review non résolu.', { kind: 'info', runId: run.id });
        } catch (error) {
            notify(String(error), run.id);
        } finally {
            setSending(false);
        }
    };
    const open = pull ? pull.threads.filter((t) => !t.isResolved).length : 0;
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
                </>
            )}
            {pullError ? (
                <div className="error">{pullError}</div>
            ) : pull === undefined ? (
                info && <div className="muted">chargement de la PR…</div>
            ) : pull === null ? (
                <div className="muted">{run.type === 'implement' ? `Pas encore de PR pour ${run.branch ?? 'la branche'}. Claude l'ouvre à la fin de l'implémentation ; sinon demande-lui dans le chat.` : 'Pas de PR pour cette branche.'}</div>
            ) : (
                <PullInfo
                    pull={pull}
                    repoId={run.repoId ?? 0}
                    onOpenIssue={onOpenIssue}
                    actions={
                        <button className="small" disabled={sending || open === 0 || run.state === 'running'} onClick={() => void sendComments()} title="Envoie les commentaires de review non résolus à la session, qui les traite">
                            Envoyer les commentaires au chat ({open})
                        </button>
                    }
                />
            )}
        </div>
    );
}

/**
 * « Commit & push » : commit de tout ce qui est modifié (message écrit par un petit modèle, voir
 * `commitModel` du profil) puis push, sans faire travailler la session. Visible quand il y a quelque
 * chose à commiter ou à pousser.
 */
function CommitPushButton({ run, info, jobs, onShowJobs }: { run: Run; info: WorktreeInfo | undefined; jobs: JobInfo[]; onShowJobs: () => void }): ReactElement | null {
    const notify = useStore((s) => s.notify);
    const [starting, setStarting] = useState(false);
    const running = starting || jobs.some((j) => j.name === COMMIT_JOB && j.status === 'running');
    if (!info?.branch) return null;
    const toPush = info.hasUpstream ? info.ahead : 1;
    if (!info.dirty && toPush === 0 && !running) return null;

    const start = async (allowProtected = false): Promise<void> => {
        setStarting(true);
        try {
            await api.commitPush(run.id, allowProtected);
            onShowJobs();
        } catch (error) {
            if (error instanceof ApiError && error.protectedBranch && !allowProtected) {
                if (window.confirm(`La branche courante est ${error.protectedBranch}. Commiter et pousser directement dessus ?`)) await start(true);
            } else notify(String(error), run.id);
        } finally {
            setStarting(false);
        }
    };

    const label = info.dirty ? `Commit & push${info.changedFiles ? ` (${info.changedFiles})` : ''}` : info.hasUpstream ? `Push (↑${info.ahead})` : 'Push';
    const title = info.dirty
        ? `Commit des ${info.changedFiles} fichiers modifiés (message écrit par un petit modèle, sans passer par la session) puis push de ${info.branch}`
        : `Pousse ${info.branch}${info.hasUpstream ? '' : ' (première fois, avec -u)'}`;
    return (
        <button className="commit-push" disabled={running || run.state === 'running'} onClick={() => void start()} title={run.state === 'running' ? 'Attends la fin du tour de Claude' : title}>
            <Icon name="commit" size={14} /> {running ? 'Commit & push…' : label}
        </button>
    );
}

/** Consigne envoyée par « Rédiger le rapport ». */
const REPORT_PROMPT = "Rédige maintenant le rapport d'investigation dans le fichier prévu (voir tes consignes), avec ce que tu as établi jusqu'ici ; signale ce qui reste à confirmer.";

/** Rapport d'une investigation : relu à l'ouverture et après chaque tour de Claude. */
function useReport(run: Run): InvestigationReport | undefined {
    const [report, setReport] = useState<InvestigationReport | undefined>();
    const investigation = run.intent === 'investigation';
    useEffect(() => {
        if (!investigation || run.state === 'running' || run.state === 'starting') return;
        api.report(run.id)
            .then(setReport)
            .catch(() => undefined);
    }, [investigation, run.id, run.state]);
    return investigation ? report : undefined;
}

/**
 * Actions d'une investigation : rédiger le rapport, le publier (commentaire sur l'issue ou la PR
 * liée, sinon nouvelle issue), passer au correctif (issue implémentée avec le rapport en point de départ).
 */
function ReportActions({ run, report, onShow }: { run: Run; report: InvestigationReport | undefined; onShow: () => void }): ReactElement {
    const notify = useStore((s) => s.notify);
    const upsertRun = useStore((s) => s.upsertRun);
    const [publishing, setPublishing] = useState(false);
    const [fixing, setFixing] = useState(false);
    const has = Boolean(report?.content?.trim());
    const target = run.issueNumber !== null ? `#${run.issueNumber}` : run.prNumber !== null ? `la PR #${run.prNumber}` : null;
    const busy = run.state === 'running';

    if (!has) {
        return (
            <button disabled={busy || run.state === 'starting'} onClick={() => send({ type: 'prompt', runId: run.id, text: REPORT_PROMPT })} title="Demande à Claude d'écrire le rapport (constat, cause, impact, correctif proposé)">
                <Icon name="spec" size={14} /> Rédiger le rapport
            </button>
        );
    }

    const publish = async (): Promise<void> => {
        if (!target && !window.confirm("Créer une issue sur GitHub avec ce rapport (titre : son premier titre « # … ») ?")) return;
        setPublishing(true);
        try {
            upsertRun(await api.publishReport(run.id));
        } catch (error) {
            notify(String(error), run.id);
        } finally {
            setPublishing(false);
        }
    };
    const fix = async (): Promise<void> => {
        const what = run.reportUrl ? '' : target ? `Le rapport sera publié sur ${target}, puis ` : 'Une issue sera créée avec le rapport, puis ';
        if (!window.confirm(`${what}${what ? "l'issue" : "L'issue"} sera implémentée (branche liée, worktree, session) en partant du rapport. Continuer ?`)) return;
        setFixing(true);
        try {
            const next = await withProgress('Passage au correctif', (opId) => api.fixFromReport(run.id, opId));
            upsertRun(next);
            showRun(next.id);
        } catch {
            // L'erreur reste affichée dans le loader.
        } finally {
            setFixing(false);
        }
    };

    return (
        <span className="report-bar">
            <button className="small" onClick={onShow} title="Afficher le rapport">
                Rapport
            </button>
            {run.reportUrl ? (
                <a className="small" href={run.reportUrl} target="_blank" rel="noreferrer" title="Rapport publié sur GitHub">
                    Publié <Icon name="external" size={12} />
                </a>
            ) : (
                <button disabled={publishing || busy} onClick={() => void publish()} title={target ? `Publie le rapport en commentaire sur ${target}` : "Crée une issue sur GitHub avec le rapport, rattachée à cet onglet"}>
                    {publishing ? 'Publication…' : target ? `Publier sur ${target}` : "Créer l'issue"}
                </button>
            )}
            <button className="primary" disabled={fixing || busy} onClick={() => void fix()} title="Publie le rapport s'il ne l'est pas, puis implémente l'issue (ou envoie le rapport à l'onglet déjà ouvert sur sa branche)">
                {fixing ? 'Lancement…' : 'Passer au correctif'}
            </button>
        </span>
    );
}

/**
 * Onglet lié à un dépôt : implémentation d'une issue, PR, résolution de conflits ou chat. Mêmes
 * panneaux (diff, issue, branche et PR, logs) et mêmes actions (commandes, git, commit & push, ouvrir)
 * pour tous ; une PR y ajoute ses brouillons de review et le lancement de la review.
 */
export function RepoRunView({ run }: { run: Run }): ReactElement {
    const repo = useStore((s) => s.repos.find((r) => r.id === run.repoId));
    const isPr = run.type === 'pr';
    // Une PR s'ouvre sur sa review (c'est la raison d'être de l'onglet) ; les autres, sans panneau.
    const panel = useStore((s): Panel | null => s.panels[run.id] ?? (s.panels[run.id] === undefined && isPr ? 'review' : null));
    const setPanel = useStore((s) => s.setPanel);
    const jobs = useStore((s) => s.views[run.id]?.jobs ?? NO_JOBS);
    const commands = useStore((s) => s.views[run.id]?.commands ?? NO_COMMANDS);
    const drafts = useStore((s) => (repo && run.prNumber !== null ? (s.reviews[reviewKey(repo.id, run.prNumber)]?.drafts.length ?? 0) : 0));
    const notify = useStore((s) => s.notify);
    const [profile, setProfile] = useState<Profile | undefined>();
    const [info, setInfo] = useState<WorktreeInfo | undefined>();
    const [pull, setPull] = useState<PullDetail | null | undefined>();
    const [pullError, setPullError] = useState<string | undefined>();
    const [issueNumber, setIssueNumber] = useState<number | null>(null);
    const [reviewing, setReviewing] = useState(false);
    const report = useReport(run);
    const investigation = run.intent === 'investigation';
    // Chat en lecture seule (investigation, question) : ni commit, ni merge.
    const readOnly = run.intent !== null;

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
    const loadPull = useCallback(() => {
        setPullError(undefined);
        api.runPull(run.id)
            .then((r) => setPull(r.pull))
            .catch((e: unknown) => setPullError(String(e)));
    }, [run.id]);
    const refresh = useCallback(() => {
        refreshInfo();
        loadPull();
    }, [refreshInfo, loadPull]);

    // État de la branche à l'ouverture, puis après chaque tour de Claude et chaque commande.
    useEffect(() => {
        if (run.state === 'idle' || run.state === 'closed') refreshInfo();
    }, [run.state, refreshInfo]);
    useEffect(() => {
        if (jobs.every((j) => j.status !== 'running')) refreshInfo();
    }, [jobs, refreshInfo]);
    // La PR : à l'ouverture, et quand la branche en gagne une (ouverte par Claude en fin d'implémentation).
    const prNumber = run.prNumber ?? info?.pr?.number ?? null;
    useEffect(loadPull, [loadPull, prNumber]);

    const toggle = (next: Panel): void => setPanel(run.id, panel === next ? null : next);
    const base = run.baseBranch ?? pull?.baseRefName ?? profile?.baseBranch ?? 'master';
    const branch = info?.branch ?? run.branch;
    const busy = jobs.some((j) => j.status === 'running');

    // Issues de l'onglet : la sienne, puis celles que la PR ferme ou référence.
    const issues = useMemo(() => {
        const list: Array<{ number: number; title?: string }> = run.issueNumber !== null ? [{ number: run.issueNumber }] : [];
        for (const issue of pull?.issues ?? []) {
            if (issue.otherRepo) continue;
            const known = list.find((i) => i.number === issue.number);
            if (known) known.title = issue.title;
            else list.push({ number: issue.number, title: issue.title });
        }
        return list;
    }, [run.issueNumber, pull]);
    // L'issue affichée : celle choisie (y compris depuis la PR), sinon la première.
    const shownIssue = issueNumber ?? issues[0]?.number ?? null;
    const openIssue = (number: number): void => {
        setIssueNumber(number);
        setPanel(run.id, 'issue');
    };

    const options: Array<ViewOption<Panel>> = [
        isPr
            ? { value: 'review', label: `Diff${drafts ? ` · ${drafts} brouillons` : ''}`, title: 'Diff de la PR et brouillons de review' }
            : { value: 'diff', label: 'Diff', title: `Commits par rapport à origin/${base}` },
        ...issues.map((issue) => ({
            value: 'issue' as const,
            key: `issue-${issue.number}`,
            label: `#${issue.number}`,
            title: issue.title ? `Issue #${issue.number} : ${issue.title}` : `Issue #${issue.number}`,
            active: panel === 'issue' && shownIssue === issue.number,
            // Affiche cette issue ; ne ferme le panneau que si c'est déjà elle.
            onSelect: () => (panel === 'issue' && shownIssue === issue.number ? setPanel(run.id, null) : openIssue(issue.number)),
        })),
        { value: 'pr', label: prNumber !== null ? `PR #${prNumber}` : 'PR', title: 'État de la branche et de sa PR (checks, reviews, commentaires)' },
        { value: 'jobs', label: <LogsLabel jobs={jobs} />, title: 'Logs des commandes lancées dans cet onglet' },
        ...(investigation ? [{ value: 'report' as const, label: report?.content ? 'Rapport' : 'Rapport (vide)', title: "Rapport d'investigation écrit par Claude" }] : []),
    ];

    // Merges : la branche de l'onglet (issue, PR) ou celle sortie dans le dossier d'un chat (sauf la base).
    const what = run.issueNumber !== null && !run.branch ? `la branche de l'issue #${run.issueNumber}` : run.prNumber !== null && !run.branch ? `la branche de la PR #${run.prNumber}` : (branch ?? 'la branche');
    const canMerge =
        repo !== undefined &&
        !readOnly &&
        run.type !== 'merge' &&
        (isPr ? pull !== undefined && pull !== null && !pull.isCrossRepository && pull.state === 'OPEN' : run.issueNumber !== null || run.prNumber !== null || (branch !== null && branch !== base && branch !== profile?.integrationBranch));
    const canPush = !readOnly && run.type !== 'merge' && !(isPr && pull?.isCrossRepository);

    const sessionSkills = commands.map((c) => c.name).filter((name) => /review/i.test(name));
    const review = async (): Promise<void> => {
        setReviewing(true);
        setPanel(run.id, 'review');
        try {
            await api.startReview(run.id);
        } catch (error) {
            notify(String(error), run.id);
        } finally {
            setReviewing(false);
        }
    };

    const actions = (
        <>
            {repo && <CommandsMenu run={run} jobs={jobs} onShowJobs={(open) => setPanel(run.id, open ? 'jobs' : null)} />}
            {repo && canMerge && <GitMenu repoId={repo.id} base={base} what={what} mergeBase={() => api.mergeBase(run.id)} mergeIntegration={() => api.mergeIntegration(run.id)} disabled={busy} runId={run.id} />}
            <OpenMenu path={run.worktree ?? run.cwd} runId={run.id}>
                {repo && <BrunoButton repoId={repo.id} path={run.worktree ?? run.cwd} />}
            </OpenMenu>
            {investigation && <ReportActions run={run} report={report} onShow={() => setPanel(run.id, 'report')} />}
            {canPush && <CommitPushButton run={run} info={info} jobs={jobs} onShowJobs={() => setPanel(run.id, 'jobs')} />}
            {isPr && (
                <span className="split-action">
                    <button className="primary" disabled={reviewing || run.state === 'running'} onClick={() => void review()} title="Relit la PR et écrit les brouillons ; rien n'est publié">
                        {reviewing ? 'Lancement…' : 'Lancer la review'}
                    </button>
                    {repo && <ReviewSkillSelect repoId={repo.id} extra={sessionSkills} />}
                </span>
            )}
        </>
    );

    const subtitle = (
        <span className="branch-line">
            {branch && (
                <span className="branch-name mono" title={`${branch} ← ${base}`}>
                    {branch}
                    {branch !== base && <span className="muted"> → {base}</span>}
                </span>
            )}
            {info && (info.dirty ? <span className="warn">{info.changedFiles} modif.</span> : <span className="ok-text">propre</span>)}
            {info?.hasUpstream && (info.ahead > 0 || info.behind > 0) && <span className="mono">↑{info.ahead} ↓{info.behind}</span>}
            {info?.branch && !info.hasUpstream && <span>pas poussée</span>}
            {run.installStatus && run.installStatus !== 'ok' && <span className={run.installStatus === 'failed' ? 'error' : 'warn'}>install {run.installStatus === 'running' ? 'en cours' : run.installStatus === 'failed' ? 'en échec' : run.installStatus}</span>}
        </span>
    );

    const content =
        panel === 'review' && repo && run.prNumber !== null ? (
            <ReviewPanel repoId={repo.id} prNumber={run.prNumber} runId={run.id} />
        ) : panel === 'diff' ? (
            <DiffPanel run={run} base={base} />
        ) : panel === 'issue' && repo && shownIssue !== null ? (
            <IssueBody repoId={repo.id} number={shownIssue} compact />
        ) : panel === 'pr' ? (
            <BranchPanel run={run} info={info} pull={pull} pullError={pullError} onRefresh={refresh} onOpenIssue={openIssue} />
        ) : panel === 'jobs' ? (
            <JobsPanel run={run} jobs={jobs} />
        ) : panel === 'report' && investigation ? (
            report?.content ? (
                <div className="report-body">
                    <Markdown text={report.content} />
                </div>
            ) : (
                <div className="muted pad">Pas encore de rapport. Claude l'écrit quand il a conclu, ou avec « Rédiger le rapport ».</div>
            )
        ) : null;
    const panelTitle =
        panel === 'review' ? `Review de la PR #${run.prNumber ?? '?'}` : panel === 'diff' ? 'Diff' : panel === 'issue' ? `Issue #${shownIssue ?? '?'}` : panel === 'pr' ? 'Branche et PR' : panel === 'jobs' ? 'Logs des commandes' : panel === 'report' ? `Rapport d'investigation${report?.updatedAt ? ` · ${new Date(report.updatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : ''}` : '';

    return (
        <ChatView
            run={run}
            views={<ViewSwitch<Panel> value={panel} onChange={toggle} options={options} />}
            actions={actions}
            subtitle={subtitle}
            wide={panel === 'diff' || panel === 'review'}
            panel={
                content && (
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

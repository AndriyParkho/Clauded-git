import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Modal } from './Modal';
import type { CleanupList, Repo } from '../../../shared/protocol';

/** Chemin d'un worktree relatif au dépôt (`.worktrees/issue-12`). */
function short(path: string, repo: Repo): string {
    return path.startsWith(`${repo.path}/`) ? path.slice(repo.path.length + 1) : path;
}

/**
 * Liste les worktrees et branches locales qui ne servent plus (PR mergée, issue fermée…) et
 * supprime ceux qu'on coche. Ceux qui feraient perdre du travail ne sont pas cochés d'office.
 */
function CleanupDialog({ repo, onClose }: { repo: Repo; onClose: () => void }): ReactElement {
    const notify = useStore((s) => s.notify);
    const [list, setList] = useState<CleanupList | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [checked, setChecked] = useState<Set<string>>(new Set());

    useEffect(() => {
        let live = true;
        api.cleanup(repo.id)
            .then((result) => {
                if (!live) return;
                setList(result);
                setChecked(new Set(result.items.filter((i) => i.safe).map((i) => i.id)));
            })
            .catch((e: unknown) => live && setError(String(e)));
        return () => {
            live = false;
        };
    }, [repo.id]);

    const toggle = (id: string, on: boolean): void =>
        setChecked((s) => {
            const next = new Set(s);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });

    const [starting, setStarting] = useState(false);
    // La suppression tourne en tâche de fond : la fenêtre se ferme, le bouton suit le job.
    const run = async (): Promise<void> => {
        setStarting(true);
        try {
            const job = await api.runCleanup(repo.id, [...checked]);
            useStore.setState((s) => ({ jobs: { ...s.jobs, [job.id]: s.jobs[job.id] ?? job }, cleanupJobs: { ...s.cleanupJobs, [repo.id]: job.id } }));
            onClose();
        } catch (error) {
            notify(String(error));
            setStarting(false);
        }
    };

    const risky = list?.items.filter((i) => !i.safe && checked.has(i.id)).length ?? 0;

    return (
        <Modal className="batch-modal cleanup-modal" onClose={onClose}>
            <div className="batch-head">
                <strong>
                    Nettoyer {repo.owner}/{repo.name}
                </strong>
                <span className="spacer" />
                <button className="small" onClick={onClose} title="Fermer">
                    ×
                </button>
            </div>
            <p className="muted batch-intro">
                Worktrees et branches locales dont la PR est mergée, l'issue fermée, ou déjà mergés dans {list?.base ?? 'la base'}. Une PR encore ouverte et les branches de base ne sont jamais proposées. Les branches distantes ne sont pas
                touchées.
            </p>
            {!list && !error && (
                <div className="batch-loading">
                    <span className="spinner small" /> git fetch, lecture des PR et des issues sur GitHub…
                </div>
            )}
            {error && <div className="error pad">{error}</div>}
            {list && list.items.length === 0 && <div className="muted pad">Rien à nettoyer ({list.kept} worktrees ou branches gardés).</div>}
            {list && list.items.length > 0 && (
                <>
                    <div className="cleanup-select muted">
                        <button className="link small-link" onClick={() => setChecked(new Set(list.items.map((i) => i.id)))}>
                            tout cocher
                        </button>
                        <button className="link small-link" onClick={() => setChecked(new Set(list.items.filter((i) => i.safe).map((i) => i.id)))}>
                            sans risque seulement
                        </button>
                        <button className="link small-link" onClick={() => setChecked(new Set())}>
                            rien
                        </button>
                        <span className="spacer" />
                        {list.kept} gardés
                    </div>
                    <ul className="cleanup-list">
                        {list.items.map((item) => (
                            <li key={item.id} className={`cleanup-item ${item.safe ? '' : 'risky'}`}>
                                <label className="cleanup-line">
                                    <input type="checkbox" checked={checked.has(item.id)} onChange={(e) => toggle(item.id, e.target.checked)} />
                                    <span className="cleanup-what">
                                        {item.worktree && <span className="mono">{short(item.worktree, repo)}</span>}
                                        {item.worktree && item.branch && <span className="muted"> · </span>}
                                        {item.branch && <span className="mono">{item.worktree ? item.branch : `branche ${item.branch}`}</span>}
                                        {!item.branch && item.worktree && <span className="muted"> (détaché)</span>}
                                    </span>
                                </label>
                                {item.issue && (
                                    <div className="muted cleanup-issue">
                                        #{item.issue.number} {item.issue.title}
                                    </div>
                                )}
                                <div className="cleanup-tags">
                                    {item.reasons.map((r) => (
                                        <span key={r} className="cleanup-reason">
                                            {r}
                                        </span>
                                    ))}
                                    {item.warnings.map((w) => (
                                        <span key={w} className="cleanup-warning">
                                            {'⚠\uFE0E'} {w}
                                        </span>
                                    ))}
                                </div>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            <div className="batch-actions">
                {risky > 0 && <span className="warn small-link">{risky} élément{risky > 1 ? 's' : ''} coché{risky > 1 ? 's' : ''} avec du travail non sauvegardé</span>}
                <span className="spacer" />
                <button onClick={onClose}>Annuler</button>
                <button className={risky > 0 ? 'danger' : 'primary'} disabled={!list || checked.size === 0 || starting} onClick={() => void run()} title="Tourne en tâche de fond ; la sortie se consulte à côté du bouton « Nettoyer »">
                    Supprimer {checked.size}
                </button>
            </div>
        </Modal>
    );
}

/**
 * Bouton « Nettoyer » d'un dépôt : ouvre la liste des worktrees et branches inutiles. La suppression
 * tourne en tâche de fond ; son état s'affiche à côté, et un clic montre sa sortie (en direct).
 */
export function CleanupButton({ repo, label = 'Nettoyer…' }: { repo: Repo; label?: string }): ReactElement {
    const [open, setOpen] = useState(false);
    const [showOutput, setShowOutput] = useState(false);
    const job = useStore((s) => {
        const id = s.cleanupJobs[repo.id];
        return id ? s.jobs[id] : undefined;
    });
    const running = job?.status === 'running';
    return (
        <span className="merge-integration">
            <button className="small" disabled={running} onClick={() => setOpen(true)} title="Supprimer les worktrees et branches locales dont la PR est mergée ou l'issue fermée">
                {label}
            </button>
            {job && (
                <button className={`link small-link ${running ? '' : job.status === 'ok' ? 'ok' : 'error'}`} onClick={() => setShowOutput(true)} title="Voir ce que fait le nettoyage">
                    {running ? (
                        <>
                            <span className="spinner small" /> nettoyage en cours
                        </>
                    ) : job.status === 'ok' ? (
                        '✓ nettoyé'
                    ) : (
                        '✗ nettoyage avec erreurs'
                    )}
                </button>
            )}
            {open && <CleanupDialog repo={repo} onClose={() => setOpen(false)} />}
            {showOutput && job && (
                <Modal className="job-modal" onClose={() => setShowOutput(false)}>
                    <div className="panel-head">
                        <span>
                            {job.name}
                            {running ? ' · en cours' : ''}
                        </span>
                        <button className="small" onClick={() => setShowOutput(false)}>
                            ×
                        </button>
                    </div>
                    <pre className="job-output">{job.output || '…'}</pre>
                </Modal>
            )}
        </span>
    );
}

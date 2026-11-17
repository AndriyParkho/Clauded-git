import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Modal } from './Modal';
import type { JobInfo } from '../../../shared/protocol';

/** Branches du profil de chaque dépôt (base et intégration), lues une fois. */
const branches = new Map<number, Promise<{ base: string; integration: string | null } | null>>();

function useProfileBranches(repoId: number | null): { base: string; integration: string | null } | null {
    const [value, setValue] = useState<{ base: string; integration: string | null } | null>(null);
    useEffect(() => {
        if (repoId === null) return;
        let promise = branches.get(repoId);
        if (!promise) {
            promise = api
                .profile(repoId)
                .then((r) => ({ base: r.profile.baseBranch, integration: r.profile.integrationBranch }))
                .catch(() => null);
            branches.set(repoId, promise);
        }
        let live = true;
        void promise.then((b) => live && setValue(b));
        return () => {
            live = false;
        };
    }, [repoId]);
    return value;
}

/** Branche d'intégration (`develop`) du dépôt, `null` s'il n'en a pas. */
export function useIntegrationBranch(repoId: number | null): string | null {
    return useProfileBranches(repoId)?.integration ?? null;
}

/** Ouvre l'onglet de résolution des conflits d'un merge dans develop qui a échoué. */
export function useResolveMerge(): (job: JobInfo) => Promise<void> {
    const notify = useStore((s) => s.notify);
    const upsertRun = useStore((s) => s.upsertRun);
    const setActive = useStore((s) => s.setActive);
    return async (job) => {
        try {
            const run = await api.resolveMerge(job.id);
            upsertRun(run);
            setActive(run.id);
        } catch (error) {
            notify(String(error));
        }
    };
}

interface MergeButtonProps {
    label: string;
    /** Question posée avant de lancer. */
    confirm: string;
    title: string;
    /** Texte affiché après un merge réussi. */
    done: string;
    /** Lance le merge ; le job rendu est suivi ici (état, sortie, résolution des conflits). */
    start: () => Promise<JobInfo>;
    disabled?: boolean | undefined;
}

/** Un bouton de merge qui affiche à côté l'état du job, sa sortie et, en cas d'échec, la résolution. */
function MergeButton({ label, confirm, title, done, start, disabled }: MergeButtonProps): ReactElement {
    const notify = useStore((s) => s.notify);
    const resolve = useResolveMerge();
    const [jobId, setJobId] = useState<string | undefined>();
    const [starting, setStarting] = useState(false);
    const [showOutput, setShowOutput] = useState(false);
    const job = useStore((s) => (jobId ? s.jobs[jobId] : undefined));
    const running = starting || job?.status === 'running';

    const run = async (): Promise<void> => {
        if (!window.confirm(confirm)) return;
        setStarting(true);
        setShowOutput(false);
        try {
            const started = await start();
            useStore.setState((s) => ({ jobs: { ...s.jobs, [started.id]: s.jobs[started.id] ?? started } }));
            setJobId(started.id);
        } catch (error) {
            notify(String(error));
        } finally {
            setStarting(false);
        }
    };

    return (
        <span className="merge-integration">
            <button disabled={disabled || running} onClick={() => void run()} title={title}>
                {running ? `${label}…` : label}
            </button>
            {job && job.status !== 'running' && (
                <>
                    <button className={`link ${job.status === 'ok' ? 'ok' : 'error'}`} onClick={() => setShowOutput(true)} title="Voir la sortie des commandes">
                        {job.status === 'ok' ? `✓ ${done}` : '✗ échec du merge'}
                    </button>
                    {job.status === 'failed' && (
                        <button className="small" onClick={() => void resolve(job)} title="Confie la résolution des conflits à Claude, dans le worktree du merge">
                            Résoudre les conflits
                        </button>
                    )}
                </>
            )}
            {showOutput && job && (
                <Modal className="job-modal" onClose={() => setShowOutput(false)}>
                    <div className="panel-head">
                        <span>{job.name}</span>
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

interface Props {
    repoId: number;
    start: () => Promise<JobInfo>;
    /** Ce qui est mergé, pour l'infobulle (`la branche de l'issue`, `feature/123-…`). */
    what: string;
    disabled?: boolean;
}

/**
 * Bouton « Merge → develop » d'une issue, d'une PR ou d'un chat : merge la branche dans la branche
 * d'intégration et pousse. Rien si le dépôt n'a pas de develop.
 */
export function MergeIntegrationButton({ repoId, start, what, disabled }: Props): ReactElement | null {
    const integration = useIntegrationBranch(repoId);
    if (!integration) return null;
    return (
        <MergeButton
            label={`Merge → ${integration}`}
            confirm={`Merger ${what} dans ${integration} et pousser ${integration} ?`}
            title={`Merge ${what} dans ${integration}, puis push de ${integration}`}
            done={`mergé dans ${integration}`}
            start={start}
            disabled={disabled}
        />
    );
}

/**
 * Bouton « Merge master » d'une issue, d'une PR ou d'un onglet : merge `origin/<base>` dans la
 * branche et la pousse. `base` : celle de la PR ou de l'onglet, sinon celle du profil.
 */
export function MergeBaseButton({ repoId, base, start, what, disabled }: Props & { base?: string | null | undefined }): ReactElement | null {
    const profileBase = useProfileBranches(repoId)?.base;
    const branch = base ?? profileBase;
    if (!branch) return null;
    return (
        <MergeButton
            label={`Merge ${branch}`}
            confirm={`Merger origin/${branch} dans ${what} et la pousser ?`}
            title={`git fetch && git merge origin/${branch} dans ${what}, puis push`}
            done={`${branch} mergée`}
            start={start}
            disabled={disabled}
        />
    );
}

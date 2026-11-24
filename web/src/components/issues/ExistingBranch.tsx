import type { ReactElement } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { Modal } from '../Modal';
import { withProgress } from '../Progress';
import type { ExistingBranch } from '../../../../shared/protocol';

const SOURCES: Record<ExistingBranch['source'], string> = { worktree: 'worktree déjà sorti', linked: 'branche liée sur GitHub', pr: 'branche de la PR', remote: 'branche distante au numéro de l\'issue' };

/** Ce qu'il y a sur la branche : commits, dernier commit, modifications locales, PR. */
export function ExistingBranchInfo({ branch }: { branch: ExistingBranch }): ReactElement {
    const facts = [
        branch.commits !== null ? `${branch.commits} commit${branch.commits > 1 ? 's' : ''}` : null,
        branch.uncommitted > 0 ? `${branch.uncommitted} fichier${branch.uncommitted > 1 ? 's' : ''} modifié${branch.uncommitted > 1 ? 's' : ''} non commité${branch.uncommitted > 1 ? 's' : ''}` : null,
        branch.pr ? `PR #${branch.pr.number}${branch.pr.isDraft ? ' (draft)' : ''}` : null,
    ].filter(Boolean);
    return (
        <span className="existing-branch">
            <span className="mono">{branch.branch}</span>
            <span className="muted">
                {' '}
                · {SOURCES[branch.source]}
                {facts.length > 0 && ` · ${facts.join(', ')}`}
                {branch.lastCommit && ` · dernier : ${branch.lastCommit}`}
            </span>
        </span>
    );
}

/** Ouvre un onglet sur la branche (sans consigne), la question de point d'étape dans la saisie. */
export async function openBranchChat(repoId: number, number: number): Promise<void> {
    const { run, draft } = await withProgress(`Chat sur la branche de l'issue #${number}`, (opId) => api.branchChat(repoId, number, opId));
    const store = useStore.getState();
    store.upsertRun(run);
    store.setDraft(run.id, draft);
    store.setActive(run.id);
}

interface Props {
    number: number;
    branch: ExistingBranch;
    onChat: () => void;
    onImplement: () => void;
    onClose: () => void;
}

/** Avant d'implémenter une issue qui a déjà une branche travaillée : on en discute, ou on reprend dessus. */
export function ExistingBranchDialog({ number, branch, onChat, onImplement, onClose }: Props): ReactElement {
    return (
        <Modal className="batch-modal" onClose={onClose}>
            <div className="batch-head">
                <strong>#{number} a déjà une branche</strong>
                <span className="spacer" />
                <button className="small" onClick={onClose} title="Fermer">
                    ×
                </button>
            </div>
            <div>
                <ExistingBranchInfo branch={branch} />
            </div>
            <p className="muted batch-intro">
                Du travail a déjà été fait sur cette branche. Ouvre plutôt un chat dans son worktree pour faire le point (Claude regarde les commits, le diff et la PR, sans rien modifier), ou relance l'implémentation : elle
                repart de ce qui existe.
            </p>
            <div className="batch-actions">
                <span className="spacer" />
                <button onClick={onClose}>Annuler</button>
                <button onClick={onImplement} title="Session d'implémentation sur la branche existante, qui part du travail déjà fait">
                    Reprendre l'implémentation
                </button>
                <button className="primary" onClick={onChat}>
                    Ouvrir un chat sur la branche
                </button>
            </div>
        </Modal>
    );
}

import type { Panel } from '../../store';
import type { IconName } from '../Icon';
import type { Run } from '../../../../shared/protocol';

/**
 * Panneaux d'un onglet de dépôt (voir RepoRunView), pour la palette ⌘K. Un onglet de PR montre son
 * diff avec les brouillons de review ; les autres, le diff de la branche. Module à part : la palette
 * ne doit pas charger la vue (chargée à la première ouverture d'un tel onglet).
 */
export function repoRunPanels(run: Run): Array<{ panel: Panel; label: string; icon: IconName; keywords?: string }> {
    return [
        run.type === 'pr'
            ? { panel: 'review', label: 'Afficher le diff et les brouillons de review', icon: 'code', keywords: 'review commentaires changements' }
            : { panel: 'diff', label: 'Afficher le diff', icon: 'code', keywords: 'changements' },
        ...(run.issueNumber !== null ? [{ panel: 'issue' as const, label: `Afficher l'issue #${run.issueNumber}`, icon: 'issue' as const }] : []),
        { panel: 'pr', label: 'Afficher la branche et la PR', icon: 'pr', keywords: 'pull request checks commentaires description' },
        { panel: 'jobs', label: 'Afficher les logs des commandes', icon: 'terminal', keywords: 'jobs sortie' },
    ];
}

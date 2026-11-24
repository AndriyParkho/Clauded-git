import type { ReactElement } from 'react';
import { lazy, Suspense } from 'react';
import { ChatView } from './chat/ChatView';
import { OpenMenu } from './OpenMenu';
import type { Run } from '../../../shared/protocol';

// Vues chargées à la première ouverture d'un onglet de ce type : elles tirent le diff, la review et
// la spec, inutiles pour afficher l'app et un chat hors dépôt.
const RepoRunView = lazy(() => import('./run/RepoRunView').then((m) => ({ default: m.RepoRunView })));
const SpecView = lazy(() => import('./spec/SpecView').then((m) => ({ default: m.SpecView })));

function Loading(): ReactElement {
    return <div className="muted pad">chargement…</div>;
}

/**
 * La vue d'un onglet : spec, onglet de dépôt (implémentation, PR, conflits, chat — mêmes panneaux et
 * mêmes actions), ou chat dans un dossier hors dépôt.
 */
// `key` : chaque onglet a sa propre vue (état de la branche, PR, menus ouverts), même quand le volet
// passe d'un onglet à un autre du même type.
export function RunContent({ run }: { run: Run }): ReactElement {
    if (run.type === 'spec' || run.repoId !== null) {
        return <Suspense fallback={<Loading />}>{run.type === 'spec' ? <SpecView run={run} /> : <RepoRunView key={run.id} run={run} />}</Suspense>;
    }
    return <ChatView key={run.id} run={run} actions={<OpenMenu path={run.cwd} runId={run.id} />} />;
}

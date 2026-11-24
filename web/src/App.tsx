import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { Rail } from './components/Rail';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsDialog, useShortcuts } from './components/Shortcuts';
import { NewIntentDialog } from './components/NewIntentDialog';
import { IssuesPage } from './components/issues/IssuesPage';
import { PullsPage } from './components/pulls/PullsPage';
import { ReposPage } from './components/ReposPage';
import { RunContent } from './components/RunContent';
import { SpecsPage } from './components/spec/SpecsPage';
import { Workspace } from './components/Workspace';
import { ProgressOverlay } from './components/Progress';
import { Toasts } from './components/Toasts';
import { useAttention } from './attention';
import { activeRun, useStore } from './store';
import { send } from './ws';

export function App(): ReactElement {
    const page = useStore((s) => s.page);
    const run = useStore(activeRun);
    const view = useStore((s) => (run ? s.views[run.id] : undefined));
    const connected = useStore((s) => s.connected);
    useShortcuts();
    useAttention();

    // Un onglet affiché pour la première fois (ou après reconnexion) est rejoué depuis le serveur.
    useEffect(() => {
        if (page === 'chat' && run && connected && !view?.loaded) send({ type: 'replay', runId: run.id });
    }, [page, run, connected, view?.loaded]);

    let content: ReactElement;
    if (page === 'repos') content = <ReposPage />;
    else if (page === 'pulls') content = <PullsPage />;
    else if (page === 'specs') content = <SpecsPage />;
    else if (page === 'issues' || !run) content = <IssuesPage />;
    else content = <RunContent run={run} />;

    return (
        <div className="app">
            <Rail />
            <main className="main" id="main">
                <Workspace main={content} />
            </main>
            <CommandPalette />
            <ShortcutsDialog />
            <NewIntentDialog />
            <ProgressOverlay />
            {!connected && <div className="banner">Serveur injoignable, reconnexion…</div>}
            <Toasts />
        </div>
    );
}

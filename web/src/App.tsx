import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Tabs } from './components/Tabs';
import { ChatView } from './components/chat/ChatView';
import { ImplementView } from './components/implement/ImplementView';
import { IssuesPage } from './components/issues/IssuesPage';
import { PrView } from './components/pulls/PrView';
import { PullsPage } from './components/pulls/PullsPage';
import { ReposPage } from './components/ReposPage';
import { SpecsPage } from './components/spec/SpecsPage';
import { SpecView } from './components/spec/SpecView';
import { api } from './api';
import { MergeBaseButton, MergeIntegrationButton } from './components/MergeIntegration';
import { ProgressOverlay } from './components/Progress';
import { activeRun, useStore } from './store';
import { send } from './ws';

export function App(): ReactElement {
    const page = useStore((s) => s.page);
    const run = useStore(activeRun);
    const view = useStore((s) => (run ? s.views[run.id] : undefined));
    const connected = useStore((s) => s.connected);
    const notices = useStore((s) => s.notices);
    const dismiss = useStore((s) => s.dismissNotice);

    // Un onglet affiché pour la première fois (ou après reconnexion) est rejoué depuis le serveur.
    useEffect(() => {
        if (page === 'chat' && run && connected && !view?.loaded) send({ type: 'replay', runId: run.id });
    }, [page, run, connected, view?.loaded]);

    let content: ReactElement;
    if (page === 'repos') content = <ReposPage />;
    else if (page === 'pulls') content = <PullsPage />;
    else if (page === 'specs') content = <SpecsPage />;
    else if (page === 'issues' || !run) content = <IssuesPage />;
    else if (run.type === 'implement' || run.type === 'merge') content = <ImplementView run={run} />;
    else if (run.type === 'spec') content = <SpecView run={run} />;
    else if (run.type === 'pr') content = <PrView run={run} />;
    else if (run.repoId !== null && (run.issueNumber !== null || run.prNumber !== null)) {
        // Chat lié à une issue (ou une PR) : merge de master dans sa branche, et de sa branche dans develop.
        const what = run.issueNumber !== null ? `la branche de l'issue #${run.issueNumber}` : `la branche de la PR #${run.prNumber}`;
        const toolbar = (
            <>
                <MergeBaseButton repoId={run.repoId} base={run.baseBranch} what={what} start={() => api.mergeBase(run.id)} />
                <MergeIntegrationButton repoId={run.repoId} what={what} start={() => api.mergeIntegration(run.id)} />
            </>
        );
        content = <ChatView run={run} toolbar={toolbar} />;
    } else content = <ChatView run={run} />;

    return (
        <div className="app">
            <Sidebar />
            <div className="main">
                <Tabs />
                {content}
            </div>
            <ProgressOverlay />
            {!connected && <div className="banner">Serveur injoignable, reconnexion…</div>}
            {notices.length > 0 && (
                <div className="notices">
                    {notices.map((n) => (
                        <div key={n.id} className="notice" onClick={() => dismiss(n.id)}>
                            {n.runId !== undefined ? `#${n.runId} · ` : ''}
                            {n.message}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

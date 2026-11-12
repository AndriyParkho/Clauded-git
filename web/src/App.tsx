import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Tabs } from './components/Tabs';
import { ChatView } from './components/chat/ChatView';
import { ImplementView } from './components/implement/ImplementView';
import { IssuesPage } from './components/issues/IssuesPage';
import { ReposPage } from './components/ReposPage';
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
    else if (page === 'issues' || !run) content = <IssuesPage />;
    else if (run.type === 'implement' || run.type === 'merge') content = <ImplementView run={run} />;
    else content = <ChatView run={run} />;

    return (
        <div className="app">
            <Sidebar />
            <div className="main">
                <Tabs />
                {content}
            </div>
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

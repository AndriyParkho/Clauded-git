import type { ReactElement, ReactNode } from 'react';
import { useCallback } from 'react';
import { AskCard } from './AskCard';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { StatusBar } from './StatusBar';
import { useStore } from '../../store';
import { send } from '../../ws';
import type { Run } from '../../../../shared/protocol';

interface Props {
    run: Run;
    /** Boutons ajoutés dans l'en-tête (onglet d'implémentation). */
    toolbar?: ReactNode;
    /** Panneau latéral (issue, diff, sortie de commande, PR). */
    panel?: ReactNode;
    subtitle?: ReactNode;
}

export function ChatView({ run, toolbar, panel, subtitle }: Props): ReactElement {
    const view = useStore((s) => s.views[run.id]);
    const repo = useStore((s) => s.repos.find((r) => r.id === run.repoId));
    const draft = useStore((s) => s.drafts[run.id]);
    const setDraft = useStore((s) => s.setDraft);
    const consumeDraft = useCallback(() => setDraft(run.id, undefined), [run.id, setDraft]);

    return (
        <div className="chat">
            <div className="chat-head">
                <div className="chat-head-row">
                    <span className="chat-title">{run.title}</span>
                    <span className="muted mono" title={run.cwd}>
                        {repo?.owner ? `${repo.owner}/${repo.name}` : ''} {run.cwd.replace(/^\/Users\/[^/]+/, '~')}
                    </span>
                    {subtitle}
                </div>
                {toolbar && <div className="toolbar">{toolbar}</div>}
            </div>
            <div className="chat-body">
                <div className="chat-main">
                    {view ? <MessageList view={view} /> : <div className="messages-wrap muted pad">chargement…</div>}
                    {view?.asks.map((ask) => (
                        <AskCard key={ask.id} ask={ask} />
                    ))}
                    <Composer
                        commands={view?.commands ?? []}
                        running={run.state === 'running'}
                        draft={draft}
                        onDraftConsumed={consumeDraft}
                        onSend={(text) => send({ type: 'prompt', runId: run.id, text })}
                        onStop={() => send({ type: 'interrupt', runId: run.id })}
                    />
                    <StatusBar run={run} models={view?.models ?? []} permissions={view?.permissions.length ?? 0} usage={view?.usage} />
                </div>
                {panel && <aside className="panel">{panel}</aside>}
            </div>
        </div>
    );
}

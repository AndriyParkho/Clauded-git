import type { ReactElement, ReactNode } from 'react';
import { useCallback } from 'react';
import { ArtifactsBar } from './ArtifactsBar';
import { AskCard } from './AskCard';
import { Composer } from './Composer';
import { GithubLinks } from './GithubLinks';
import { McpDialog } from './McpCard';
import { MessageList } from './MessageList';
import { QuoteSelection, QuoteStack, withQuotes } from './QuoteSelection';
import { StatusBar } from './StatusBar';
import { TasksStrip } from './TasksStrip';
import { useStore } from '../../store';
import { send } from '../../ws';
import type { Quote, Run } from '../../../../shared/protocol';

// Référence stable pour le sélecteur zustand.
const NO_QUOTES: Quote[] = [];

interface Props {
    run: Run;
    /** Boutons ajoutés dans l'en-tête (onglet d'implémentation). */
    toolbar?: ReactNode;
    /** Panneau latéral (issue, diff, sortie de commande, PR). */
    panel?: ReactNode;
    subtitle?: ReactNode;
    /** Panneau élargi (diff de review). */
    wide?: boolean;
}

export function ChatView({ run, toolbar, panel, subtitle, wide }: Props): ReactElement {
    const view = useStore((s) => s.views[run.id]);
    const repo = useStore((s) => s.repos.find((r) => r.id === run.repoId));
    const draft = useStore((s) => s.drafts[run.id]);
    const setDraft = useStore((s) => s.setDraft);
    const consumeDraft = useCallback(() => setDraft(run.id, undefined), [run.id, setDraft]);
    const quotes = useStore((s) => s.quotes[run.id] ?? NO_QUOTES);
    const clearQuotes = useStore((s) => s.clearQuotes);

    return (
        <div className="chat">
            <div className="chat-head">
                <div className="chat-head-row">
                    <span className="chat-title">{run.title}</span>
                    <span className="muted mono" title={run.cwd}>
                        {repo?.owner ? `${repo.owner}/${repo.name}` : ''} {run.cwd.replace(/^\/Users\/[^/]+/, '~')}
                    </span>
                    {subtitle}
                    <GithubLinks run={run} />
                </div>
                {toolbar && <div className="toolbar">{toolbar}</div>}
                <ArtifactsBar run={run} />
            </div>
            <div className="chat-body">
                <div className="chat-main">
                    <QuoteSelection runId={run.id} className="quote-zone">
                        {view ? <MessageList view={view} /> : <div className="messages-wrap muted pad">chargement…</div>}
                    </QuoteSelection>
                    {view?.asks.map((ask) => (
                        <AskCard key={ask.id} ask={ask} />
                    ))}
                    <TasksStrip run={run} />
                    <QuoteStack runId={run.id} />
                    <Composer
                        runId={run.id}
                        commands={view?.commands ?? []}
                        running={run.state === 'running'}
                        draft={draft}
                        onDraftConsumed={consumeDraft}
                        hasQuotes={quotes.length > 0}
                        onSend={(text, images) => {
                            // `/mcp` ouvre la fenêtre des serveurs MCP ; il n'est pas envoyé à la conversation.
                            if (text.trim() === '/mcp' && images.length === 0 && quotes.length === 0) return send({ type: 'mcp', runId: run.id, action: 'status' });
                            send({ type: 'prompt', runId: run.id, text: withQuotes(quotes, text), ...(images.length ? { images } : {}) });
                            clearQuotes(run.id);
                        }}
                        onStop={() => send({ type: 'interrupt', runId: run.id })}
                    />
                    <StatusBar run={run} models={view?.models ?? []} permissions={view?.permissions.length ?? 0} usage={view?.usage} />
                </div>
                {panel && <aside className={`panel ${wide ? 'wide' : ''}`}>{panel}</aside>}
            </div>
            {view?.mcp && <McpDialog status={view.mcp} />}
        </div>
    );
}

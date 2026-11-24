import type { ReactElement, ReactNode } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ArtifactsBar } from './ArtifactsBar';
import { AskCard } from './AskCard';
import { Composer } from './Composer';
import { GithubLinks } from './GithubLinks';
import { McpDialog } from './McpCard';
import { MemoryDialog } from './MemoryDialog';
import { MessageList } from './MessageList';
import { QuoteSelection, QuoteStack, withQuotes } from './QuoteSelection';
import { StatusBar } from './StatusBar';
import { TasksStrip } from './TasksStrip';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { IntentBadge, intentClass, runIcon, repoLabel } from '../Tabs';
import { ResizeHandle, useSize } from '../ResizeHandle';
import { send } from '../../ws';
import type { Quote, Run, SlashCommandInfo } from '../../../../shared/protocol';

// Référence stable pour le sélecteur zustand.
const NO_QUOTES: Quote[] = [];

/** Commandes gérées par l'app (le SDK ne les expose pas) : proposées dans l'autocomplétion. */
const APP_COMMANDS: SlashCommandInfo[] = [
    { name: 'mcp', description: 'Serveurs MCP : état, outils, reconnexion', argumentHint: '' },
    { name: 'memory', description: 'Fichiers de mémoire (CLAUDE.md, mémoire automatique) : voir, ouvrir, créer', argumentHint: '' },
];

interface Props {
    run: Run;
    /** Sélecteur des panneaux latéraux (Issue, Diff, Logs…), au centre de l'en-tête. */
    views?: ReactNode;
    /** Menus et action principale, à droite de l'en-tête. */
    actions?: ReactNode;
    /** Panneau latéral (issue, diff, sortie de commande, PR). */
    panel?: ReactNode;
    subtitle?: ReactNode;
    /** Panneau élargi (diff de review). */
    wide?: boolean;
}

export function ChatView({ run, views, actions, panel, subtitle, wide }: Props): ReactElement {
    const view = useStore((s) => s.views[run.id]);
    const repo = useStore((s) => s.repos.find((r) => r.id === run.repoId));
    const draft = useStore((s) => s.drafts[run.id]);
    const setDraft = useStore((s) => s.setDraft);
    const consumeDraft = useCallback(() => setDraft(run.id, undefined), [run.id, setDraft]);
    const quotes = useStore((s) => s.quotes[run.id] ?? NO_QUOTES);
    const clearQuotes = useStore((s) => s.clearQuotes);
    // Largeur du panneau latéral, réglée à la poignée ; une pour les panneaux larges (diff, review).
    const panelKey = wide ? 'panel-wide' : 'panel';
    const panelWidth = useSize(panelKey);
    const body = useRef<HTMLDivElement>(null);
    const [memoryOpen, setMemoryOpen] = useState(false);
    const sdkCommands = view?.commands;
    const commands = useMemo(() => [...APP_COMMANDS.filter((c) => !sdkCommands?.some((s) => s.name === c.name)), ...(sdkCommands ?? [])], [sdkCommands]);
    const aside = useRef<HTMLElement>(null);

    return (
        <div className="chat">
            <header className="chat-head">
                <div className="chat-head-main">
                    <div className="chat-heading">
                        <h1 className={`chat-title ${intentClass(run)}`}>
                            <Icon name={runIcon(run)} size={16} />
                            <span>{run.title}</span>
                            <IntentBadge run={run} />
                        </h1>
                        <div className="chat-sub">
                            <span className="chat-repo" title={run.cwd}>
                                {repo ? repoLabel(repo) : run.cwd.replace(/^\/Users\/[^/]+/, '~')}
                            </span>
                            {subtitle}
                            <GithubLinks run={run} />
                        </div>
                    </div>
                    {views && <div className="chat-views">{views}</div>}
                    {actions && <div className="chat-actions">{actions}</div>}
                </div>
                <ArtifactsBar run={run} />
            </header>
            <div className="chat-body" ref={body}>
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
                        commands={commands}
                        running={run.state === 'running'}
                        draft={draft}
                        onDraftConsumed={consumeDraft}
                        hasQuotes={quotes.length > 0}
                        onSend={(text, images) => {
                            // `/mcp` ouvre la fenêtre des serveurs MCP ; il n'est pas envoyé à la conversation.
                            if (text.trim() === '/mcp' && images.length === 0 && quotes.length === 0) return send({ type: 'mcp', runId: run.id, action: 'status' });
                            // `/memory` : menu du terminal, absent du SDK ; l'app ouvre sa propre fenêtre.
                            if (text.trim() === '/memory' && images.length === 0 && quotes.length === 0) return setMemoryOpen(true);
                            send({ type: 'prompt', runId: run.id, text: withQuotes(quotes, text), ...(images.length ? { images } : {}) });
                            clearQuotes(run.id);
                        }}
                        onStop={() => send({ type: 'interrupt', runId: run.id })}
                    />
                    <StatusBar run={run} models={view?.models ?? []} permissions={view?.permissions.length ?? 0} usage={view?.usage} />
                </div>
                {panel && (
                    <aside ref={aside} className={`panel ${wide ? 'wide' : ''}`} style={panelWidth === undefined ? undefined : { width: panelWidth }}>
                        <ResizeHandle
                            sizeKey={panelKey}
                            current={() => aside.current?.offsetWidth ?? 480}
                            min={280}
                            max={() => (body.current?.offsetWidth ?? 1200) - 320}
                            direction={-1}
                            label="Largeur du panneau"
                            className="edge-left"
                        />
                        {panel}
                    </aside>
                )}
            </div>
            {view?.mcp && <McpDialog status={view.mcp} />}
            {memoryOpen && <MemoryDialog runId={run.id} onClose={() => setMemoryOpen(false)} />}
        </div>
    );
}

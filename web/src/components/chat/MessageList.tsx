import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '../Markdown';
import { buildItems, type Item } from './items';
import { ToolCard } from './ToolCard';
import type { RunView } from '../../store';

const USER_PREVIEW_CHARS = 280;
const USER_PREVIEW_LINES = 4;

/** Message utilisateur replié après envoi, comme dans Claude Code : un clic pour tout voir. */
function UserBubble({ text }: { text: string }): ReactElement {
    const [open, setOpen] = useState(false);
    const lines = text.split('\n');
    const long = text.length > USER_PREVIEW_CHARS || lines.length > USER_PREVIEW_LINES;
    const preview = long ? `${lines.slice(0, USER_PREVIEW_LINES).join('\n').slice(0, USER_PREVIEW_CHARS)}…` : text;
    return (
        <div className={`msg user ${long ? 'collapsible' : ''}`} onClick={() => long && setOpen(!open)} title={long ? (open ? 'Replier' : 'Déplier') : undefined}>
            <pre className="user-text">{open ? text : preview}</pre>
            {long && <span className="user-toggle">{open ? 'replier' : 'voir tout'}</span>}
        </div>
    );
}

export function ItemView({ item }: { item: Item }): ReactElement | null {
    switch (item.kind) {
        case 'user':
            return <UserBubble text={item.text} />;
        case 'system-note':
            return (
                <details className="system-note">
                    <summary>{item.title}</summary>
                    <pre>{item.text}</pre>
                </details>
            );
        case 'local':
            return <div className="meta local">↳ {item.text}</div>;
        case 'text':
            return (
                <div className="msg assistant">
                    <Markdown text={item.text} />
                </div>
            );
        case 'thinking':
            return (
                <details className="thinking">
                    <summary>réflexion</summary>
                    <pre>{item.text}</pre>
                </details>
            );
        case 'tool':
            return <ToolCard tool={item} />;
        case 'init':
            return (
                <div className="meta" title={item.mcp.join('\n')}>
                    session · {item.model} · Claude Code {item.version} · {item.commands} commandes · {item.skills} skills
                </div>
            );
        case 'compact':
            return (
                <div className="meta">
                    contexte compacté · {item.preTokens.toLocaleString('fr-FR')} → {item.postTokens?.toLocaleString('fr-FR') ?? '?'} tokens
                </div>
            );
        case 'result':
            return (
                <div className={`meta ${item.subtype === 'success' ? '' : 'error'}`}>
                    {item.subtype === 'success' ? 'tour terminé' : item.subtype} · {(item.durationMs / 1000).toFixed(1)} s · {item.numTurns} tours · {item.costUsd.toFixed(3)} $
                    {item.errors.length > 0 && <pre>{item.errors.join('\n')}</pre>}
                </div>
            );
        default:
            return null;
    }
}

export function MessageList({ view }: { view: RunView }): ReactElement {
    const items = useMemo(() => buildItems(view.messages), [view.messages]);
    const container = useRef<HTMLDivElement>(null);
    const [atBottom, setAtBottom] = useState(true);

    const onScroll = (): void => {
        const el = container.current;
        if (!el) return;
        setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    };

    const scrollToBottom = (): void => {
        const el = container.current;
        if (el) el.scrollTop = el.scrollHeight;
        setAtBottom(true);
    };

    // Suit le fil tant qu'on est en bas ; sinon on laisse l'utilisateur lire.
    useEffect(() => {
        const el = container.current;
        if (el && atBottom) el.scrollTop = el.scrollHeight;
    }, [items, view.partial, view.partialTool, view.asks.length, atBottom]);

    return (
        <div className="messages-wrap">
            <div className="messages" ref={container} onScroll={onScroll}>
                {!view.loaded && items.length === 0 && <div className="muted pad">chargement de la session…</div>}
                {items.map((item) => (
                    <ItemView key={item.key} item={item} />
                ))}
                {view.partial && (
                    <div className="msg assistant streaming">
                        <Markdown text={view.partial} />
                    </div>
                )}
                {view.partialTool && <div className="meta">appel de {view.partialTool}…</div>}
            </div>
            {!atBottom && (
                <button className="scroll-down" onClick={scrollToBottom} title="Aller en bas">
                    ↓
                </button>
            )}
        </div>
    );
}

import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import type { Quote } from '../../../../shared/protocol';

interface Picked {
    text: string;
    top: number;
    left: number;
}

/** Texte sélectionné dans `container`, nettoyé ; `undefined` si la sélection est vide ou ailleurs. */
function selectionIn(container: HTMLElement): Picked | undefined {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return undefined;
    const text = selection
        .toString()
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (!text) return undefined;
    const rect = range.getBoundingClientRect();
    return { text, top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)) };
}

interface Props {
    runId: number;
    /** Origine affichée avec la citation (`SPEC.md`) ; absent pour le fil du chat. */
    source?: string;
    /** Propose « Commenter… » en plus de « Citer » (annotations de la spec). */
    comment?: boolean;
    className?: string;
    children: ReactNode;
}

/**
 * Sélectionner un passage dans la zone fait apparaître « Citer » (et « Commenter… ») : le passage
 * rejoint la pile au-dessus de la saisie et part avec le message suivant.
 */
export function QuoteSelection({ runId, source, comment, className, children }: Props): ReactElement {
    const addQuote = useStore((s) => s.addQuote);
    const container = useRef<HTMLDivElement>(null);
    const [picked, setPicked] = useState<Picked | undefined>();
    const [writing, setWriting] = useState(false);
    const [note, setNote] = useState('');

    useEffect(() => {
        if (!picked || writing) return;
        // La sélection disparaît (clic ailleurs) : le bouton aussi.
        const onChange = (): void => {
            if (!container.current || !selectionIn(container.current)) setPicked(undefined);
        };
        document.addEventListener('selectionchange', onChange);
        return () => document.removeEventListener('selectionchange', onChange);
    }, [picked, writing]);

    const onMouseUp = (): void => {
        if (writing) return;
        // Après le mouseup, la sélection est à jour.
        setTimeout(() => setPicked(container.current ? selectionIn(container.current) : undefined), 0);
    };

    const close = (): void => {
        setPicked(undefined);
        setWriting(false);
        setNote('');
    };

    const add = (withComment?: string): void => {
        if (!picked) return;
        const quote: Omit<Quote, 'id'> = { text: picked.text, ...(source ? { source } : {}), ...(withComment?.trim() ? { comment: withComment.trim() } : {}) };
        addQuote(runId, quote);
        window.getSelection()?.removeAllRanges();
        close();
    };

    return (
        <div ref={container} className={className} onMouseUp={onMouseUp}>
            {children}
            {picked && (
                <div className="quote-popover" style={{ top: picked.top, left: picked.left }} onMouseDown={(e) => !writing && e.preventDefault()}>
                    {writing ? (
                        <div className="quote-comment">
                            <textarea
                                autoFocus
                                rows={3}
                                value={note}
                                placeholder="Ton commentaire sur ce passage (Entrée pour l'ajouter)"
                                onChange={(e) => setNote(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        add(note);
                                    }
                                    if (e.key === 'Escape') close();
                                }}
                            />
                            <div className="quote-comment-actions">
                                <button className="small" onClick={close}>
                                    Annuler
                                </button>
                                <button className="small primary" disabled={!note.trim()} onClick={() => add(note)}>
                                    Ajouter
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            {comment && (
                                <button className="small primary" onClick={() => setWriting(true)}>
                                    Commenter…
                                </button>
                            )}
                            <button className={`small ${comment ? '' : 'primary'}`} onClick={() => add()} title="Ajoute le passage au-dessus de la saisie ; il part avec ton prochain message">
                                Citer
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

/** Message envoyé : les citations (avec leurs commentaires) puis le texte saisi. */
export function withQuotes(quotes: Quote[], text: string): string {
    if (quotes.length === 0) return text;
    const blocks = quotes.map((q) => {
        const quoted = q.text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n');
        const head = q.source ? `Sur ce passage de \`${q.source}\` :\n` : '';
        return `${head}${quoted}${q.comment ? `\n\n${q.comment}` : ''}`;
    });
    return [...blocks, text].filter(Boolean).join('\n\n---\n\n');
}

/** Pile des passages cités, au-dessus de la saisie. */
export function QuoteStack({ runId }: { runId: number }): ReactElement | null {
    const quotes = useStore((s) => s.quotes[runId]);
    const removeQuote = useStore((s) => s.removeQuote);
    const clearQuotes = useStore((s) => s.clearQuotes);
    if (!quotes?.length) return null;
    return (
        <div className="quote-stack">
            {quotes.map((q) => (
                <div key={q.id} className="quote-item">
                    <div className="quote-text">
                        {q.source && <span className="muted mono">{q.source} · </span>}
                        {q.text.length > 220 ? `${q.text.slice(0, 220)}…` : q.text}
                    </div>
                    {q.comment && <div className="quote-note">{q.comment}</div>}
                    <button className="link quote-remove" onClick={() => removeQuote(runId, q.id)} title="Retirer">
                        ×
                    </button>
                </div>
            ))}
            {quotes.length > 1 && (
                <button className="link small-link" onClick={() => clearQuotes(runId)}>
                    tout retirer
                </button>
            )}
        </div>
    );
}

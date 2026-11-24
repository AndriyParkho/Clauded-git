import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import type { Quote } from '../../../../shared/protocol';

interface Picked {
    text: string;
    range: Range;
    /** Position de la fenêtre : sous la sélection, ou au-dessus quand la place manque en bas. */
    top?: number;
    bottom?: number;
    left: number;
}

const POPOVER_WIDTH = 380;
const POPOVER_HEIGHT = 150;

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
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8));
    const below = rect.bottom + 8 + POPOVER_HEIGHT < window.innerHeight;
    return { text, range: range.cloneRange(), left, ...(below ? { top: rect.bottom + 8 } : { bottom: window.innerHeight - rect.top + 8 }) };
}

/**
 * Garde le passage surligné pendant qu'on tape la réponse (le focus dans le champ efface la
 * sélection du navigateur). API CSS Custom Highlight, ignorée si le navigateur ne l'a pas.
 */
function highlight(range: Range | undefined): void {
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const Ctor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!registry || !Ctor) return;
    if (range) registry.set('quote-reply', new Ctor(range));
    else registry.delete('quote-reply');
}

interface Props {
    runId: number;
    /** Origine affichée avec la citation (`SPEC.md`) ; absent pour le fil du chat. */
    source?: string;
    /** Texte du champ de réponse. */
    placeholder?: string;
    className?: string;
    children: ReactNode;
}

/**
 * Comme dans l'app Claude : sélectionner un passage ouvre une petite fenêtre avec le passage cité et
 * un champ de réponse. Entrée (ou « + ») ajoute la citation, avec ce qui est tapé, à la pile au-dessus
 * de la saisie ; elle part avec le prochain message, et le focus revient dans la saisie pour l'écrire.
 */
export function QuoteSelection({ runId, source, placeholder = 'Répondre à Claude', className, children }: Props): ReactElement {
    const addQuote = useStore((s) => s.addQuote);
    const container = useRef<HTMLDivElement>(null);
    const popover = useRef<HTMLDivElement>(null);
    const field = useRef<HTMLTextAreaElement>(null);
    const [picked, setPicked] = useState<Picked | undefined>();
    const [reply, setReply] = useState('');

    const close = (): void => {
        setPicked(undefined);
        setReply('');
        highlight(undefined);
    };

    useEffect(() => {
        if (!picked) return;
        highlight(picked.range);
        // Un clic ailleurs ferme la fenêtre (un clic dans la zone en ouvre une nouvelle au relâchement).
        const onDown = (event: MouseEvent): void => {
            if (!popover.current?.contains(event.target as Node)) close();
        };
        // Le champ ne prend pas le focus d'office : la sélection reste, ⌘C la copie. La première lettre
        // tapée y bascule (et s'y écrit) ; Échap ferme.
        const onKey = (event: KeyboardEvent): void => {
            if (document.activeElement === field.current) return;
            if (event.key === 'Escape') close();
            else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) field.current?.focus();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [picked]);

    useEffect(() => () => highlight(undefined), []);

    const onMouseUp = (): void => {
        // Après le mouseup, la sélection est à jour.
        setTimeout(() => {
            const next = container.current ? selectionIn(container.current) : undefined;
            if (next) {
                setReply('');
                setPicked(next);
            }
        }, 0);
    };

    const quote = (comment: string): Omit<Quote, 'id'> => ({ text: picked?.text ?? '', ...(source ? { source } : {}), ...(comment.trim() ? { comment: comment.trim() } : {}) });

    const keep = (): void => {
        if (!picked) return;
        addQuote(runId, quote(reply));
        window.getSelection()?.removeAllRanges();
        close();
        // On continue dans la saisie du chat : la citation part avec le message qu'on y écrit.
        // Celle du même onglet : avec plusieurs volets ouverts, il y a une saisie par volet.
        const chat = container.current?.closest('.chat') ?? document;
        setTimeout(() => chat.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 0);
    };

    return (
        <div ref={container} className={className} onMouseUp={onMouseUp}>
            {children}
            {picked && (
                <div ref={popover} className="quote-popover" style={{ left: picked.left, ...(picked.top !== undefined ? { top: picked.top } : { bottom: picked.bottom }) }}>
                    <div className="quote-popover-text">{picked.text}</div>
                    <div className="quote-popover-row">
                        <textarea
                            ref={field}
                            rows={1}
                            value={reply}
                            placeholder={placeholder}
                            onChange={(e) => setReply(e.target.value)}
                            onCopy={(e) => {
                                // ⌘C dans le champ sans rien y sélectionner : copie le passage cité.
                                if (e.currentTarget.selectionStart !== e.currentTarget.selectionEnd || !picked) return;
                                e.preventDefault();
                                e.clipboardData.setData('text/plain', picked.text);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    keep();
                                }
                                if (e.key === 'Escape') close();
                            }}
                        />
                        <button className="quote-keep" onClick={keep} title="Ajouter la citation (et ce que tu as tapé) au-dessus de la saisie, pour l'envoyer avec ton prochain message (Entrée)">
                            +
                        </button>
                    </div>
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

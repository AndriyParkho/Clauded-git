import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SlashCommandInfo } from '../../../../shared/protocol';

interface Props {
    commands: SlashCommandInfo[];
    running: boolean;
    /** Texte à placer dans la saisie (une fois), par exemple le contexte d'une issue. */
    draft?: string | undefined;
    onDraftConsumed?: () => void;
    onSend: (text: string) => void;
    onStop: () => void;
}

export function Composer({ commands, running, draft, onDraftConsumed, onSend, onStop }: Props): ReactElement {
    const [text, setText] = useState('');
    const [cursor, setCursor] = useState(0);
    const area = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (draft === undefined) return;
        setText(draft);
        onDraftConsumed?.();
        const el = area.current;
        if (el) {
            el.focus();
            // Le curseur va à la fin de la première ligne : c'est là qu'on écrit sa question.
            const end = draft.indexOf('\n');
            el.setSelectionRange(end < 0 ? draft.length : end, end < 0 ? draft.length : end);
        }
    }, [draft, onDraftConsumed]);

    // Autocomplétion des commandes slash tant que la première ligne n'a pas d'espace.
    const query = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : undefined;
    const suggestions = useMemo(() => (query === undefined ? [] : commands.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 12)), [commands, query]);

    useEffect(() => setCursor(0), [query]);

    useEffect(() => {
        const el = area.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
    }, [text]);

    const accept = (command: SlashCommandInfo): void => {
        setText(`/${command.name} `);
        area.current?.focus();
    };

    const submit = (): void => {
        const value = text.trim();
        if (!value) return;
        onSend(value);
        setText('');
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if (suggestions.length > 0) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((cursor + 1) % suggestions.length);
                return;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((cursor - 1 + suggestions.length) % suggestions.length);
                return;
            }
            if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && text !== `/${suggestions[cursor]?.name}`)) {
                event.preventDefault();
                const chosen = suggestions[cursor];
                if (chosen) accept(chosen);
                return;
            }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
        }
    };

    return (
        <div className="composer">
            {suggestions.length > 0 && (
                <div className="suggestions">
                    {suggestions.map((command, i) => (
                        <button key={command.name} className={i === cursor ? 'selected' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => accept(command)}>
                            <span className="mono">/{command.name}</span>
                            <span className="muted">
                                {command.argumentHint ? `${command.argumentHint} · ` : ''}
                                {command.description}
                            </span>
                        </button>
                    ))}
                </div>
            )}
            <div className="composer-row">
                <textarea ref={area} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} placeholder="Message pour Claude… (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne, / pour les commandes)" rows={2} />
                {running ? (
                    <button className="danger" onClick={onStop} title="Interrompre Claude">
                        Stop
                    </button>
                ) : (
                    <button className="primary" onClick={submit} disabled={!text.trim()}>
                        Envoyer
                    </button>
                )}
            </div>
        </div>
    );
}

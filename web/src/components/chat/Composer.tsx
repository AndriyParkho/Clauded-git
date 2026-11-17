import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { imageFiles, toAttachment } from '../../images';
import { useStore } from '../../store';
import type { ImageAttachment, SlashCommandInfo } from '../../../../shared/protocol';

interface Props {
    commands: SlashCommandInfo[];
    running: boolean;
    /** Texte à placer dans la saisie (une fois), par exemple le contexte d'une issue. */
    draft?: string | undefined;
    onDraftConsumed?: () => void;
    /** Des passages cités attendent : on peut envoyer sans rien taper. */
    hasQuotes?: boolean;
    onSend: (text: string, images: ImageAttachment[]) => void;
    onStop: () => void;
}

export function Composer({ commands, running, draft, onDraftConsumed, hasQuotes, onSend, onStop }: Props): ReactElement {
    const [text, setText] = useState('');
    const [images, setImages] = useState<ImageAttachment[]>([]);
    const [dragging, setDragging] = useState(false);
    const [cursor, setCursor] = useState(0);
    const area = useRef<HTMLTextAreaElement>(null);
    const picker = useRef<HTMLInputElement>(null);
    const notify = useStore((s) => s.notify);

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

    /** Ajoute des fichiers image (collés, glissés ou choisis) aux pièces jointes du prochain message. */
    const attach = async (files: File[]): Promise<void> => {
        for (const file of files) {
            try {
                const attachment = await toAttachment(file);
                setImages((current) => [...current, attachment]);
            } catch (error) {
                notify(`Image ignorée : ${String(error instanceof Error ? error.message : error)}`);
            }
        }
        area.current?.focus();
    };

    const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
        const files = imageFiles(event.clipboardData);
        if (files.length === 0) return;
        event.preventDefault();
        void attach(files);
    };

    const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
        event.preventDefault();
        setDragging(false);
        void attach(imageFiles(event.dataTransfer));
    };

    const accept = (command: SlashCommandInfo): void => {
        setText(`/${command.name} `);
        area.current?.focus();
    };

    const submit = (): void => {
        const value = text.trim();
        if (!value && images.length === 0 && !hasQuotes) return;
        onSend(value, images);
        setText('');
        setImages([]);
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

    const canSend = Boolean(text.trim()) || images.length > 0 || Boolean(hasQuotes);

    return (
        <div
            className={`composer ${dragging ? 'dragging' : ''}`}
            onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
        >
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
            {images.length > 0 && (
                <div className="attachments">
                    {images.map((image, i) => (
                        <span key={i} className="attachment" title={image.name ?? `image ${i + 1}`}>
                            <img src={`data:${image.mediaType};base64,${image.data}`} alt="" />
                            <button className="attachment-remove" onClick={() => setImages(images.filter((_, j) => j !== i))} title="Retirer">
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            )}
            <div className="composer-row">
                <button className="attach" onClick={() => picker.current?.click()} title="Joindre une image (ou colle-la / glisse-la dans la saisie)">
                    📎
                </button>
                <input
                    ref={picker}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => {
                        void attach(Array.from(e.target.files ?? []));
                        e.target.value = '';
                    }}
                />
                <textarea
                    ref={area}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    placeholder="Message pour Claude… (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne, / pour les commandes, ⌘V pour coller une image)"
                    rows={2}
                />
                {running ? (
                    <button className="danger" onClick={onStop} title="Interrompre Claude">
                        Stop
                    </button>
                ) : (
                    <button className="primary" onClick={submit} disabled={!canSend}>
                        Envoyer
                    </button>
                )}
            </div>
        </div>
    );
}

import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { reviewKey, useStore } from '../../store';
import { DiffBrowser, DiffSummary, type Anchor } from '../DiffView';
import { Markdown } from '../Markdown';
import { timeAgo } from '../issues/IssueBody';
import { send } from '../../ws';
import { isCommentable, parseDiff, type DiffFile } from '../../../../shared/diff';
import type { DraftLabel, ReviewDraft, ReviewEvent, ReviewState } from '../../../../shared/protocol';

const LABELS: DraftLabel[] = ['bloquant', 'à corriger', 'détail', 'question'];
const EVENTS: Array<{ value: ReviewEvent; label: string }> = [
    { value: 'PENDING', label: 'En attente sur GitHub (tu soumets là-bas)' },
    { value: 'COMMENT', label: 'Commenter' },
    { value: 'APPROVE', label: 'Approuver' },
    { value: 'REQUEST_CHANGES', label: 'Demander des changements' },
];

/** Lignes du diff que vise un brouillon (avec leur préfixe `+`/`-`/` `), pour le citer dans le chat. */
function codeOf(files: DiffFile[], draft: ReviewDraft): string {
    const file = files.find((f) => f.path === draft.path);
    if (!file) return '';
    const from = draft.startLine ?? draft.line;
    const lines = file.hunks
        .flatMap((h) => h.lines)
        .filter((l) => {
            const n = draft.side === 'LEFT' ? l.oldLine : l.newLine;
            return n !== null && n >= from && n <= draft.line;
        });
    return lines
        .slice(0, 40)
        .map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`)
        .join('\n');
}

/** Message envoyé au chat pour discuter d'un brouillon : où il est, le code, le commentaire, la question. */
export function discussDraftPrompt(draft: ReviewDraft, code: string, question: string): string {
    const where = `\`${draft.path}\` ${draft.side === 'LEFT' ? 'ancienne ' : ''}L${draft.startLine !== null ? `${draft.startLine}-` : ''}${draft.line}`;
    return [
        `À propos du brouillon de commentaire de review sur ${where}${draft.label ? ` (${draft.label})` : ''}, écrit par ${draft.source === 'claude' ? 'toi' : 'moi'} :`,
        '',
        ...(code ? ['```diff', code, '```', ''] : []),
        draft.body
            .trim()
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        '',
        question.trim(),
        '',
        "Si on doit le changer, propose le nouveau texte du commentaire tel qu'il serait publié ; je mettrai le brouillon à jour.",
    ].join('\n');
}

const labelClass = (label: DraftLabel | null): string => (label ? `draft-label label-${LABELS.indexOf(label)}` : 'draft-label');

function LabelSelect({ value, onChange }: { value: DraftLabel | null; onChange: (label: DraftLabel | null) => void }): ReactElement {
    return (
        <select className="small-select" value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as DraftLabel | null)}>
            <option value="">sans label</option>
            {LABELS.map((label) => (
                <option key={label} value={label}>
                    {label}
                </option>
            ))}
        </select>
    );
}

interface DraftCardProps {
    draft: ReviewDraft;
    outside: boolean;
    onSave: (patch: Partial<Pick<ReviewDraft, 'body' | 'label'>>) => Promise<void>;
    onDelete: () => Promise<void>;
    /** Envoie une question sur ce brouillon au chat de l'onglet (absent : pas de chat). */
    onDiscuss?: ((question: string) => void) | undefined;
}

function DraftCard({ draft, outside, onSave, onDelete, onDiscuss }: DraftCardProps): ReactElement {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(draft.body);
    const [discussing, setDiscussing] = useState(false);
    const [question, setQuestion] = useState('');
    const [sent, setSent] = useState(false);

    const discuss = (): void => {
        if (!onDiscuss || !question.trim()) return;
        onDiscuss(question);
        setQuestion('');
        setDiscussing(false);
        setSent(true);
    };
    useEffect(() => setText(draft.body), [draft.body]);

    const save = async (): Promise<void> => {
        if (text !== draft.body) await onSave({ body: text });
        setEditing(false);
    };

    return (
        <div className={`draft ${outside ? 'outside' : ''}`}>
            <div className="draft-head">
                <span className={labelClass(draft.label)}>{draft.label ?? 'sans label'}</span>
                <span className="muted">
                    {draft.source === 'claude' ? 'Claude' : 'moi'} · {draft.side === 'LEFT' ? 'ancienne ' : ''}L{draft.startLine !== null ? `${draft.startLine}-` : ''}
                    {draft.line}
                </span>
                {outside && <span className="warn">hors diff : ira dans le corps de la review</span>}
                <span className="spacer" />
                {sent && !discussing && <span className="muted">envoyé au chat ✓</span>}
                {onDiscuss && !discussing && (
                    <button className="small" onClick={() => setDiscussing(true)} title="Poser une question sur ce commentaire dans le chat de la PR">
                        discuter
                    </button>
                )}
                <LabelSelect value={draft.label} onChange={(label) => void onSave({ label })} />
                {!editing && (
                    <button className="small" onClick={() => setEditing(true)}>
                        modifier
                    </button>
                )}
                <button className="small danger" onClick={() => void onDelete()} title="Supprimer ce brouillon">
                    ×
                </button>
            </div>
            {editing ? (
                <div className="draft-edit">
                    <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(14, Math.max(3, text.split('\n').length + 1))} autoFocus />
                    <div className="draft-actions">
                        <button className="small primary" onClick={() => void save()}>
                            Enregistrer
                        </button>
                        <button
                            className="small"
                            onClick={() => {
                                setText(draft.body);
                                setEditing(false);
                            }}
                        >
                            Annuler
                        </button>
                    </div>
                </div>
            ) : (
                <div className="draft-body" onDoubleClick={() => setEditing(true)}>
                    {draft.body.trim() ? <Markdown text={draft.body} /> : <span className="muted">(vide)</span>}
                </div>
            )}
            {discussing && (
                <div className="draft-discuss">
                    <textarea
                        autoFocus
                        rows={2}
                        value={question}
                        placeholder="Ta question ou ta remarque sur ce commentaire (Entrée pour envoyer au chat)"
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                discuss();
                            }
                            if (e.key === 'Escape') setDiscussing(false);
                        }}
                    />
                    <div className="draft-actions">
                        <button className="small primary" disabled={!question.trim()} onClick={discuss} title="Envoie au chat le commentaire, les lignes de code visées et ta question">
                            Envoyer au chat
                        </button>
                        <button className="small" onClick={() => setDiscussing(false)}>
                            Annuler
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function NewDraft({ anchor, onAdd, onCancel }: { anchor: Anchor; onAdd: (body: string, label: DraftLabel | null) => Promise<void>; onCancel: () => void }): ReactElement {
    const [text, setText] = useState('');
    const [label, setLabel] = useState<DraftLabel | null>(null);
    return (
        <div className="draft new">
            <div className="draft-head">
                <span className="muted">
                    Nouveau commentaire · {anchor.side === 'LEFT' ? 'ancienne ' : ''}L{anchor.line}
                </span>
                <span className="spacer" />
                <LabelSelect value={label} onChange={setLabel} />
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus placeholder="Commentaire (markdown, ```suggestion accepté)" />
            <div className="draft-actions">
                <button className="small primary" disabled={!text.trim()} onClick={() => void onAdd(text, label)}>
                    Ajouter
                </button>
                <button className="small" onClick={onCancel}>
                    Annuler
                </button>
            </div>
        </div>
    );
}

/**
 * Review d'une PR : le diff tel que GitHub le montre, les brouillons sous leur ligne (écrits par la
 * session de review ou à la main), le verdict et la publication en un seul appel.
 */
export function ReviewPanel({ repoId, prNumber, runId }: { repoId: number; prNumber: number; runId?: number }): ReactElement {
    const review = useStore((s) => s.reviews[reviewKey(repoId, prNumber)]);
    const setReview = useStore((s) => s.setReview);
    const notify = useStore((s) => s.notify);
    const [patch, setPatch] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [adding, setAdding] = useState<Anchor | null>(null);
    const [publishing, setPublishing] = useState(false);
    const [body, setBody] = useState('');

    const loadDiff = useCallback(() => {
        setError(undefined);
        api.pullDiff(repoId, prNumber)
            .then((r) => setPatch(r.patch))
            .catch((e: unknown) => setError(String(e)));
    }, [repoId, prNumber]);

    useEffect(() => {
        loadDiff();
        api.review(repoId, prNumber)
            .then(setReview)
            .catch((e: unknown) => notify(String(e), runId));
    }, [repoId, prNumber, runId, loadDiff, setReview, notify]);

    useEffect(() => setBody(review?.body ?? ''), [review?.body]);

    const files = useMemo(() => (patch ? parseDiff(patch) : []), [patch]);

    const act = async (action: () => Promise<ReviewState>): Promise<void> => {
        try {
            setReview(await action());
        } catch (e) {
            notify(String(e), runId);
        }
    };

    const publish = async (): Promise<void> => {
        if (!review) return;
        const verdict = EVENTS.find((e) => e.value === review.event)?.label ?? review.event;
        const count = review.drafts.length;
        if (!window.confirm(`Publier sur GitHub ${count} commentaire${count > 1 ? 's' : ''} ?\nVerdict : ${verdict}`)) return;
        setPublishing(true);
        try {
            setReview(await api.publishReview(repoId, prNumber));
        } catch (e) {
            notify(String(e), runId);
        } finally {
            setPublishing(false);
        }
    };

    if (error) return <div className="error pad">{error}</div>;
    if (!patch || !review) return <div className="muted pad">chargement du diff…</div>;

    const outside = review.drafts.filter((d) => !isCommentable(files, d.path, d.side, d.line));
    const counts = LABELS.map((label) => ({ label, n: review.drafts.filter((d) => d.label === label).length })).filter((c) => c.n > 0);

    const renderDraft = (draft: ReviewDraft, isOutside = false): ReactElement => (
        <DraftCard
            key={draft.id}
            draft={draft}
            outside={isOutside}
            onSave={(change) => act(() => api.patchDraft(repoId, prNumber, draft.id, change))}
            onDelete={() => act(() => api.deleteDraft(repoId, prNumber, draft.id))}
            onDiscuss={runId === undefined ? undefined : (question) => send({ type: 'prompt', runId, text: discussDraftPrompt(draft, codeOf(files, draft), question) })}
        />
    );
    const renderNew = (anchor: Anchor): ReactElement => (
        <NewDraft
            key="new"
            anchor={anchor}
            onCancel={() => setAdding(null)}
            onAdd={async (text, label) => {
                await act(() => api.addDraft(repoId, prNumber, { path: anchor.path, line: anchor.line, startLine: null, side: anchor.side, body: text, label }));
                setAdding(null);
            }}
        />
    );

    return (
        <div className="review">
            <div className="review-head">
                <div className="review-row-top">
                    <select value={review.event} onChange={(e) => void act(() => api.patchReview(repoId, prNumber, { event: e.target.value as ReviewEvent }))}>
                        {EVENTS.map((e) => (
                            <option key={e.value} value={e.value}>
                                {e.label}
                            </option>
                        ))}
                    </select>
                    <button className="primary" disabled={publishing || (review.drafts.length === 0 && !review.body.trim() && review.event === 'PENDING')} onClick={() => void publish()}>
                        {publishing ? 'Publication…' : `Publier (${review.drafts.length})`}
                    </button>
                    <button className="small" onClick={loadDiff} title="Recharger le diff de la PR">
                        ↻
                    </button>
                </div>
                <DiffSummary files={files} />
                <div className="review-counts muted">
                    {review.drafts.length === 0 ? (
                        review.importedAt ? (
                            'aucun brouillon'
                        ) : (
                            'Pas encore de brouillons : lance la review, ou clique sur un numéro de ligne pour commenter.'
                        )
                    ) : (
                        <>
                            {counts.map((c) => (
                                <span key={c.label} className={labelClass(c.label)}>
                                    {c.n} {c.label}
                                </span>
                            ))}
                            {review.importedAt && <span>· review de Claude importée {timeAgo(review.importedAt)}</span>}
                        </>
                    )}
                    {review.publishedAt && (
                        <span>
                            {' '}
                            · publiée {timeAgo(review.publishedAt)}
                            {review.publishedUrl && (
                                <>
                                    {' '}
                                    <a href={review.publishedUrl} target="_blank" rel="noreferrer">
                                        voir sur GitHub ↗
                                    </a>
                                </>
                            )}
                        </span>
                    )}
                </div>
                <textarea
                    className="review-body"
                    placeholder="Corps de la review (facultatif)"
                    value={body}
                    rows={body ? 3 : 1}
                    onChange={(e) => setBody(e.target.value)}
                    onBlur={() => body !== review.body && void act(() => api.patchReview(repoId, prNumber, { body }))}
                />
            </div>
            <DiffBrowser
                files={files}
                review={{ drafts: review.drafts, adding, onAdd: setAdding, renderDraft: (d) => renderDraft(d), renderNew }}
                before={
                    outside.length > 0 && (
                        <div className="review-outside">
                            <div className="sidebar-section">Hors diff ({outside.length})</div>
                            {outside.map((d) => renderDraft(d, true))}
                        </div>
                    )
                }
            />
        </div>
    );
}

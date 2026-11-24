import '../styles/diff.css';
import type { ReactElement, ReactNode } from 'react';
import { createContext, Fragment, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, DiffHunk } from '../../../shared/diff';
import type { DraftSide, ReviewDraft } from '../../../shared/protocol';
import { ResizeHandle, useSize } from './ResizeHandle';
import { useHighlight, type Highlighted } from './diffHighlight';

/** Au-delà, un fichier est replié par défaut (sauf s'il porte des brouillons). */
const LARGE_FILE_LINES = 400;

/** Une ligne du diff où ancrer un commentaire. */
export type Anchor = { path: string; side: DraftSide; line: number };

/** Ce qu'il faut pour commenter le diff (review d'une PR) ; sans, le diff est en lecture seule. */
export interface DiffDrafts {
    drafts: ReviewDraft[];
    adding: Anchor | null;
    onAdd: (anchor: Anchor) => void;
    renderDraft: (draft: ReviewDraft) => ReactElement;
    renderNew: (anchor: Anchor) => ReactElement;
}

/** `unified` : une colonne ; `split` : ancienne version à gauche, nouvelle à droite. */
export type DiffMode = 'unified' | 'split';

const NO_DRAFTS: ReviewDraft[] = [];

// ---------------------------------------------------------------------------------------------
// Ce qu'on calcule une fois par fichier (stats, largeur des numéros, empreinte du contenu)
// ---------------------------------------------------------------------------------------------

interface FileInfo {
    lines: number;
    added: number;
    removed: number;
    maxLine: number;
    hunkCount: number;
    /** Chemin + hash du patch du fichier : change dès que son contenu change. */
    key: string;
}

const infos = new WeakMap<DiffFile, FileInfo>();

function fileInfo(file: DiffFile): FileInfo {
    let info = infos.get(file);
    if (info) return info;
    let lines = 0;
    let added = 0;
    let removed = 0;
    let maxLine = 0;
    // FNV-1a 32 bits : suffit pour reconnaître « le même patch », pas un hash cryptographique.
    let hash = 0x811c9dc5;
    const mix = (text: string): void => {
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
    };
    mix(`${file.status}\0${file.oldPath ?? ''}\0${file.binary ? 1 : 0}\0`);
    for (const hunk of file.hunks) {
        mix(hunk.header);
        for (const line of hunk.lines) {
            lines++;
            if (line.kind === 'add') added++;
            else if (line.kind === 'del') removed++;
            maxLine = Math.max(maxLine, line.oldLine ?? 0, line.newLine ?? 0);
            mix(line.kind === 'add' ? '\n+' : line.kind === 'del' ? '\n-' : '\n ');
            mix(line.text);
        }
    }
    info = { lines, added, removed, maxLine, hunkCount: file.hunks.length, key: `${file.path}#${(hash >>> 0).toString(36)}` };
    infos.set(file, info);
    return info;
}

export function fileStats(file: DiffFile): { lines: number; added: number; removed: number } {
    const { lines, added, removed } = fileInfo(file);
    return { lines, added, removed };
}

/** `+12 −3`, sans le côté vide. */
export function Counts({ added, removed }: { added: number; removed: number }): ReactElement {
    return (
        <span className="diff-counts">
            {added > 0 && <span className="add-count">+{added}</span>}
            {removed > 0 && <span className="del-count">−{removed}</span>}
        </span>
    );
}

/** En-tête de hunk : la position en discret, le contexte (fonction, section) lisible. */
function HunkHeader({ header }: { header: string }): ReactElement {
    const match = header.match(/^(@@ [^@]+ @@)\s*(.*)$/);
    return (
        <>
            <span className="diff-hunk-range">{match?.[1] ?? header}</span>
            {match?.[2] && <span className="diff-hunk-context">{match[2]}</span>}
        </>
    );
}

const STATUS: Record<string, string> = { added: 'nouveau', deleted: 'supprimé', renamed: 'renommé' };

/** Brouillons d'un fichier rangés par ligne (`RIGHT:12`, `LEFT:7`), dans l'ordre de la review. */
function indexDrafts(drafts: ReviewDraft[], path: string): Map<string, ReviewDraft[]> {
    const index = new Map<string, ReviewDraft[]>();
    for (const draft of drafts) {
        if (draft.path !== path) continue;
        const key = `${draft.side}:${draft.line}`;
        const list = index.get(key);
        if (list) list.push(draft);
        else index.set(key, [draft]);
    }
    return index;
}

/** Côte à côte : une rangée = une ligne ancienne et/ou une ligne nouvelle (indices dans le hunk). */
interface SplitRow {
    left: number | null;
    right: number | null;
}

/** Apparie les lignes d'un hunk : le contexte face à lui-même, chaque bloc de suppressions face aux ajouts qui suivent. */
function pairLines(hunk: DiffHunk): SplitRow[] {
    const rows: SplitRow[] = [];
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
        if (lines[i]!.kind === 'ctx') {
            rows.push({ left: i, right: i });
            i++;
            continue;
        }
        const dels: number[] = [];
        const adds: number[] = [];
        while (i < lines.length && lines[i]!.kind !== 'ctx') {
            (lines[i]!.kind === 'del' ? dels : adds).push(i);
            i++;
        }
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
    return rows;
}

/** Cellule de code : le HTML du coloriseur s'il est prêt (texte déjà échappé par lui), sinon le texte brut. */
function codeCell(className: string, text: string, html: string | undefined): ReactElement {
    return html ? <td className={className} dangerouslySetInnerHTML={{ __html: html }} /> : <td className={className}>{text || ' '}</td>;
}

interface BodyProps {
    file: DiffFile;
    review: DiffDrafts | undefined;
    /** Ligne de ce fichier en cours de commentaire (remplace `review.adding`). */
    adding: Anchor | null;
    mode: DiffMode;
}

/** Le tableau d'un fichier ouvert, unifié ou côte à côte ; monté seulement à l'ouverture. */
const FileBody = memo(function FileBody({ file, review, adding, mode }: BodyProps): ReactElement {
    const info = fileInfo(file);
    const highlighted: Highlighted | null = useHighlight(file, info.key);
    const allDrafts = review?.drafts;
    const drafts = useMemo(() => (allDrafts ? indexDrafts(allDrafts, file.path) : null), [allDrafts, file.path]);
    const split = useMemo(() => (mode === 'split' ? file.hunks.map(pairLines) : null), [file, mode]);

    if (file.binary) return <div className="muted pad">fichier binaire</div>;
    if (file.hunks.length === 0) return <div className="muted pad">pas de contenu (fichier vide ou renommé sans changement)</div>;

    // Largeur des colonnes de numéros selon le plus grand numéro du fichier.
    const numWidth = `${String(info.maxLine).length + 2}ch`;
    const at = (side: DraftSide, line: number | null): ReviewDraft[] => (line === null ? NO_DRAFTS : (drafts?.get(`${side}:${line}`) ?? NO_DRAFTS));
    const isAdding = (side: DraftSide, line: number | null): boolean => line !== null && adding !== null && adding.path === file.path && adding.side === side && adding.line === line;
    const commentAt = (side: DraftSide, line: number | null): (() => void) | undefined => (review && line !== null ? () => review.onAdd({ path: file.path, side, line }) : undefined);
    const numCell = (className: string, line: number | null, comment: (() => void) | undefined): ReactElement => (
        <td className={`diff-num ${className} ${comment ? 'clickable' : ''}`} onClick={comment} title={comment ? 'Commenter cette ligne' : undefined}>
            {line ?? ''}
        </td>
    );
    // Sous la ligne : ses brouillons (côté ancien puis nouveau), et le formulaire si on la commente.
    const draftsRow = (oldLine: number | null, newLine: number | null, colSpan: number): ReactElement | null => {
        if (!review) return null;
        const here = [...at('LEFT', oldLine), ...at('RIGHT', newLine)];
        const writing = isAdding('LEFT', oldLine) || isAdding('RIGHT', newLine);
        if (here.length === 0 && !writing) return null;
        return (
            <tr className="diff-drafts">
                <td colSpan={colSpan}>
                    {here.map((d) => review.renderDraft(d))}
                    {writing && adding && review.renderNew(adding)}
                </td>
            </tr>
        );
    };

    if (split) {
        return (
            <table className="diff-table diff-split">
                <colgroup>
                    <col style={{ width: numWidth }} />
                    <col style={{ width: '2ch' }} />
                    <col />
                    <col style={{ width: numWidth }} />
                    <col style={{ width: '2ch' }} />
                    <col />
                </colgroup>
                <tbody>
                    {file.hunks.map((hunk, h) => (
                        <Fragment key={h}>
                            <tr className="diff-hunk">
                                <td colSpan={6}>
                                    <HunkHeader header={hunk.header} />
                                </td>
                            </tr>
                            {split[h]!.map((row, r) => {
                                const left = row.left === null ? null : hunk.lines[row.left]!;
                                const right = row.right === null ? null : hunk.lines[row.right]!;
                                const leftLine = left?.oldLine ?? null;
                                const rightLine = right?.newLine ?? null;
                                const leftKind = left?.kind ?? 'empty';
                                const rightKind = right?.kind ?? 'empty';
                                return (
                                    <Fragment key={r}>
                                        <tr className="diff-line split">
                                            {numCell(leftKind, leftLine, commentAt('LEFT', leftLine))}
                                            <td className={`diff-sign ${leftKind}`}>{leftKind === 'del' ? '−' : ''}</td>
                                            {left ? codeCell(`diff-code ${leftKind}`, left.text, highlighted?.[h]?.[row.left!]) : <td className="diff-code empty" />}
                                            {numCell(`${rightKind} diff-num-right`, rightLine, commentAt('RIGHT', rightLine))}
                                            <td className={`diff-sign ${rightKind}`}>{rightKind === 'add' ? '+' : ''}</td>
                                            {right ? codeCell(`diff-code ${rightKind}`, right.text, highlighted?.[h]?.[row.right!]) : <td className="diff-code empty" />}
                                        </tr>
                                        {draftsRow(leftLine, rightLine, 6)}
                                    </Fragment>
                                );
                            })}
                        </Fragment>
                    ))}
                </tbody>
            </table>
        );
    }

    return (
        <table className="diff-table">
            <colgroup>
                <col style={{ width: numWidth }} />
                <col style={{ width: numWidth }} />
                <col style={{ width: '2ch' }} />
                <col />
            </colgroup>
            <tbody>
                {file.hunks.map((hunk, h) => (
                    <Fragment key={h}>
                        <tr className="diff-hunk">
                            <td colSpan={4}>
                                <HunkHeader header={hunk.header} />
                            </td>
                        </tr>
                        {hunk.lines.map((line, i) => {
                            // Suppression : commentée côté ancien ; ajout et contexte : côté nouveau.
                            const side: DraftSide = line.newLine !== null ? 'RIGHT' : 'LEFT';
                            const number = side === 'RIGHT' ? line.newLine : line.oldLine;
                            const comment = commentAt(side, number);
                            return (
                                <Fragment key={i}>
                                    <tr className={`diff-line ${line.kind}`}>
                                        {numCell('', line.oldLine, side === 'LEFT' ? comment : undefined)}
                                        {numCell('', line.newLine, side === 'RIGHT' ? comment : undefined)}
                                        <td className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</td>
                                        {codeCell('diff-code', line.text, highlighted?.[h]?.[i])}
                                    </tr>
                                    {draftsRow(line.oldLine, line.newLine, 4)}
                                </Fragment>
                            );
                        })}
                    </Fragment>
                ))}
            </tbody>
        </table>
    );
});

// ---------------------------------------------------------------------------------------------
// Rendu paresseux : dans le navigateur de diff, un fichier ouvert ne monte son tableau qu'à
// l'approche de la zone visible (une fois monté, il le reste).
// ---------------------------------------------------------------------------------------------

type Observe = (el: Element, onNear: () => void) => () => void;

/** `undefined` : hors du navigateur, rendu immédiat ; `null` : observateur pas encore prêt. */
const LazyContext = createContext<Observe | null | undefined>(undefined);

/** Hauteur approximative d'un fichier pas encore monté (12 px × 1,55 par ligne, plus les en-têtes de hunk). */
function placeholderHeight(info: FileInfo): number {
    return Math.min(info.lines * 18.6 + info.hunkCount * 27, 200_000);
}

interface FileDiffProps {
    file: DiffFile;
    review?: DiffDrafts;
    /** Change à chaque clic dans l'arbre des fichiers : déplie le fichier. */
    reveal?: number;
    mode?: DiffMode;
    /** Fichier marqué « vu » (case dans l'en-tête, présente si `onSeen` est fourni). */
    seen?: boolean;
    onSeen?: (file: DiffFile, seen: boolean) => void;
    /** Ligne en cours de commentaire, si elle est dans ce fichier ; à défaut, `review.adding`. */
    adding?: Anchor | null;
}

/** Un fichier du diff, façon GitHub : numéros ancien / nouveau, signe, code ; brouillons sous leur ligne. */
export const FileDiff = memo(function FileDiff({ file, review, reveal, mode = 'unified', seen = false, onSeen, adding }: FileDiffProps): ReactElement {
    const allDrafts = review?.drafts;
    const draftCount = useMemo(() => allDrafts?.filter((d) => d.path === file.path).length ?? 0, [allDrafts, file.path]);
    const info = fileInfo(file);
    const [open, setOpen] = useState(() => !seen && (info.lines <= LARGE_FILE_LINES || draftCount > 0));
    // Un nouveau brouillon sur le fichier le déplie.
    const lastCount = useRef(draftCount);
    useEffect(() => {
        if (draftCount > lastCount.current) setOpen(true);
        lastCount.current = draftCount;
    }, [draftCount]);

    const lazy = useContext(LazyContext);
    const [near, setNear] = useState(lazy === undefined);
    useEffect(() => {
        if (reveal) {
            setOpen(true);
            setNear(true);
        }
    }, [reveal]);
    const box = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (near || !open || !lazy || !box.current) return;
        return lazy(box.current, () => setNear(true));
    }, [near, open, lazy]);

    // Marqué vu : se replie ; redevenu non vu (décoché, ou contenu modifié depuis) : se déplie.
    const wasSeen = useRef(seen);
    useEffect(() => {
        if (wasSeen.current !== seen) setOpen(!seen);
        wasSeen.current = seen;
    }, [seen]);

    const slash = file.path.lastIndexOf('/');
    return (
        <div ref={box} className={`diff-file ${seen ? 'seen' : ''}`} data-path={file.path}>
            <div className="diff-file-head">
                <button className="diff-file-toggle" onClick={() => setOpen(!open)} title={file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                    <span className="diff-chevron">{open ? '▾' : '▸'}</span>
                    <span className="mono diff-file-path">
                        {file.status === 'renamed' && file.oldPath && <span className="diff-file-dir">{file.oldPath} → </span>}
                        {slash >= 0 && <span className="diff-file-dir">{file.path.slice(0, slash + 1)}</span>}
                        <span className="diff-file-name">{file.path.slice(slash + 1)}</span>
                    </span>
                    {STATUS[file.status] && <span className={`diff-status ${file.status}`}>{STATUS[file.status]}</span>}
                    {draftCount > 0 && <span className="draft-count">{draftCount} 💬</span>}
                    <Counts added={info.added} removed={info.removed} />
                </button>
                {onSeen && (
                    <label className="diff-seen" title={seen ? 'Marquer comme non vu' : 'Marquer comme vu : le fichier se replie'}>
                        <input type="checkbox" checked={seen} onChange={(e) => onSeen(file, e.target.checked)} />
                        vu
                    </label>
                )}
            </div>
            {open && (near ? <FileBody file={file} review={review} adding={adding !== undefined ? adding : (review?.adding ?? null)} mode={mode} /> : <div className="diff-placeholder" style={{ height: placeholderHeight(info) }} />)}
        </div>
    );
});

/** Résumé d'un diff : nombre de fichiers et de lignes. */
export function DiffSummary({ files }: { files: DiffFile[] }): ReactElement {
    const total = files.reduce(
        (acc, f) => {
            const s = fileInfo(f);
            return { added: acc.added + s.added, removed: acc.removed + s.removed };
        },
        { added: 0, removed: 0 },
    );
    return (
        <span className="diff-summary muted">
            {files.length} fichier{files.length > 1 ? 's' : ''} <Counts added={total.added} removed={total.removed} />
        </span>
    );
}

// ---------------------------------------------------------------------------------------------
// Arbre des fichiers modifiés, à côté du diff (comme sur GitHub)
// ---------------------------------------------------------------------------------------------

interface TreeDir {
    name: string;
    path: string;
    dirs: TreeDir[];
    files: DiffFile[];
}

/** Arbre des dossiers ; une chaîne de dossiers à enfant unique est fusionnée (`src/components`). */
function buildTree(files: DiffFile[]): TreeDir {
    const root: TreeDir = { name: '', path: '', dirs: [], files: [] };
    const dirs = new Map<string, TreeDir>();
    for (const file of files) {
        const parts = file.path.split('/');
        let dir = root;
        for (const part of parts.slice(0, -1)) {
            const path = dir.path ? `${dir.path}/${part}` : part;
            let next = dirs.get(path);
            if (!next) {
                next = { name: part, path, dirs: [], files: [] };
                dirs.set(path, next);
                dir.dirs.push(next);
            }
            dir = next;
        }
        dir.files.push(file);
    }
    const compact = (dir: TreeDir): TreeDir => {
        let current = dir;
        while (current !== root && current.files.length === 0 && current.dirs.length === 1) {
            const only = current.dirs[0]!;
            current = { ...only, name: `${current.name}/${only.name}` };
        }
        return { ...current, dirs: current.dirs.map(compact).sort((a, b) => a.name.localeCompare(b.name)), files: [...current.files].sort((a, b) => a.path.localeCompare(b.path)) };
    };
    return compact(root);
}

const STATUS_MARK: Record<DiffFile['status'], { mark: string; title: string }> = {
    added: { mark: 'A', title: 'nouveau' },
    deleted: { mark: 'D', title: 'supprimé' },
    renamed: { mark: 'R', title: 'renommé' },
    modified: { mark: 'M', title: 'modifié' },
};

interface TreeProps {
    active: string | null;
    collapsed: Set<string>;
    /** Nombre de brouillons par chemin. */
    comments: Map<string, number>;
    seen: Set<string>;
    onToggle: (path: string) => void;
    onPick: (path: string) => void;
}

function TreeLevel({ dir, depth, ...props }: TreeProps & { dir: TreeDir; depth: number }): ReactElement {
    const pad = (extra: number): { paddingLeft: string } => ({ paddingLeft: `${8 + depth * 12 + extra}px` });
    return (
        <>
            {dir.dirs.map((sub) => {
                const closed = props.collapsed.has(sub.path);
                return (
                    <Fragment key={sub.path}>
                        <button className="tree-row tree-dir" style={pad(0)} onClick={() => props.onToggle(sub.path)} title={sub.path}>
                            <span className="tree-chevron">{closed ? '▸' : '▾'}</span>
                            <span className="tree-name">{sub.name}</span>
                        </button>
                        {!closed && <TreeLevel {...props} dir={sub} depth={depth + 1} />}
                    </Fragment>
                );
            })}
            {dir.files.map((file) => {
                const { added, removed } = fileInfo(file);
                const comments = props.comments.get(file.path) ?? 0;
                const status = STATUS_MARK[file.status];
                const seen = props.seen.has(file.path);
                return (
                    <button
                        key={file.path}
                        className={`tree-row tree-file ${props.active === file.path ? 'active' : ''} ${seen ? 'seen' : ''}`}
                        style={pad(14)}
                        onClick={() => props.onPick(file.path)}
                        title={`${file.path} (${status.title}${seen ? ', vu' : ''})`}
                    >
                        <span className={`tree-status ${file.status}`}>{status.mark}</span>
                        <span className="tree-name">{file.path.slice(file.path.lastIndexOf('/') + 1)}</span>
                        {comments > 0 && <span className="tree-comments">{comments}</span>}
                        {seen && <span className="tree-seen">✓</span>}
                        <Counts added={added} removed={removed} />
                    </button>
                );
            })}
        </>
    );
}

// ---------------------------------------------------------------------------------------------
// Préférences gardées dans le navigateur
// ---------------------------------------------------------------------------------------------

const TREE_KEY = 'clauded.diffTree';
const MODE_KEY = 'clauded.diffMode';
const SEEN_KEY = 'clauded.diffSeen';
/** Fichiers « vus » retenus au plus (les plus anciens partent d'abord). */
const SEEN_MAX = 1000;

function readTreeOpen(): boolean {
    try {
        return localStorage.getItem(TREE_KEY) !== 'closed';
    } catch {
        return true;
    }
}

function readMode(): DiffMode {
    try {
        return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified';
    } catch {
        return 'unified';
    }
}

function store(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // stockage indisponible ou plein : l'état ne sera pas retenu
    }
}

/** Fichiers vus : clé de contenu (`chemin#hash`) → date du marquage. */
type SeenMap = Record<string, number>;

function readSeen(): SeenMap {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
        const out: SeenMap = {};
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [key, at] of Object.entries(raw)) if (typeof at === 'number') out[key] = at;
        }
        return out;
    } catch {
        return {};
    }
}

function writeSeen(map: SeenMap): SeenMap {
    let entries = Object.entries(map);
    if (entries.length > SEEN_MAX) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX);
    const kept = Object.fromEntries(entries);
    store(SEEN_KEY, JSON.stringify(kept));
    return kept;
}

/**
 * Garde les mêmes objets `DiffFile` d'un rendu à l'autre quand leur contenu n'a pas changé (le diff
 * est parfois reparsé à chaque rendu du parent) : stats, coloration et `memo` restent valables.
 */
function useStableFiles(files: DiffFile[]): DiffFile[] {
    const previous = useRef<{ list: DiffFile[]; byKey: Map<string, DiffFile> }>({ list: [], byKey: new Map() });
    return useMemo(() => {
        const prev = previous.current;
        const byKey = new Map<string, DiffFile>();
        const list = files.map((file) => {
            const key = fileInfo(file).key;
            const kept = prev.byKey.get(key) ?? file;
            byKey.set(key, kept);
            return kept;
        });
        const same = list.length === prev.list.length && list.every((f, i) => f === prev.list[i]);
        previous.current = same ? prev : { list, byKey };
        return previous.current.list;
    }, [files]);
}

/**
 * Le diff complet : arbre repliable des fichiers à gauche (filtre, fichier courant surligné, clic
 * pour y aller, fichiers vus atténués), fichiers à droite en unifié ou côte à côte. `before`
 * s'affiche en tête de la liste des fichiers.
 */
export function DiffBrowser({ files: incoming, review, before }: { files: DiffFile[]; review?: DiffDrafts; before?: ReactNode }): ReactElement {
    const files = useStableFiles(incoming);
    const [treeOpen, setTreeOpen] = useState(readTreeOpen);
    const [mode, setMode] = useState(readMode);
    const [seenMap, setSeenMap] = useState(readSeen);
    const [filter, setFilter] = useState('');
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [active, setActive] = useState<string | null>(null);
    const [reveal, setReveal] = useState<{ path: string; n: number } | null>(null);
    const scroller = useRef<HTMLDivElement | null>(null);
    const [scrollBox, setScrollBox] = useState<HTMLDivElement | null>(null);
    const treeBox = useRef<HTMLElement>(null);
    const treeWidth = useSize('diff-tree');

    // Les fichiers ne doivent pas tous se redessiner quand le parent recrée `review` à chaque frappe :
    // l'objet passé ne change qu'avec les brouillons, les rendus passent par la dernière version, et la
    // ligne en cours de commentaire n'est donnée qu'au fichier concerné.
    const latest = useRef(review);
    latest.current = review;
    const hasReview = review !== undefined;
    const reviewDrafts = review?.drafts;
    const reviewAdding = review?.adding ?? null;
    const stableReview = useMemo<DiffDrafts | undefined>(
        () =>
            hasReview
                ? {
                      drafts: reviewDrafts ?? NO_DRAFTS,
                      adding: null,
                      onAdd: (anchor) => latest.current?.onAdd(anchor),
                      renderDraft: (draft) => latest.current!.renderDraft(draft),
                      renderNew: (anchor) => latest.current!.renderNew(anchor),
                  }
                : undefined,
        [hasReview, reviewDrafts],
    );

    const shown = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
    }, [files, filter]);
    const tree = useMemo(() => buildTree(shown), [shown]);
    // Les fichiers à droite suivent l'ordre de l'arbre (dossiers d'abord), comme sur GitHub.
    const ordered = useMemo(() => {
        const out: DiffFile[] = [];
        const walk = (dir: TreeDir): void => {
            dir.dirs.forEach(walk);
            out.push(...dir.files);
        };
        walk(tree);
        return out;
    }, [tree]);
    const comments = useMemo(() => {
        const counts = new Map<string, number>();
        for (const d of reviewDrafts ?? NO_DRAFTS) counts.set(d.path, (counts.get(d.path) ?? 0) + 1);
        return counts;
    }, [reviewDrafts]);
    const seen = useMemo(() => new Set(files.filter((f) => seenMap[fileInfo(f).key] !== undefined).map((f) => f.path)), [files, seenMap]);

    const toggleTree = (): void => {
        const next = !treeOpen;
        setTreeOpen(next);
        store(TREE_KEY, next ? 'open' : 'closed');
    };

    const changeMode = (next: DiffMode): void => {
        setMode(next);
        store(MODE_KEY, next);
    };

    const onSeen = useCallback((file: DiffFile, value: boolean) => {
        const key = fileInfo(file).key;
        setSeenMap((current) => {
            const next = { ...current };
            if (value) next[key] = Date.now();
            else delete next[key];
            return writeSeen(next);
        });
    }, []);

    const toggleDir = (path: string): void =>
        setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });

    const pick = (path: string): void => {
        setActive(path);
        setReveal((r) => ({ path, n: (r?.n ?? 0) + 1 }));
        // Après le dépliage du fichier, pour que sa position soit la bonne. Les fichiers au-dessus,
        // rendus à l'approche, passent de leur hauteur estimée à la vraie : on recale ensuite.
        const align = (): void => {
            const el = scroller.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
            if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - scroller.current.offsetTop - 8 });
        };
        requestAnimationFrame(align);
        for (const delay of [120, 350]) setTimeout(() => requestAnimationFrame(align), delay);
    };

    // Fichier courant : le dernier dont l'en-tête est passé en haut de la zone de défilement (une fois par frame).
    const frame = useRef(0);
    const onScroll = useCallback(() => {
        if (frame.current) return;
        frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            const box = scroller.current;
            if (!box) return;
            const top = box.getBoundingClientRect().top + 24;
            let current: string | null = null;
            for (const el of box.querySelectorAll<HTMLElement>('.diff-file')) {
                if (el.getBoundingClientRect().top <= top) current = el.dataset.path ?? null;
                else break;
            }
            setActive(current);
        });
    }, []);
    useEffect(() => () => cancelAnimationFrame(frame.current), []);

    const setScroller = useCallback((el: HTMLDivElement | null) => {
        scroller.current = el;
        setScrollBox(el);
    }, []);

    // Un seul IntersectionObserver pour tous les fichiers, avec de la marge pour monter avant d'être visible.
    const [observe, setObserve] = useState<Observe | null>(null);
    useEffect(() => {
        if (!scrollBox) return;
        if (typeof IntersectionObserver === 'undefined') {
            setObserve(() => (_el: Element, onNear: () => void) => {
                onNear();
                return () => {};
            });
            return;
        }
        const waiting = new Map<Element, () => void>();
        const io = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const onNear = entry.isIntersecting ? waiting.get(entry.target) : undefined;
                    if (!onNear) continue;
                    waiting.delete(entry.target);
                    io.unobserve(entry.target);
                    onNear();
                }
            },
            { root: scrollBox, rootMargin: '1500px 0px' },
        );
        setObserve(() => (el: Element, onNear: () => void) => {
            waiting.set(el, onNear);
            io.observe(el);
            return () => {
                waiting.delete(el);
                io.unobserve(el);
            };
        });
        return () => io.disconnect();
    }, [scrollBox]);

    const seenCount = seen.size;
    const seenLabel = `${seenCount}/${files.length} vu${seenCount > 1 ? 's' : ''}`;

    return (
        <div className="diff-browser">
            {treeOpen ? (
                <nav ref={treeBox} className="diff-tree" style={treeWidth === undefined ? undefined : { width: treeWidth }}>
                    <ResizeHandle sizeKey="diff-tree" current={() => treeBox.current?.offsetWidth ?? 232} min={160} max={520} direction={1} label="Largeur de la liste des fichiers" className="edge-right" />
                    <div className="diff-tree-head">
                        <span>
                            Fichiers <span className="muted">{shown.length === files.length ? files.length : `${shown.length}/${files.length}`}</span>
                        </span>
                        {files.length > 0 && (
                            <span className={`diff-tree-seen ${seenCount === files.length ? 'done' : ''}`} title="Fichiers marqués comme vus">
                                {seenLabel}
                            </span>
                        )}
                        <span className="spacer" />
                        <button className="small" onClick={toggleTree} title="Replier la liste des fichiers">
                            ◂
                        </button>
                    </div>
                    <input className="diff-tree-filter" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <div className="diff-tree-list">
                        <TreeLevel dir={tree} depth={0} active={active} collapsed={collapsed} comments={comments} seen={seen} onToggle={toggleDir} onPick={pick} />
                        {shown.length === 0 && <div className="muted pad">aucun fichier</div>}
                    </div>
                </nav>
            ) : (
                <button className="diff-tree-rail" onClick={toggleTree} title="Afficher la liste des fichiers">
                    ▸<span>Fichiers ({files.length})</span>
                </button>
            )}
            <div className="diff-main">
                <div className="diff-toolbar">
                    {!treeOpen && files.length > 0 && <span className="muted">{seenLabel}</span>}
                    <span className="spacer" />
                    <div className="segmented" role="group" aria-label="Affichage du diff">
                        <button className={mode === 'unified' ? 'active' : ''} aria-pressed={mode === 'unified'} onClick={() => changeMode('unified')} title="Une seule colonne : suppressions et ajouts à la suite">
                            Unifié
                        </button>
                        <button className={mode === 'split' ? 'active' : ''} aria-pressed={mode === 'split'} onClick={() => changeMode('split')} title="Ancienne version à gauche, nouvelle à droite">
                            Côte à côte
                        </button>
                    </div>
                </div>
                <div className="review-files" ref={setScroller} onScroll={onScroll}>
                    {before}
                    {files.length === 0 && <div className="muted pad">Diff vide.</div>}
                    <LazyContext.Provider value={observe}>
                        {ordered.map((file) => (
                            <FileDiff
                                key={file.path}
                                file={file}
                                mode={mode}
                                seen={seen.has(file.path)}
                                onSeen={onSeen}
                                {...(stableReview ? { review: stableReview, adding: reviewAdding?.path === file.path ? reviewAdding : null } : {})}
                                {...(reveal?.path === file.path ? { reveal: reveal.n } : {})}
                            />
                        ))}
                    </LazyContext.Provider>
                </div>
            </div>
        </div>
    );
}

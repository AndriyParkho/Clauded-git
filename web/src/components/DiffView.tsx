import type { ReactElement, ReactNode } from 'react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, DiffLine } from '../../../shared/diff';
import type { DraftSide, ReviewDraft } from '../../../shared/protocol';
import { ResizeHandle, useSize } from './ResizeHandle';

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

/** Les brouillons ancrés sur cette ligne du diff (côté droit : nouveau numéro ; côté gauche : ancien). */
function draftsAt(drafts: ReviewDraft[], path: string, line: DiffLine): ReviewDraft[] {
    return drafts.filter((d) => d.path === path && ((d.side === 'RIGHT' && line.newLine === d.line) || (d.side === 'LEFT' && line.oldLine === d.line)));
}

export function fileStats(file: DiffFile): { lines: number; added: number; removed: number } {
    let lines = 0;
    let added = 0;
    let removed = 0;
    for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
            lines++;
            if (line.kind === 'add') added++;
            else if (line.kind === 'del') removed++;
        }
    }
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

/** Un fichier du diff, façon GitHub : numéros ancien / nouveau, signe, code ; brouillons sous leur ligne. */
export function FileDiff({ file, review, reveal }: { file: DiffFile; review?: DiffDrafts; /** Change à chaque clic dans l'arbre des fichiers : déplie le fichier. */ reveal?: number }): ReactElement {
    const fileDrafts = review?.drafts.filter((d) => d.path === file.path) ?? [];
    const { lines, added, removed } = fileStats(file);
    const [open, setOpen] = useState(lines <= LARGE_FILE_LINES || fileDrafts.length > 0);
    useEffect(() => {
        if (fileDrafts.length > 0) setOpen(true);
    }, [fileDrafts.length]);
    useEffect(() => {
        if (reveal) setOpen(true);
    }, [reveal]);

    // Largeur des colonnes de numéros selon le plus grand numéro du fichier.
    const maxLine = file.hunks.reduce((max, h) => Math.max(max, ...h.lines.map((l) => Math.max(l.oldLine ?? 0, l.newLine ?? 0))), 0);
    const numWidth = `${String(maxLine).length + 2}ch`;
    const slash = file.path.lastIndexOf('/');

    return (
        <div className="diff-file" data-path={file.path}>
            <button className="diff-file-head" onClick={() => setOpen(!open)} title={file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                <span className="diff-chevron">{open ? '▾' : '▸'}</span>
                <span className="mono diff-file-path">
                    {file.status === 'renamed' && file.oldPath && <span className="diff-file-dir">{file.oldPath} → </span>}
                    {slash >= 0 && <span className="diff-file-dir">{file.path.slice(0, slash + 1)}</span>}
                    <span className="diff-file-name">{file.path.slice(slash + 1)}</span>
                </span>
                {STATUS[file.status] && <span className={`diff-status ${file.status}`}>{STATUS[file.status]}</span>}
                {fileDrafts.length > 0 && <span className="draft-count">{fileDrafts.length} 💬</span>}
                <Counts added={added} removed={removed} />
            </button>
            {open &&
                (file.binary ? (
                    <div className="muted pad">fichier binaire</div>
                ) : file.hunks.length === 0 ? (
                    <div className="muted pad">pas de contenu (fichier vide ou renommé sans changement)</div>
                ) : (
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
                                        const side: DraftSide = line.newLine !== null ? 'RIGHT' : 'LEFT';
                                        const number = (side === 'RIGHT' ? line.newLine : line.oldLine) ?? 0;
                                        const here = review ? draftsAt(review.drafts, file.path, line) : [];
                                        const isAdding = review?.adding != null && review.adding.path === file.path && review.adding.side === side && review.adding.line === number;
                                        const comment = review ? (): void => review.onAdd({ path: file.path, side, line: number }) : undefined;
                                        return (
                                            <Fragment key={i}>
                                                <tr className={`diff-line ${line.kind}`}>
                                                    <td className={`diff-num ${comment ? 'clickable' : ''}`} onClick={line.kind === 'del' ? comment : undefined} title={comment && line.kind === 'del' ? 'Commenter cette ligne' : undefined}>
                                                        {line.oldLine ?? ''}
                                                    </td>
                                                    <td className={`diff-num ${comment ? 'clickable' : ''}`} onClick={line.kind !== 'del' ? comment : undefined} title={comment && line.kind !== 'del' ? 'Commenter cette ligne' : undefined}>
                                                        {line.newLine ?? ''}
                                                    </td>
                                                    <td className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</td>
                                                    <td className="diff-code">{line.text || ' '}</td>
                                                </tr>
                                                {review && (here.length > 0 || isAdding) && (
                                                    <tr className="diff-drafts">
                                                        <td colSpan={4}>
                                                            {here.map(review.renderDraft)}
                                                            {isAdding && review.renderNew({ path: file.path, side, line: number })}
                                                        </td>
                                                    </tr>
                                                )}
                                            </Fragment>
                                        );
                                    })}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                ))}
        </div>
    );
}

/** Résumé d'un diff : nombre de fichiers et de lignes. */
export function DiffSummary({ files }: { files: DiffFile[] }): ReactElement {
    const total = files.reduce((acc, f) => {
        const s = fileStats(f);
        return { added: acc.added + s.added, removed: acc.removed + s.removed };
    }, { added: 0, removed: 0 });
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
    for (const file of files) {
        const parts = file.path.split('/');
        let dir = root;
        for (const part of parts.slice(0, -1)) {
            const path = dir.path ? `${dir.path}/${part}` : part;
            let next = dir.dirs.find((d) => d.path === path);
            if (!next) {
                next = { name: part, path, dirs: [], files: [] };
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
    drafts: ReviewDraft[];
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
                const { added, removed } = fileStats(file);
                const comments = props.drafts.filter((d) => d.path === file.path).length;
                const status = STATUS_MARK[file.status];
                return (
                    <button key={file.path} className={`tree-row tree-file ${props.active === file.path ? 'active' : ''}`} style={pad(14)} onClick={() => props.onPick(file.path)} title={`${file.path} (${status.title})`}>
                        <span className={`tree-status ${file.status}`}>{status.mark}</span>
                        <span className="tree-name">{file.path.slice(file.path.lastIndexOf('/') + 1)}</span>
                        {comments > 0 && <span className="tree-comments">{comments}</span>}
                        <Counts added={added} removed={removed} />
                    </button>
                );
            })}
        </>
    );
}

const TREE_KEY = 'clauded.diffTree';

function readTreeOpen(): boolean {
    try {
        return localStorage.getItem(TREE_KEY) !== 'closed';
    } catch {
        return true;
    }
}

/**
 * Le diff complet : arbre repliable des fichiers à gauche (filtre, fichier courant surligné, clic
 * pour y aller), fichiers à droite. `before` s'affiche en tête de la liste des fichiers.
 */
export function DiffBrowser({ files, review, before }: { files: DiffFile[]; review?: DiffDrafts; before?: ReactNode }): ReactElement {
    const [treeOpen, setTreeOpen] = useState(readTreeOpen);
    const [filter, setFilter] = useState('');
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [active, setActive] = useState<string | null>(null);
    const [reveal, setReveal] = useState<{ path: string; n: number } | null>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const treeBox = useRef<HTMLElement>(null);
    const treeWidth = useSize('diff-tree');

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

    const toggleTree = (): void => {
        const next = !treeOpen;
        setTreeOpen(next);
        try {
            localStorage.setItem(TREE_KEY, next ? 'open' : 'closed');
        } catch {
            // stockage indisponible : l'état ne sera pas retenu
        }
    };

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
        // Après le dépliage du fichier, pour que sa position soit la bonne.
        requestAnimationFrame(() => {
            const el = scroller.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
            if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - scroller.current.offsetTop - 8 });
        });
    };

    // Fichier courant : le dernier dont l'en-tête est passé en haut de la zone de défilement.
    const onScroll = useCallback(() => {
        const box = scroller.current;
        if (!box) return;
        const top = box.getBoundingClientRect().top + 24;
        let current: string | null = null;
        for (const el of box.querySelectorAll<HTMLElement>('.diff-file')) {
            if (el.getBoundingClientRect().top <= top) current = el.dataset.path ?? null;
            else break;
        }
        setActive(current);
    }, []);

    return (
        <div className="diff-browser">
            {treeOpen ? (
                <nav ref={treeBox} className="diff-tree" style={treeWidth === undefined ? undefined : { width: treeWidth }}>
                    <ResizeHandle sizeKey="diff-tree" current={() => treeBox.current?.offsetWidth ?? 232} min={160} max={520} direction={1} label="Largeur de la liste des fichiers" className="edge-right" />
                    <div className="diff-tree-head">
                        <span>
                            Fichiers <span className="muted">{shown.length === files.length ? files.length : `${shown.length}/${files.length}`}</span>
                        </span>
                        <span className="spacer" />
                        <button className="small" onClick={toggleTree} title="Replier la liste des fichiers">
                            ◂
                        </button>
                    </div>
                    <input className="diff-tree-filter" placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <div className="diff-tree-list">
                        <TreeLevel dir={tree} depth={0} active={active} collapsed={collapsed} drafts={review?.drafts ?? []} onToggle={toggleDir} onPick={pick} />
                        {shown.length === 0 && <div className="muted pad">aucun fichier</div>}
                    </div>
                </nav>
            ) : (
                <button className="diff-tree-rail" onClick={toggleTree} title="Afficher la liste des fichiers">
                    ▸<span>Fichiers ({files.length})</span>
                </button>
            )}
            <div className="review-files" ref={scroller} onScroll={onScroll}>
                {before}
                {files.length === 0 && <div className="muted pad">Diff vide.</div>}
                {ordered.map((file) => (
                    <FileDiff key={file.path} file={file} {...(review ? { review } : {})} {...(reveal?.path === file.path ? { reveal: reveal.n } : {})} />
                ))}
            </div>
        </div>
    );
}

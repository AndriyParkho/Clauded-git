/**
 * Lecture d'un diff unifié (`gh pr diff`), partagée par le serveur (lignes commentables avant
 * publication) et l'UI (placement des brouillons sous leur ligne). Pas de dépendance.
 */
import type { DraftSide } from './protocol.js';

export interface DiffLine {
    kind: 'add' | 'del' | 'ctx';
    text: string;
    /** Numéro dans l'ancienne version (côté `LEFT`), `null` pour une ligne ajoutée. */
    oldLine: number | null;
    /** Numéro dans la nouvelle version (côté `RIGHT`), `null` pour une ligne supprimée. */
    newLine: number | null;
}

export interface DiffHunk {
    header: string;
    lines: DiffLine[];
}

export interface DiffFile {
    path: string;
    oldPath: string | null;
    status: 'added' | 'deleted' | 'renamed' | 'modified';
    binary: boolean;
    hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function stripPrefix(path: string): string {
    return path.replace(/^[ab]\//, '');
}

export function parseDiff(patch: string): DiffFile[] {
    const files: DiffFile[] = [];
    let file: DiffFile | undefined;
    let hunk: DiffHunk | undefined;
    let oldLine = 0;
    let newLine = 0;

    for (const raw of patch.split('\n')) {
        if (raw.startsWith('diff --git ')) {
            const match = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
            file = { path: match?.[2] ?? raw.slice(11), oldPath: match?.[1] ?? null, status: 'modified', binary: false, hunks: [] };
            files.push(file);
            hunk = undefined;
            continue;
        }
        if (!file) continue;
        if (!hunk) {
            if (raw.startsWith('new file mode')) file.status = 'added';
            else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
            else if (raw.startsWith('rename from ')) {
                file.status = 'renamed';
                file.oldPath = raw.slice(12);
            } else if (raw.startsWith('rename to ')) file.path = raw.slice(10);
            else if (raw.startsWith('Binary files ')) file.binary = true;
            else if (raw.startsWith('--- ')) {
                if (raw !== '--- /dev/null') file.oldPath = stripPrefix(raw.slice(4));
            } else if (raw.startsWith('+++ ')) {
                if (raw !== '+++ /dev/null') file.path = stripPrefix(raw.slice(4));
            }
        }
        const header = HUNK.exec(raw);
        if (header) {
            oldLine = Number(header[1]);
            newLine = Number(header[2]);
            hunk = { header: raw, lines: [] };
            file.hunks.push(hunk);
            continue;
        }
        if (!hunk) continue;
        if (raw.startsWith('+')) hunk.lines.push({ kind: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ });
        else if (raw.startsWith('-')) hunk.lines.push({ kind: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null });
        else if (raw.startsWith(' ')) hunk.lines.push({ kind: 'ctx', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
        // « \ No newline at end of file » et lignes vides de fin : ignorées.
    }
    return files;
}

/** Une ligne est commentable sur GitHub si elle apparaît dans un hunk, du bon côté. */
export function isCommentable(files: DiffFile[], path: string, side: DraftSide, line: number): boolean {
    const file = files.find((f) => f.path === path);
    if (!file) return false;
    return file.hunks.some((hunk) => hunk.lines.some((l) => (side === 'RIGHT' ? l.newLine === line : l.oldLine === line)));
}

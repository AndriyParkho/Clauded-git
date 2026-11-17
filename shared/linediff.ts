/** Une ligne d'un diff entre deux textes : gardée, retirée (`-`) ou ajoutée (`+`). */
export interface LineChange {
    kind: ' ' | '-' | '+';
    text: string;
    /** Numéro dans l'ancien texte (lignes gardées ou retirées) et dans le nouveau (gardées ou ajoutées). */
    oldLine: number | null;
    newLine: number | null;
}

/**
 * Diff ligne à ligne (plus longue sous-suite commune), après avoir retiré le début et la fin
 * communs : une spec de quelques centaines de lignes modifiée par endroits reste instantanée.
 */
export function diffLines(before: string, after: string): LineChange[] {
    const a = before.split('\n');
    const b = after.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const n = endA - start;
    const m = endB - start;
    // lcs[i][j] = longueur de la plus longue sous-suite commune de a[start+i..] et b[start+j..].
    const lcs = new Uint32Array((n + 1) * (m + 1));
    const at = (i: number, j: number): number => lcs[i * (m + 1) + j] ?? 0;
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i * (m + 1) + j] = a[start + i] === b[start + j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
        }
    }

    const out: LineChange[] = [];
    for (let k = 0; k < start; k++) out.push({ kind: ' ', text: a[k] ?? '', oldLine: k + 1, newLine: k + 1 });
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[start + i] === b[start + j]) {
            out.push({ kind: ' ', text: a[start + i] ?? '', oldLine: start + i + 1, newLine: start + j + 1 });
            i++;
            j++;
        } else if (i < n && (j >= m || at(i + 1, j) >= at(i, j + 1))) {
            // À égalité, la suppression d'abord, comme git.
            out.push({ kind: '-', text: a[start + i] ?? '', oldLine: start + i + 1, newLine: null });
            i++;
        } else {
            out.push({ kind: '+', text: b[start + j] ?? '', oldLine: null, newLine: start + j + 1 });
            j++;
        }
    }
    for (let k = 0; k < a.length - endA; k++) out.push({ kind: ' ', text: a[endA + k] ?? '', oldLine: endA + k + 1, newLine: endB + k + 1 });
    return out;
}

/** Blocs à afficher : les changements et `context` lignes autour ; le reste est replié (`skipped`). */
export type DiffChunk = { kind: 'lines'; lines: LineChange[] } | { kind: 'skipped'; count: number };

export function chunkDiff(changes: LineChange[], context = 3): DiffChunk[] {
    const keep = changes.map(() => false);
    changes.forEach((c, index) => {
        if (c.kind === ' ') return;
        for (let k = Math.max(0, index - context); k <= Math.min(changes.length - 1, index + context); k++) keep[k] = true;
    });
    const chunks: DiffChunk[] = [];
    let skipped = 0;
    for (const [index, change] of changes.entries()) {
        if (!keep[index]) {
            skipped++;
            continue;
        }
        if (skipped) chunks.push({ kind: 'skipped', count: skipped });
        skipped = 0;
        const last = chunks.at(-1);
        if (last?.kind === 'lines') last.lines.push(change);
        else chunks.push({ kind: 'lines', lines: [change] });
    }
    if (skipped) chunks.push({ kind: 'skipped', count: skipped });
    return chunks;
}

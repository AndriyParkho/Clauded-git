/**
 * Coloration syntaxique du diff, chargée à la demande : le cœur de highlight.js puis la grammaire
 * du langage du fichier (une par extension), jamais au chargement initial de l'app.
 *
 * Le diff n'a pas le fichier complet : on colore chaque hunk d'un bloc, côté ancien (contexte +
 * suppressions) et côté nouveau (contexte + ajouts), pour garder les commentaires et chaînes sur
 * plusieurs lignes, puis on recoupe le HTML ligne par ligne. Un hunk qui commence au milieu d'un
 * commentaire sera mal coloré : c'est accepté.
 *
 * Sécurité : le seul HTML produit vient de highlight.js, qui échappe le texte source ; le découpage
 * ne fait que fermer et rouvrir ses propres `<span>`.
 */
import { useEffect, useState } from 'react';
import type { HLJSApi, LanguageFn } from 'highlight.js';
import type { DiffFile } from '../../../shared/diff';

/** Au-delà, les hunks suivants du fichier restent en texte brut (perf). */
export const HIGHLIGHT_MAX_LINES = 2000;

type Loader = () => Promise<{ default: LanguageFn }>;

// Chemins écrits en entier : Vite en fait un petit chunk par langage.
const LOADERS: Record<string, Loader> = {
    typescript: () => import('highlight.js/lib/languages/typescript'),
    javascript: () => import('highlight.js/lib/languages/javascript'),
    json: () => import('highlight.js/lib/languages/json'),
    css: () => import('highlight.js/lib/languages/css'),
    scss: () => import('highlight.js/lib/languages/scss'),
    xml: () => import('highlight.js/lib/languages/xml'),
    markdown: () => import('highlight.js/lib/languages/markdown'),
    yaml: () => import('highlight.js/lib/languages/yaml'),
    bash: () => import('highlight.js/lib/languages/bash'),
    python: () => import('highlight.js/lib/languages/python'),
    go: () => import('highlight.js/lib/languages/go'),
    sql: () => import('highlight.js/lib/languages/sql'),
    php: () => import('highlight.js/lib/languages/php'),
};

/** Langages embarqués (`<style>`, `<script>` dans le HTML). */
const DEPS: Record<string, string[]> = { xml: ['css', 'javascript'] };

const BY_EXTENSION: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json', json5: 'json',
    css: 'css', scss: 'scss',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', plist: 'xml',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    yml: 'yaml', yaml: 'yaml',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    py: 'python', go: 'go', sql: 'sql', php: 'php',
};

const BY_NAME: Record<string, string> = { '.bashrc': 'bash', '.zshrc': 'bash', '.profile': 'bash' };

/** Le langage à utiliser pour ce chemin, `null` si on ne sait pas le colorer. */
export function languageOf(path: string): string | null {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (BY_NAME[name]) return BY_NAME[name];
    const dot = name.lastIndexOf('.');
    return dot > 0 ? (BY_EXTENSION[name.slice(dot + 1)] ?? null) : null;
}

let core: Promise<HLJSApi> | null = null;
const ready = new Map<string, Promise<HLJSApi | null>>();

/** highlight.js avec ce langage (et ses dépendances) enregistré ; `null` si le chargement échoue. */
function load(language: string): Promise<HLJSApi | null> {
    let promise = ready.get(language);
    if (!promise) {
        promise = (async (): Promise<HLJSApi | null> => {
            core ??= import('highlight.js/lib/core').then((m) => m.default);
            const names = [language, ...(DEPS[language] ?? [])];
            const [hljs, ...grammars] = await Promise.all([core, ...names.map((n) => LOADERS[n]!())]);
            names.forEach((name, i) => {
                if (!hljs.getLanguage(name)) hljs.registerLanguage(name, grammars[i]!.default);
            });
            return hljs;
        })().catch(() => {
            // Réseau coupé, chunk introuvable… : on reste en texte brut, et on réessaiera plus tard.
            ready.delete(language);
            return null;
        });
        ready.set(language, promise);
    }
    return promise;
}

/** Découpe le HTML coloré aux retours à la ligne, en refermant puis rouvrant les `<span>` ouverts. */
function splitLines(html: string): string[] {
    const out: string[] = [];
    const open: string[] = [];
    let current = '';
    let last = 0;
    for (const match of html.matchAll(/<span[^>]*>|<\/span>|\n/g)) {
        current += html.slice(last, match.index);
        last = match.index + match[0].length;
        if (match[0] === '\n') {
            out.push(current + '</span>'.repeat(open.length));
            current = open.join('');
        } else {
            if (match[0] === '</span>') open.pop();
            else open.push(match[0]);
            current += match[0];
        }
    }
    out.push(current + html.slice(last) + '</span>'.repeat(open.length));
    return out;
}

/** HTML coloré de chaque ligne, par hunk puis par ligne ; `undefined` : à afficher en texte brut. */
export type Highlighted = Array<Array<string | undefined>>;

function highlightFile(hljs: HLJSApi, language: string, file: DiffFile): Highlighted {
    let budget = HIGHLIGHT_MAX_LINES;
    return file.hunks.map((hunk) => {
        const out: Array<string | undefined> = new Array<string | undefined>(hunk.lines.length);
        if (budget < hunk.lines.length) {
            budget = 0;
            return out;
        }
        budget -= hunk.lines.length;
        const before: number[] = [];
        const after: number[] = [];
        hunk.lines.forEach((line, i) => {
            if (line.kind !== 'add') before.push(i);
            if (line.kind !== 'del') after.push(i);
        });
        // Le contexte est colorié deux fois : la version « nouvelle » l'emporte, c'est la même ligne.
        for (const side of [before, after]) {
            if (side.length === 0) continue;
            try {
                const html = hljs.highlight(side.map((i) => hunk.lines[i]!.text).join('\n'), { language, ignoreIllegals: true }).value;
                const lines = splitLines(html);
                if (lines.length !== side.length) continue;
                side.forEach((i, k) => {
                    out[i] = lines[k];
                });
            } catch {
                // grammaire en erreur sur ce bloc : texte brut
            }
        }
        return out;
    });
}

// Résultats gardés par contenu de fichier (chemin + hash du patch), les plus récents d'abord.
const CACHE_MAX = 300;
const cache = new Map<string, Highlighted>();

function remember(key: string, value: Highlighted): void {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

// Une file de coloriages traitée par tranches de ~12 ms : ouvrir 50 fichiers d'un coup ne fige pas l'UI.
const queue: Array<() => void> = [];
let pumping = false;

function pump(): void {
    const start = performance.now();
    while (queue.length > 0 && performance.now() - start < 12) queue.shift()!();
    if (queue.length > 0) setTimeout(pump, 0);
    else pumping = false;
}

function schedule(task: () => void): void {
    queue.push(task);
    if (!pumping) {
        pumping = true;
        setTimeout(pump, 0);
    }
}

/**
 * Le fichier colorié, ou `null` tant que ce n'est pas prêt (ou si le langage est inconnu).
 * `key` identifie le contenu du fichier : le résultat est mémorisé avec.
 */
export function useHighlight(file: DiffFile, key: string): Highlighted | null {
    const language = languageOf(file.path);
    const [result, setResult] = useState<{ key: string; value: Highlighted } | null>(() => {
        const hit = cache.get(key);
        return hit ? { key, value: hit } : null;
    });

    useEffect(() => {
        if (!language || file.binary || file.hunks.length === 0) return;
        const hit = cache.get(key);
        if (hit) {
            setResult((r) => (r?.key === key ? r : { key, value: hit }));
            return;
        }
        let cancelled = false;
        void load(language).then((hljs) => {
            if (cancelled || !hljs) return;
            schedule(() => {
                if (cancelled) return;
                const value = cache.get(key) ?? highlightFile(hljs, language, file);
                remember(key, value);
                setResult({ key, value });
            });
        });
        return () => {
            cancelled = true;
        };
    }, [file, key, language]);

    // Un résultat d'un autre contenu (fichier modifié depuis) ne doit jamais s'afficher.
    return result?.key === key ? result.value : null;
}

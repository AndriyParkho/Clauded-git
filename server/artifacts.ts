import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { DATA_DIR } from './config.js';
import type { ArtifactFile } from '../shared/protocol.js';

/**
 * Pages qu'une session écrit pour qu'on les regarde (rapport, visualisation, maquette) : l'équivalent
 * des artifacts de l'app Claude, que les sessions du SDK n'ont pas. Un dossier par onglet, servi par
 * l'app sous `/artifacts/<onglet>/…`.
 */
export const ARTIFACTS_DIR = join(DATA_DIR, 'artifacts');

export function artifactsDir(runId: number): string {
    return join(ARTIFACTS_DIR, String(runId));
}

const PAGES = new Set(['.html', '.htm', '.svg', '.md']);

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
};

/**
 * La page est servie à part de l'app : en origine opaque (`sandbox` sans `allow-same-origin`), son
 * JavaScript ne peut ni lire l'API locale ni ses réponses.
 */
export const ARTIFACT_CSP = 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads';

/** Consigne ajoutée au prompt système de chaque session. */
export function artifactInstructions(runId: number): string {
    const dir = artifactsDir(runId);
    return [
        '# Pages à regarder (artifacts)',
        '',
        "Tu tournes dans Clauded GIT, une app locale qui affiche cette conversation. L'outil Artifact de l'app Claude n'existe pas ici.",
        `Quand on te demande un artifact, ou quand une page se lit mieux qu'une réponse en texte (rapport, tableau de bord, visualisation, schéma, maquette d'écran), écris un fichier HTML autonome dans \`${dir}/\` (crée le dossier s'il manque), avec un nom court et parlant (\`rapport-perf.html\`). L'app le montre au-dessus du chat et l'ouvre dans le navigateur.`,
        "- Un seul fichier : CSS et JavaScript dedans. Des bibliothèques depuis un CDN (cdnjs, jsDelivr, unpkg) avec une version exacte si besoin. Les fichiers annexes (images, données) vont dans le même dossier, en chemins relatifs.",
        "- La page s'ouvre dans un bac à sable : pas d'accès à l'API de l'app, ni de localStorage fiable. Mets les données dans la page.",
        '- Pour la mettre à jour, réécris le même fichier.',
        '- Termine en donnant le nom du fichier.',
    ].join('\n');
}

/** Pages de l'onglet (HTML, SVG, Markdown), les plus récentes d'abord. */
export async function listArtifacts(runId: number): Promise<ArtifactFile[]> {
    const dir = artifactsDir(runId);
    const names = await readdir(dir).catch(() => [] as string[]);
    const files: ArtifactFile[] = [];
    for (const name of names) {
        if (!PAGES.has(extname(name).toLowerCase())) continue;
        const info = await stat(join(dir, name)).catch(() => undefined);
        if (info?.isFile()) files.push({ name, url: `/artifacts/${runId}/${encodeURIComponent(name)}`, size: info.size, updatedAt: info.mtime.toISOString() });
    }
    return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Contenu d'un fichier du dossier de l'onglet ; `undefined` s'il n'existe pas ou sort du dossier. */
export async function readArtifact(runId: number, path: string): Promise<{ body: Buffer; type: string } | undefined> {
    const dir = artifactsDir(runId);
    const target = resolve(dir, path);
    const inside = relative(dir, target);
    if (!inside || inside.startsWith('..') || inside.includes(`..${sep}`)) return undefined;
    const body = await readFile(target).catch(() => undefined);
    if (!body) return undefined;
    return { body, type: TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream' };
}

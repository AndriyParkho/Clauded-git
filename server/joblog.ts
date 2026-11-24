import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import type { JobInfo } from '../shared/protocol.js';

const LOGS_DIR = join(DATA_DIR, 'logs');
/** Lignes de fin recopiées dans le message : souvent assez pour comprendre un échec. */
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

/** Fin d'une sortie : les dernières lignes, au plus `TAIL_CHARS` caractères. */
export function tail(output: string, lines = TAIL_LINES): string {
    const last = output.trimEnd().split('\n').slice(-lines).join('\n');
    return last.length > TAIL_CHARS ? `…${last.slice(-TAIL_CHARS)}` : last;
}

/**
 * Écrit la sortie complète d'une commande dans `~/.clauded-git/logs/run-<onglet>/` et rend un bloc à
 * mettre dans un prompt : la fin de la sortie, et le chemin du fichier à lire seulement si besoin.
 * Coller toute la sortie dans le chat la ferait renvoyer au modèle à chaque requête suivante.
 */
export async function jobOutputForPrompt(job: JobInfo): Promise<string> {
    const dir = join(LOGS_DIR, `run-${job.runId}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${job.name.replace(/[^\w.-]+/g, '_').slice(0, 40)}-${job.id.slice(0, 8)}.log`);
    await writeFile(file, job.output);
    const lines = job.output.trimEnd().split('\n').length;
    return [
        `Fin de la sortie (${Math.min(lines, TAIL_LINES)} dernières lignes sur ${lines}) :`,
        '```',
        tail(job.output),
        '```',
        lines > TAIL_LINES ? `Sortie complète : \`${file}\`. Si la fin ne suffit pas, cherches-y avec Grep ou lis la partie utile avec Read (offset, limit), pas le fichier entier.` : '',
    ]
        .filter(Boolean)
        .join('\n');
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { getRepo } from '../db.js';
import { loadProfile } from '../profiles.js';
import type { Run } from '../../shared/protocol.js';

/**
 * Consigne ajoutée au prompt système de chaque session : garder le contexte court, comme on le
 * ferait à la main (sous-agent pour les recherches larges, lecture ciblée des gros fichiers).
 */
export const CONTEXT_HINTS = [
    'Économie de contexte (chaque token du fil est renvoyé à chaque requête) :',
    '- Pour une recherche large dans le code (où est X, qui appelle Y, comment marche Z), délègue à un sous-agent Explore : ce qu\'il lit reste dans son contexte, seul son résumé revient.',
    '- Gros fichiers et logs (sortie de commande, fichier de log indiqué par l\'app) : cherche avec Grep ou lis la partie utile avec Read (offset, limit) plutôt que tout le fichier.',
    '- Ne relis pas un fichier que tu viens de lire ou de modifier, et ne réaffiche pas de longs extraits de code dans tes réponses.',
].join('\n');

async function projectMcp(dirs: string[]): Promise<Record<string, McpServerConfig>> {
    for (const dir of dirs) {
        try {
            const parsed = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
            return parsed.mcpServers ?? {};
        } catch {
            // pas de .mcp.json ici (ou illisible) : dossier suivant
        }
    }
    return {};
}

/**
 * Serveurs MCP d'une session : tous pour un chat, une PR ou une spec ; pour une implémentation ou
 * une résolution de conflits, selon `implementMcp` du profil (par défaut, ceux du `.mcp.json` du
 * dépôt seulement). `undefined` : pas de restriction.
 */
export async function sessionMcp(run: Run): Promise<Record<string, McpServerConfig> | undefined> {
    if (run.type !== 'implement' && run.type !== 'merge') return undefined;
    const repo = run.repoId !== null ? getRepo(run.repoId) : undefined;
    if (!repo) return undefined;
    const mode = (await loadProfile(repo).catch(() => undefined))?.implementMcp ?? 'project';
    if (mode === 'all') return undefined;
    if (mode === 'none') return {};
    return projectMcp([run.cwd, repo.path]);
}

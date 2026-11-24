import type { FastifyInstance } from 'fastify';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Vrai si une requête portant cet en-tête Origin peut appeler l'API. */
export function originAllowed(origin: string | undefined): boolean {
    if (!origin) return true;
    try {
        return LOCAL_HOSTS.has(new URL(origin).hostname);
    } catch {
        // `null` (page en bac à sable, fichier local) ou valeur illisible.
        return false;
    }
}

/**
 * L'API lance des commandes et des sessions : seule l'UI de l'app (servie ici ou par Vite, sur
 * localhost) peut l'appeler. Un site quelconque ouvert dans le navigateur, ou un artifact servi en
 * bac à sable (origine `null`), est refusé. Sans en-tête Origin (curl, navigation), rien ne change.
 */
export function guardOrigin(app: FastifyInstance): void {
    app.addHook('onRequest', async (request, reply) => {
        if (!(request.url.startsWith('/api/') || request.url.startsWith('/ws'))) return;
        if (!originAllowed(request.headers.origin)) return reply.code(403).send({ error: 'origine refusée' });
    });
}

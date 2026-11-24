/**
 * Petit cache en mémoire pour les lectures coûteuses (appels `gh`, `git fetch`) : une même clé
 * demandée plusieurs fois en même temps ne lance qu'un appel, et le résultat sert encore pendant
 * `ttlMs`. Une erreur n'est pas gardée : l'appel suivant réessaie.
 */
interface Entry {
    at: number;
    value: Promise<unknown>;
    settled: boolean;
}

const entries = new Map<string, Entry>();
/** Au-delà, les entrées les plus anciennes sont jetées (les clés portent des numéros d'issue, de PR…). */
const MAX_ENTRIES = 500;

export function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = entries.get(key);
    // En cours : on partage la promesse, quel que soit le TTL.
    if (hit && (!hit.settled || now - hit.at < ttlMs)) return hit.value as Promise<T>;
    const entry: Entry = { at: now, settled: false, value: Promise.resolve() };
    entry.value = load().then(
        (value) => {
            entry.settled = true;
            entry.at = Date.now();
            return value;
        },
        (error: unknown) => {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
        },
    );
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
    }
    return entry.value as Promise<T>;
}

/** Oublie les entrées dont la clé commence par `prefix` (après une écriture qui les rend fausses). */
export function forget(prefix: string): void {
    for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}

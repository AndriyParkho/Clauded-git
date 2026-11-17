import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface Closable {
    close(): void;
}

const POLL_MS = 1000;

/**
 * Prévient à chaque fichier (ré)écrit dans `dir`, par son nom. On surveille le dossier et non le
 * fichier : un éditeur (ou l'outil Write) remplace souvent le fichier au lieu de l'écrire en place.
 * Si le système refuse la surveillance (trop de watchers, sandbox), relevé des dates toutes les secondes.
 */
export function watchDirectory(dir: string, onChange: (name: string) => void, accept: (name: string) => boolean): Closable {
    let poll: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;
    const startPolling = (): void => {
        watcher?.close();
        watcher = undefined;
        const seen = new Map<string, number>();
        let baseline = true;
        const scan = async (): Promise<void> => {
            const names = await readdir(dir).catch(() => [] as string[]);
            for (const name of names.filter(accept)) {
                const mtime = (await stat(join(dir, name)).catch(() => undefined))?.mtimeMs;
                if (mtime === undefined) continue;
                const previous = seen.get(name);
                seen.set(name, mtime);
                // Le premier relevé sert de référence ; ensuite, un fichier nouveau ou modifié est signalé.
                if (!baseline && previous !== mtime) onChange(name);
            }
            baseline = false;
        };
        void scan();
        poll = setInterval(() => void scan(), POLL_MS);
        poll.unref();
    };
    try {
        watcher = watch(dir, (_event, name) => {
            if (name && accept(name)) onChange(name);
        });
        watcher.on('error', startPolling);
    } catch {
        startPolling();
    }
    return {
        close: () => {
            watcher?.close();
            clearInterval(poll);
        },
    };
}

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

const loading = new Map<number, Promise<void>>();

/** Charge (une fois par dépôt) la commande Bruno du profil et le checkout sur lequel Bruno pointe. */
function loadBruno(repoId: number, force = false): Promise<void> {
    const pending = loading.get(repoId);
    if (pending && !force) return pending;
    const work = api
        .bruno(repoId)
        .then((state) => useStore.setState((s) => ({ bruno: { ...s.bruno, [repoId]: state } })))
        .catch(() => undefined);
    loading.set(repoId, work);
    return work;
}

/**
 * Fait pointer l'environnement Bruno sur ce checkout (dépôt principal ou worktree) avec la commande
 * du profil (`bru-use {path}`). Affiche « Bruno ✓ » quand il y pointe déjà. Rien sans commande.
 */
export function BrunoButton({ repoId, path, label = 'Bruno' }: { repoId: number; path: string; label?: string }): ReactElement | null {
    const state = useStore((s) => s.bruno[repoId]);
    const notify = useStore((s) => s.notify);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void loadBruno(repoId);
    }, [repoId]);

    if (!state?.command) return null;
    const active = state.active === path;

    const switchTo = async (): Promise<void> => {
        setBusy(true);
        try {
            const result = await api.switchBruno(repoId, path);
            useStore.setState((s) => ({ bruno: { ...s.bruno, [repoId]: { command: result.command, active: result.active } } }));
            notify(result.output || `Bruno → ${path}`, { kind: 'success' });
        } catch (error) {
            notify(String(error));
            void loadBruno(repoId, true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <button
            className={`bruno-button ${active ? 'active' : ''}`}
            disabled={busy}
            onClick={() => void switchTo()}
            title={active ? `Bruno pointe déjà sur ${path} (cliquer relance la commande)` : `Faire pointer Bruno sur ${path} : ${state.command.replaceAll('{path}', path)}`}
        >
            {busy ? `${label}…` : active ? `${label} ✓` : `${label} →`}
        </button>
    );
}

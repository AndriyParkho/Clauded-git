import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Modal } from '../Modal';
import { formatTokens } from './ContextGauge';
import type { MemoryFile, MemoryInfo } from '../../../../shared/protocol';

const SCOPES: Array<{ scope: MemoryFile['scope']; label: string; hint: string }> = [
    { scope: 'project', label: 'Projet', hint: 'CLAUDE.md du dossier de l\'onglet (partagé avec le dépôt) ; CLAUDE.local.md reste local' },
    { scope: 'user', label: 'Compte', hint: '~/.claude/CLAUDE.md, pour tous les projets' },
    { scope: 'auto', label: 'Mémoire automatique', hint: 'Ce que Claude retient de lui-même pour ce projet : MEMORY.md est l\'index chargé, les autres fichiers sont lus à la demande' },
];

const home = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~');

/** Mémoire automatique : le nom du fichier suffit (le dossier, très long, est dans l'infobulle). */
const shortPath = (file: MemoryFile): string => (file.scope === 'auto' ? `memory/${file.path.split('/').at(-1) ?? ''}` : home(file.path));

/**
 * Fenêtre ouverte par `/memory` (menu du terminal, absent du SDK) : les fichiers de mémoire de
 * l'onglet, chargés ou non, et un bouton pour les ouvrir (ou les créer) dans VS Code. Les changements
 * comptent à la prochaine session (« Nouvelle conversation » ou réouverture de l'onglet).
 */
export function MemoryDialog({ runId, onClose }: { runId: number; onClose: () => void }): ReactElement {
    const [info, setInfo] = useState<MemoryInfo | undefined>();
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
        api.memory(runId).then(setInfo, (e: unknown) => setError(String(e)));
    }, [runId]);

    const open = (path: string): void => {
        setError(undefined);
        api.openMemoryFile(runId, path).then(
            () => api.memory(runId).then(setInfo),
            (e: unknown) => setError(String(e)),
        );
    };

    return (
        <Modal className="memory-modal" onClose={onClose}>
            <div className="mcp-head">
                <strong>Mémoire</strong>
                <span className="muted">fichiers d'instructions de cet onglet</span>
                <span className="spacer" />
                <button className="small" onClick={onClose} title="Fermer">
                    ×
                </button>
            </div>
            {error && <div className="error">{error}</div>}
            {!info && !error && <div className="muted pad">chargement…</div>}
            {info &&
                SCOPES.map(({ scope, label, hint }) => {
                    const files = info.files.filter((f) => f.scope === scope);
                    if (files.length === 0) return null;
                    return (
                        <section key={scope} className="memory-scope">
                            <div className="memory-scope-head" title={hint}>
                                {label}
                            </div>
                            {files.map((file) => (
                                <div key={file.path} className={`memory-file ${file.exists ? '' : 'missing'}`}>
                                    <span className="mono memory-path" title={file.path}>
                                        {shortPath(file)}
                                    </span>
                                    <span className="muted memory-state">{file.tokens !== undefined ? `chargé · ${formatTokens(file.tokens)} tokens` : file.exists ? 'non chargé' : 'absent'}</span>
                                    <span className="spacer" />
                                    <button className="small" onClick={() => open(file.path)} title={file.exists ? 'Ouvrir dans VS Code' : 'Créer le fichier et l\'ouvrir dans VS Code'}>
                                        {file.exists ? 'Ouvrir' : 'Créer'}
                                    </button>
                                </div>
                            ))}
                        </section>
                    );
                })}
            <div className="muted memory-note">Une modification compte à la prochaine session de l'onglet (Nouvelle conversation, ou réouverture). Pour que Claude retienne quelque chose, tu peux aussi le lui demander dans le chat.</div>
        </Modal>
    );
}

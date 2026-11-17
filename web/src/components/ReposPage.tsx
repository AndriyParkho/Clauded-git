import type { ReactElement } from 'react';
import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { BrunoButton } from './BrunoButton';
import { CleanupButton } from './CleanupDialog';

export function ReposPage(): ReactElement {
    const repos = useStore((s) => s.repos);
    const setRepos = useStore((s) => s.setRepos);
    const notify = useStore((s) => s.notify);
    const upsertRun = useStore((s) => s.upsertRun);
    const setActive = useStore((s) => s.setActive);
    const [path, setPath] = useState('');
    const [root, setRoot] = useState('~/Documents/github');
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState('');

    const refresh = async (): Promise<void> => setRepos(await api.repos());

    const add = async (): Promise<void> => {
        if (!path.trim()) return;
        setBusy(true);
        try {
            const result = await api.addRepo(path.trim());
            setReport(result.status === 'added' ? `Ajouté : ${result.repo.path}` : `Déjà enregistré : ${result.repo.path}`);
            setPath('');
            await refresh();
        } catch (error) {
            notify(String(error));
        } finally {
            setBusy(false);
        }
    };

    const scan = async (): Promise<void> => {
        if (!root.trim()) return;
        setBusy(true);
        try {
            const result = await api.scanRepos(root.trim());
            setReport(`${result.found.length} dépôts trouvés, ${result.added.length} ajoutés, ${result.existing.length} déjà connus.`);
            await refresh();
        } catch (error) {
            notify(String(error));
        } finally {
            setBusy(false);
        }
    };

    const toggle = async (id: number, enabled: boolean): Promise<void> => {
        await api.patchRepo(id, { enabled });
        await refresh();
    };

    const remove = async (id: number): Promise<void> => {
        await api.deleteRepo(id);
        await refresh();
    };

    const chatIn = async (cwd: string): Promise<void> => {
        try {
            const run = await api.createRun({ cwd });
            upsertRun(run);
            setActive(run.id);
        } catch (error) {
            notify(String(error));
        }
    };

    return (
        <div className="page">
            <h2>Dépôts</h2>
            <div className="form-row">
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Chemin d'un dépôt git, ex. ~/dev/mon-projet" onKeyDown={(e) => e.key === 'Enter' && void add()} />
                <button disabled={busy} onClick={() => void add()}>
                    Ajouter
                </button>
            </div>
            <div className="form-row">
                <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="Dossier à scanner, ex. ~/Documents/github" onKeyDown={(e) => e.key === 'Enter' && void scan()} />
                <button disabled={busy} onClick={() => void scan()}>
                    Scanner le dossier
                </button>
            </div>
            {report && <div className="muted">{report}</div>}
            <table className="table">
                <thead>
                    <tr>
                        <th>Actif</th>
                        <th>Dépôt</th>
                        <th>Chemin</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {repos.map((repo) => (
                        <tr key={repo.id}>
                            <td>
                                <input type="checkbox" checked={repo.enabled} onChange={(e) => void toggle(repo.id, e.target.checked)} />
                            </td>
                            <td>
                                {repo.owner ? `${repo.owner}/${repo.name}` : repo.name}
                                {repo.host && repo.host !== 'github.com' && <span className="muted"> · {repo.host}</span>}
                            </td>
                            <td className="mono">{repo.path}</td>
                            <td className="actions">
                                <button className="small" onClick={() => void chatIn(repo.path)}>
                                    chat
                                </button>
                                {repo.host === 'github.com' && <CleanupButton repo={repo} label="nettoyer…" />}
                                <BrunoButton repoId={repo.id} path={repo.path} label="Bruno (principal)" />
                                <button className="small danger" onClick={() => void remove(repo.id)} title="Retirer de la liste (rien n'est supprimé sur le disque)">
                                    retirer
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <h3>Chat libre</h3>
            <p className="muted">Un chat Claude Code dans n'importe quel dossier, sans l'enregistrer comme dépôt.</p>
            <FreeChat onOpen={chatIn} />
        </div>
    );
}

function FreeChat({ onOpen }: { onOpen: (cwd: string) => Promise<void> }): ReactElement {
    const [cwd, setCwd] = useState('');
    return (
        <div className="form-row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Dossier de travail" onKeyDown={(e) => e.key === 'Enter' && cwd && void onOpen(cwd)} />
            <button disabled={!cwd} onClick={() => void onOpen(cwd)}>
                Ouvrir un chat
            </button>
        </div>
    );
}

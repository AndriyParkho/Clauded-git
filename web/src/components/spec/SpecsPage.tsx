import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { stateDot } from '../Tabs';
import type { Run } from '../../../../shared/protocol';

const OTHER = 'other';

function ago(iso: string): string {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (minutes < 1) return "à l'instant";
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

const home = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~');

/**
 * Page Spec : démarrer une spec dans un dépôt ou un nouveau dossier, et retrouver les précédentes
 * (fermer l'onglet d'une spec la garde ici, reprenable).
 */
export function SpecsPage(): ReactElement {
    const allRepos = useStore((s) => s.repos);
    const repos = allRepos.filter((r) => r.enabled);
    const upsertRun = useStore((s) => s.upsertRun);
    const setActive = useStore((s) => s.setActive);
    const setDraft = useStore((s) => s.setDraft);
    const notify = useStore((s) => s.notify);
    const openRuns = useStore((s) => s.runs);
    const [where, setWhere] = useState<string>('');
    const [folder, setFolder] = useState('');
    const [file, setFile] = useState('SPEC.md');
    const [busy, setBusy] = useState(false);
    const [specs, setSpecs] = useState<Run[] | null>(null);

    useEffect(() => {
        api.specs()
            .then(setSpecs)
            .catch((e: unknown) => notify(String(e)));
    }, [notify, openRuns.length]);

    useEffect(() => {
        if (!where && repos[0]) setWhere(String(repos[0].id));
    }, [where, repos]);

    const start = async (): Promise<void> => {
        setBusy(true);
        try {
            const { run, draft } = await api.startSpec(where === OTHER ? { cwd: folder, file } : { repoId: Number(where), file });
            upsertRun(run);
            setDraft(run.id, draft);
            setActive(run.id);
        } catch (error) {
            notify(String(error));
        } finally {
            setBusy(false);
        }
    };

    const open = async (run: Run): Promise<void> => {
        try {
            upsertRun(run.archived ? await api.openRun(run.id) : run);
            setActive(run.id);
        } catch (error) {
            notify(String(error));
        }
    };

    const live = new Map(openRuns.map((r) => [r.id, r]));

    return (
        <div className="page">
            <h2>Spec</h2>
            <p className="muted spec-intro">
                Un chat Claude Code à gauche, la spec rendue en direct à droite (markdown et mermaid, versions comparables). Sélectionne un passage pour le commenter : le commentaire part avec ton message suivant. Quand
                la spec est prête, Claude la découpe en issues, tu corriges le découpage, l'app crée les issues sur GitHub (parente, sous-issues, « bloquée par ») et lance leur implémentation.
            </p>
            <div className="form-row">
                <select value={where} onChange={(e) => setWhere(e.target.value)}>
                    {repos.map((r) => (
                        <option key={r.id} value={r.id}>
                            {r.owner ? `${r.owner}/${r.name}` : home(r.path)}
                        </option>
                    ))}
                    <option value={OTHER}>Autre dossier…</option>
                </select>
                {where === OTHER && <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~/dev/mon-idee (créé s'il n'existe pas)" />}
                <input className="spec-file-input" value={file} onChange={(e) => setFile(e.target.value)} title="Fichier de spec, relatif au dossier" />
                <button className="primary" disabled={busy || !where || (where === OTHER && !folder.trim())} onClick={() => void start()}>
                    Nouvelle spec
                </button>
            </div>

            <h3>Specs</h3>
            {!specs && <div className="muted">chargement…</div>}
            {specs?.length === 0 && <div className="muted">Aucune spec pour l'instant.</div>}
            {specs && specs.length > 0 && (
                <table className="table">
                    <tbody>
                        {specs.map((spec) => {
                            const current = live.get(spec.id) ?? spec;
                            return (
                                <tr key={spec.id}>
                                    <td>{current.archived ? <span className="dot dot-closed" title="onglet fermé" /> : stateDot(current.state)}</td>
                                    <td>{current.title}</td>
                                    <td className="mono muted">{home(current.specPath ?? current.cwd)}</td>
                                    <td className="muted">{ago(current.updatedAt)}</td>
                                    <td>
                                        <button className="small" onClick={() => void open(current)}>
                                            {current.archived ? 'Reprendre' : 'Ouvrir'}
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </div>
    );
}

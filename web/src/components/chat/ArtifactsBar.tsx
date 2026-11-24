import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { ArtifactFile, Run } from '../../../../shared/protocol';

/**
 * Pages écrites par la session (ses « artifacts ») : relues à l'ouverture et à la fin de chaque tour,
 * ouvertes dans un nouvel onglet du navigateur.
 */
export function ArtifactsBar({ run }: { run: Run }): ReactElement | null {
    const [files, setFiles] = useState<ArtifactFile[]>([]);
    const turnOver = run.state !== 'running' && run.state !== 'starting';

    useEffect(() => {
        if (!turnOver) return;
        let live = true;
        api.artifacts(run.id)
            .then((list) => live && setFiles(list))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [run.id, turnOver]);

    if (files.length === 0) return null;
    return (
        <div className="artifacts-bar">
            <span className="muted">Pages :</span>
            {files.map((file) => (
                <a key={file.name} className="artifact-chip" href={file.url} target="_blank" rel="noreferrer" title={`Écrite le ${new Date(file.updatedAt).toLocaleString('fr-FR')} · ouvre dans un nouvel onglet`}>
                    {file.name} ↗
                </a>
            ))}
        </div>
    );
}

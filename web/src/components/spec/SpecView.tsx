import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useStore, type Panel } from '../../store';
import { ChatView } from '../chat/ChatView';
import { QuoteSelection } from '../chat/QuoteSelection';
import { Markdown } from '../Markdown';
import { OpenMenu } from '../OpenMenu';
import { SpecPlanPanel } from './SpecPlanPanel';
import { chunkDiff, diffLines } from '../../../../shared/linediff';
import type { Run, SpecFile } from '../../../../shared/protocol';

const baseName = (path: string): string => path.split('/').at(-1) ?? path;

const time = (iso: string): string => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Charge le fichier de spec de l'onglet ; les écritures suivantes arrivent par websocket. */
function useSpec(runId: number): SpecFile | undefined {
    const spec = useStore((s) => s.specs[runId]);
    const notify = useStore((s) => s.notify);
    useEffect(() => {
        api.spec(runId)
            .then((loaded) => useStore.setState((s) => ({ specs: { ...s.specs, [runId]: loaded } })))
            .catch((e: unknown) => notify(String(e), runId));
    }, [runId, notify]);
    return spec;
}

function SpecDoc({ run, spec }: { run: Run; spec: SpecFile | undefined }): ReactElement {
    if (!spec) return <div className="muted pad">chargement de la spec…</div>;
    if (spec.content === null) {
        return (
            <div className="muted pad">
                <span className="mono">{spec.path}</span> n'existe pas encore. Décris ton idée dans le chat : Claude pose ses questions puis écrit la spec, qui s'affiche ici à chaque écriture.
            </div>
        );
    }
    return (
        <QuoteSelection runId={run.id} source={baseName(spec.path)} placeholder="Ton commentaire sur ce passage" className="spec-doc">
            <Markdown text={spec.content} />
        </QuoteSelection>
    );
}

/** Deux versions du fichier côte à côte en diff ligne à ligne (par défaut : l'avant-dernière et l'actuelle). */
function SpecVersions({ spec }: { spec: SpecFile | undefined }): ReactElement {
    const versions = spec?.versions ?? [];
    const latest = versions.at(-1)?.id;
    const [from, setFrom] = useState<number | null>(null);
    const [to, setTo] = useState<number | null>(null);
    const [contents, setContents] = useState<Record<number, string>>({});
    const notify = useStore((s) => s.notify);

    // Suit la dernière version tant qu'on n'en a pas choisi d'autres.
    const fromId = from ?? versions.at(-2)?.id ?? null;
    const toId = to ?? latest ?? null;

    useEffect(() => {
        for (const id of [fromId, toId]) {
            if (id === null || contents[id] !== undefined) continue;
            api.specVersion(id)
                .then(({ content }) => setContents((c) => ({ ...c, [id]: content })))
                .catch((e: unknown) => notify(String(e)));
        }
    }, [fromId, toId, contents, notify]);

    const chunks = useMemo(() => {
        const before = fromId !== null ? contents[fromId] : undefined;
        const after = toId !== null ? contents[toId] : undefined;
        return before === undefined || after === undefined ? undefined : chunkDiff(diffLines(before, after));
    }, [fromId, toId, contents]);

    if (!spec) return <div className="muted pad">chargement…</div>;
    if (versions.length < 2) return <div className="muted pad">Une seule version pour l'instant : chaque écriture du fichier en ajoute une, à comparer ici.</div>;

    const label = (id: number): string => {
        const index = versions.findIndex((v) => v.id === id);
        const v = versions[index];
        return v ? `v${index + 1} · ${time(v.at)} · ${v.lines} lignes${v.id === latest ? ' (actuelle)' : ''}` : '';
    };

    return (
        <div className="spec-versions">
            <div className="spec-versions-head">
                <select value={fromId ?? ''} onChange={(e) => setFrom(Number(e.target.value))}>
                    {versions.map((v) => (
                        <option key={v.id} value={v.id}>
                            {label(v.id)}
                        </option>
                    ))}
                </select>
                <span className="muted">→</span>
                <select value={toId ?? ''} onChange={(e) => setTo(Number(e.target.value))}>
                    {versions.map((v) => (
                        <option key={v.id} value={v.id}>
                            {label(v.id)}
                        </option>
                    ))}
                </select>
                {(from !== null || to !== null) && (
                    <button
                        className="link small-link"
                        onClick={() => {
                            setFrom(null);
                            setTo(null);
                        }}
                    >
                        dernier changement
                    </button>
                )}
            </div>
            {!chunks && <div className="muted pad">chargement…</div>}
            {chunks?.length === 1 && chunks[0]?.kind === 'skipped' && <div className="muted pad">Aucune différence.</div>}
            {chunks && (
                <div className="line-diff">
                    {chunks.map((chunk, i) =>
                        chunk.kind === 'skipped' ? (
                            <div key={i} className="line-diff-skip muted">
                                ⋯ {chunk.count} ligne{chunk.count > 1 ? 's' : ''} inchangée{chunk.count > 1 ? 's' : ''}
                            </div>
                        ) : (
                            chunk.lines.map((line, j) => (
                                <div key={`${i}-${j}`} className={`line-diff-row ${line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}`}>
                                    <span className="line-diff-no">{line.oldLine ?? ''}</span>
                                    <span className="line-diff-no">{line.newLine ?? ''}</span>
                                    <span className="line-diff-text">
                                        {line.kind === ' ' ? ' ' : line.kind} {line.text}
                                    </span>
                                </div>
                            ))
                        ),
                    )}
                </div>
            )}
        </div>
    );
}

const TITLES: Partial<Record<Panel, string>> = { spec: 'Spec', versions: 'Versions', plan: 'Issues' };

/** Onglet spec : le chat, et à côté la spec en direct, ses versions ou son découpage en issues. */
export function SpecView({ run }: { run: Run }): ReactElement {
    const stored = useStore((s) => s.panels[run.id]);
    const setPanel = useStore((s) => s.setPanel);
    const spec = useSpec(run.id);
    // Par défaut, la spec est affichée ; `null` = panneau fermé.
    const panel = stored === undefined ? 'spec' : stored;
    const toggle = (next: Panel): void => setPanel(run.id, panel === next ? null : next);
    const lastWrite = spec?.versions.at(-1)?.at;

    const toolbar = (
        <>
            <OpenMenu path={run.cwd} runId={run.id} />
            {(['spec', 'versions', 'plan'] as const).map((p) => (
                <button key={p} className={panel === p ? 'active' : ''} onClick={() => toggle(p)}>
                    {p === 'versions' && spec ? `Versions (${spec.versions.length})` : TITLES[p]}
                </button>
            ))}
        </>
    );

    const subtitle = spec && (
        <span className="muted mono">
            {baseName(spec.path)}
            {lastWrite ? ` · écrit ${time(lastWrite)}` : ' · pas encore écrit'}
        </span>
    );

    const content = panel === 'spec' ? <SpecDoc run={run} spec={spec} /> : panel === 'versions' ? <SpecVersions spec={spec} /> : panel === 'plan' ? <SpecPlanPanel run={run} /> : null;

    return (
        <ChatView
            run={run}
            toolbar={toolbar}
            subtitle={subtitle}
            wide={panel === 'versions' || panel === 'plan'}
            panel={
                panel &&
                content && (
                    <>
                        <div className="panel-head">
                            <span>
                                {TITLES[panel]}
                                {panel === 'spec' && <span className="muted spec-hint"> · sélectionne un passage pour le commenter</span>}
                            </span>
                            <button className="small" onClick={() => setPanel(run.id, null)}>
                                ×
                            </button>
                        </div>
                        <div className="panel-body">{content}</div>
                    </>
                )
            }
        />
    );
}

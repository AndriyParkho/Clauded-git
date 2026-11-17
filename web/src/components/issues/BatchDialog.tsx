import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { Modal } from '../Modal';
import { withProgress } from '../Progress';
import type { BatchAnalysis, DependencySource, DependencyStatus, IssueDependency } from '../../../../shared/protocol';

const SOURCES: Record<DependencySource, string> = { github: 'GitHub', text: 'texte', subissue: 'sous-issue', claude: 'Claude', manual: 'ajoutée' };

const key = (d: Pick<IssueDependency, 'issue' | 'dependsOn'>): string => `${d.issue}<${d.dependsOn}`;

export interface PlannedIssue {
    number: number;
    /** 0 = démarre tout de suite ; n = après n niveaux de dépendances du lot. */
    wave: number;
    dependsOn: number[];
    /** Ce sur quoi la PR sera empilée, en clair. */
    stack: string | null;
    /** Dépendances hors sélection sans PR : l'issue attendra qu'elles en aient une. */
    waitsOutside: number[];
}

/** Plan de lancement, comme le fera le serveur : vagues, empilement, attentes ; erreur si cycle. */
export function planBatch(numbers: number[], dependencies: IssueDependency[], external: DependencyStatus[]): { plan: PlannedIssue[]; error: string | null } {
    const inBatch = new Set(numbers);
    const outside = new Map(external.map((e) => [e.number, e]));
    const waves = new Map<number, number>();
    const visiting = new Set<number>();
    let error: string | null = null;
    const wave = (n: number, path: number[]): number => {
        const known = waves.get(n);
        if (known !== undefined) return known;
        if (visiting.has(n)) {
            error ??= `Dépendances circulaires : ${[...path.slice(path.indexOf(n)), n].map((x) => `#${x}`).join(' → ')}`;
            return 0;
        }
        visiting.add(n);
        const deps = dependencies.filter((d) => d.issue === n);
        let w = deps.some((d) => !inBatch.has(d.dependsOn) && !outside.get(d.dependsOn)?.ready) ? 1 : 0;
        for (const d of deps) if (inBatch.has(d.dependsOn)) w = Math.max(w, wave(d.dependsOn, [...path, n]) + 1);
        visiting.delete(n);
        waves.set(n, w);
        return w;
    };
    const plan = numbers.map((n) => {
        const deps = [...new Set(dependencies.filter((d) => d.issue === n).map((d) => d.dependsOn))];
        const first = deps.find((d) => inBatch.has(d) || outside.get(d)?.openPr);
        const pr = first !== undefined ? outside.get(first)?.openPr : undefined;
        return {
            number: n,
            wave: wave(n, []),
            dependsOn: deps,
            stack: first === undefined ? null : pr ? `PR #${pr.number} (${pr.branch})` : `la future PR de #${first}`,
            waitsOutside: deps.filter((d) => !inBatch.has(d) && !outside.get(d)?.ready),
        };
    });
    return { plan: plan.sort((a, b) => a.wave - b.wave || a.number - b.number), error };
}

interface Props {
    repoId: number;
    numbers: number[];
    onAdd: (number: number) => void;
    onClose: () => void;
}

/**
 * Lancement de l'implémentation de plusieurs issues : dépendances détectées (modifiables), ordre
 * de lancement et PR empilées, puis lancement en lot.
 */
export function BatchDialog({ repoId, numbers, onAdd, onClose }: Props): ReactElement {
    const notify = useStore((s) => s.notify);
    const upsertRun = useStore((s) => s.upsertRun);
    const setActive = useStore((s) => s.setActive);
    const setIssues = useStore((s) => s.setIssues);
    const [analysis, setAnalysis] = useState<BatchAnalysis | null>(null);
    const [loading, setLoading] = useState<'github' | 'claude' | null>('github');
    const [error, setError] = useState<string | null>(null);
    const [manual, setManual] = useState<IssueDependency[]>([]);
    const [removed, setRemoved] = useState<Set<string>>(new Set());
    const [planMode, setPlanMode] = useState(false);
    const [adding, setAdding] = useState<number | null>(null);

    const analyze = useCallback(
        async (claude: boolean): Promise<void> => {
            setLoading(claude ? 'claude' : 'github');
            setError(null);
            try {
                setAnalysis(await api.dependencies(repoId, numbers, claude));
            } catch (e) {
                setError(String(e));
            } finally {
                setLoading(null);
            }
        },
        [repoId, numbers],
    );

    useEffect(() => {
        void analyze(false);
    }, [analyze]);

    const dependencies = useMemo(() => {
        const found = (analysis?.dependencies ?? []).filter((d) => !removed.has(key(d)));
        return [...found, ...manual.filter((m) => !found.some((d) => key(d) === key(m)))];
    }, [analysis, manual, removed]);
    const external = analysis?.external ?? [];
    const titles = new Map([...(analysis?.issues ?? []), ...external].map((i) => [i.number, i.title]));
    const { plan, error: cycle } = planBatch(numbers, dependencies, external);
    const startNow = plan.filter((p) => p.wave === 0).length;

    const remove = (d: IssueDependency): void => {
        setRemoved((s) => new Set(s).add(key(d)));
        setManual((list) => list.filter((m) => key(m) !== key(d)));
    };
    const addDependency = (issue: number, dependsOn: number): void => {
        setRemoved((s) => {
            const next = new Set(s);
            next.delete(key({ issue, dependsOn }));
            return next;
        });
        setManual((list) => [...list, { issue, dependsOn, source: 'manual' }]);
        setAdding(null);
    };

    const launch = async (): Promise<void> => {
        try {
            const result = await withProgress(`Implémentation de ${numbers.length} issues`, (opId) =>
                api.batch(repoId, { issues: numbers, dependencies: dependencies.map((d) => ({ issue: d.issue, dependsOn: d.dependsOn })), planMode, opId }),
            );
            for (const run of result.started) upsertRun(run);
            if (result.started[0]) setActive(result.started[0].id);
            const parts = [`${result.started.length} lancée${result.started.length > 1 ? 's' : ''}`];
            if (result.waiting.length) parts.push(`${result.waiting.length} en attente (${result.waiting.map((w) => `#${w.issueNumber}`).join(', ')}) : elles partiront quand la PR de leur dépendance sera ouverte`);
            if (result.failed.length) parts.push(`échec : ${result.failed.map((f) => `#${f.issueNumber} (${f.error})`).join(' ; ')}`);
            notify(parts.join(' · '));
            setIssues({ checked: null });
            onClose();
        } catch {
            // L'erreur reste affichée dans le loader.
        }
    };

    const sourceTitle = (d: IssueDependency): string => d.reason ?? (d.source === 'manual' ? 'ajoutée à la main' : SOURCES[d.source]);

    return (
        <Modal className="batch-modal" onClose={onClose}>
            <div className="batch-head">
                <strong>Implémenter {numbers.length} issues</strong>
                <span className="spacer" />
                <button className="small" onClick={onClose} title="Fermer">
                    ×
                </button>
            </div>
            <p className="muted batch-intro">
                Chaque issue a son worktree et son onglet. Les issues indépendantes démarrent tout de suite, en parallèle. Une issue qui dépend d'une autre attend que la PR de celle-ci soit ouverte, puis démarre sur sa branche :
                sa PR est empilée dessus (stacked PR) et GitHub la reciblera quand la première sera mergée.
            </p>

            {loading === 'github' && (
                <div className="batch-loading">
                    <span className="spinner small" /> Lecture des issues et de leurs relations sur GitHub…
                </div>
            )}
            {error && <div className="error pad">{error}</div>}

            {analysis && (
                <>
                    <ol className="batch-plan">
                        {plan.map((p) => (
                            <li key={p.number} className="batch-issue">
                                <div className="batch-issue-head">
                                    <span className={`batch-wave ${p.wave === 0 ? 'now' : 'later'}`}>{p.wave === 0 ? 'tout de suite' : 'ensuite'}</span>
                                    <span className="mono muted">#{p.number}</span>
                                    <span className="batch-title">{titles.get(p.number) ?? ''}</span>
                                </div>
                                <div className="batch-deps">
                                    {p.dependsOn.length === 0 && <span className="muted">aucune dépendance</span>}
                                    {dependencies
                                        .filter((d) => d.issue === p.number)
                                        .map((d) => (
                                            <span key={key(d)} className={`dep-chip ${numbers.includes(d.dependsOn) ? '' : 'outside'}`} title={sourceTitle(d)}>
                                                après #{d.dependsOn}
                                                <span className="dep-source">{SOURCES[d.source]}</span>
                                                <button className="link" onClick={() => remove(d)} title="Ignorer cette dépendance">
                                                    ×
                                                </button>
                                            </span>
                                        ))}
                                    {adding === p.number ? (
                                        <select autoFocus defaultValue="" onChange={(e) => e.target.value && addDependency(p.number, Number(e.target.value))} onBlur={() => setAdding(null)}>
                                            <option value="">dépend de…</option>
                                            {numbers
                                                .filter((n) => n !== p.number && !p.dependsOn.includes(n))
                                                .map((n) => (
                                                    <option key={n} value={n}>
                                                        #{n} {titles.get(n) ?? ''}
                                                    </option>
                                                ))}
                                        </select>
                                    ) : (
                                        numbers.length > 1 && (
                                            <button className="link small-link" onClick={() => setAdding(p.number)}>
                                                + dépendance
                                            </button>
                                        )
                                    )}
                                </div>
                                {(p.stack || p.waitsOutside.length > 0) && (
                                    <div className="muted batch-note">
                                        {p.waitsOutside.length > 0 && <>attend que {p.waitsOutside.map((n) => `#${n}`).join(', ')} ait une PR · </>}
                                        {p.stack && <>branche et PR empilées sur {p.stack}</>}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ol>

                    {external.length > 0 && (
                        <div className="batch-external">
                            <div className="batch-section">Hors sélection</div>
                            {external.map((e) => (
                                <div key={e.number} className="batch-external-row">
                                    <span className="mono muted">#{e.number}</span>
                                    <span className="batch-title">
                                        {e.kind === 'pr' ? 'PR · ' : ''}
                                        {e.title}
                                    </span>
                                    <span className="muted">{e.openPr ? `PR #${e.openPr.number} ouverte : les dépendantes s'empilent dessus` : 'ouverte, sans PR : les dépendantes attendront'}</span>
                                    {e.kind === 'issue' && !e.openPr && (
                                        <button className="small" onClick={() => onAdd(e.number)} title="L'implémenter dans ce lot">
                                            Ajouter
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {analysis.warnings.map((w) => (
                        <div key={w} className="muted batch-warning">
                            ⚠ {w}
                        </div>
                    ))}
                    {cycle && <div className="error batch-warning">{cycle} : retire une des dépendances.</div>}
                </>
            )}

            <div className="batch-actions">
                <button disabled={loading !== null} onClick={() => void analyze(true)} title="Claude lit les issues et repère les dépendances implicites (consomme un peu de quota)">
                    {loading === 'claude' ? (
                        <>
                            <span className="spinner small" /> Claude lit les issues…
                        </>
                    ) : (
                        'Demander à Claude'
                    )}
                </button>
                <span className="spacer" />
                <label className="muted check">
                    <input type="checkbox" checked={planMode} onChange={(e) => setPlanMode(e.target.checked)} /> plan d'abord
                </label>
                <button onClick={onClose}>Annuler</button>
                <button className="primary" disabled={!analysis || loading !== null || cycle !== null} onClick={() => void launch()}>
                    Lancer ({startNow} tout de suite{numbers.length - startNow > 0 ? `, ${numbers.length - startNow} ensuite` : ''})
                </button>
            </div>
        </Modal>
    );
}

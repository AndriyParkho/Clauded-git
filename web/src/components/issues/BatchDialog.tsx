import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { Modal } from '../Modal';
import { withProgress } from '../Progress';
import { ExistingBranchInfo, openBranchChat } from './ExistingBranch';
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
    /** Remplace la sélection par les sous-issues ouvertes d'une issue parente (son propre lot). */
    onOpenParent?: (parent: number, subIssues: number[]) => void;
    onClose: () => void;
}

/**
 * Lancement de l'implémentation de plusieurs issues : dépendances détectées (modifiables), ordre
 * de lancement et PR empilées, puis lancement en lot.
 */
export function BatchDialog({ repoId, numbers, onAdd, onOpenParent, onClose }: Props): ReactElement {
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
    /** Issues à branche existante qu'on relance quand même. */
    const [resume, setResume] = useState<Set<number>>(new Set());

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
        // Nouvelle sélection (lot d'une parente ouvert depuis celui-ci) : on repart de zéro.
        setManual([]);
        setRemoved(new Set());
        setResume(new Set());
        void analyze(false);
    }, [analyze]);

    const dependencies = useMemo(() => {
        const found = (analysis?.dependencies ?? []).filter((d) => !removed.has(key(d)));
        return [...found, ...manual.filter((m) => !found.some((d) => key(d) === key(m)))];
    }, [analysis, manual, removed]);
    const external = analysis?.external ?? [];
    const titles = new Map([...(analysis?.issues ?? []), ...external].map((i) => [i.number, i.title]));
    // Les issues parentes ne sont pas lancées : on lance leurs sous-issues à part.
    const parents = analysis?.parents ?? [];
    const parentNumbers = new Set(parents.map((p) => p.number));
    // Une issue qui a déjà une branche travaillée est écartée, sauf si on la reprend.
    const existing = analysis?.existing ?? [];
    const setAside = new Set(existing.filter((e) => !resume.has(e.number)).map((e) => e.number));
    const launchable = numbers.filter((n) => !parentNumbers.has(n) && !setAside.has(n));
    const { plan, error: cycle } = planBatch(launchable, dependencies, external);
    const ready = plan.filter((p) => p.wave === 0).length;
    const slots = analysis?.slots;
    const startNow = slots ? Math.min(ready, Math.max(0, slots.max - slots.busy)) : ready;
    // Dépendances qui touchent une parente, trouvées ailleurs que sur GitHub : écrites en « bloquée par ».
    const links = dependencies.filter((d) => (parentNumbers.has(d.issue) || parentNumbers.has(d.dependsOn)) && d.source !== 'github' && d.source !== 'subissue');

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
                api.batch(repoId, {
                    issues: launchable,
                    dependencies: dependencies.map((d) => ({ issue: d.issue, dependsOn: d.dependsOn })),
                    links: links.map((d) => ({ issue: d.issue, dependsOn: d.dependsOn })),
                    planMode,
                    opId,
                }),
            );
            for (const run of result.started) upsertRun(run);
            if (result.started[0]) setActive(result.started[0].id);
            const parts = [`${result.started.length} lancée${result.started.length > 1 ? 's' : ''}`];
            if (result.waiting.length) parts.push(`${result.waiting.length} en attente (${result.waiting.map((w) => `#${w.issueNumber}`).join(', ')}) : elles partiront d'elles-mêmes (PR de leur dépendance ouverte, ou place libérée)`);
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
                <strong>Implémenter {launchable.length} issue{launchable.length > 1 ? 's' : ''}</strong>
                <span className="spacer" />
                <button className="small" onClick={onClose} title="Fermer">
                    ×
                </button>
            </div>
            <p className="muted batch-intro">
                Chaque issue a son worktree et son onglet. Les issues indépendantes démarrent tout de suite, en parallèle. Une issue qui dépend d'une autre attend que la PR de celle-ci soit ouverte, puis démarre sur sa branche :
                sa PR est empilée dessus (stacked PR) et GitHub la reciblera quand la première sera mergée.
                {slots && ` Au plus ${slots.max} implémentations en même temps : les suivantes partent seules dès qu'une place se libère.`}
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
                                        {[
                                            ...(p.waitsOutside.length > 0
                                                ? [`attend ${p.waitsOutside.map((n) => (parentNumbers.has(n) || external.find((e) => e.number === n)?.openSubIssues ? `que #${n} (parente) soit fermée` : `que #${n} ait une PR`)).join(', ')}`]
                                                : []),
                                            ...(p.stack ? [`branche et PR empilées sur ${p.stack}`] : []),
                                        ].join(' · ')}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ol>

                    {parents.length > 0 && (
                        <div className="batch-external">
                            <div className="batch-section">Issues parentes, lancées à part</div>
                            {parents.map((p) => {
                                const deps = dependencies.filter((d) => d.issue === p.number && !(d.source === 'subissue'));
                                return (
                                    <div key={p.number} className="batch-external-row">
                                        <span className="mono muted">#{p.number}</span>
                                        <span className="batch-title">{p.title}</span>
                                        <span className="muted">
                                            {p.openSubIssues.length} sous-issue{p.openSubIssues.length > 1 ? 's' : ''} ouverte{p.openSubIssues.length > 1 ? 's' : ''}
                                            {deps.length > 0 && ` · après ${deps.map((d) => `#${d.dependsOn}`).join(', ')}`}
                                        </span>
                                        {onOpenParent && (
                                            <button className="small" onClick={() => onOpenParent(p.number, p.openSubIssues)} title="Ouvre le lot de ses sous-issues à la place de celui-ci">
                                                Implémenter ses sous-issues
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                            <div className="muted batch-note">
                                Ses sous-issues reprennent ses dépendances quand tu les lances.
                                {links.length > 0 && ` Au lancement, ${links.map((d) => `#${d.issue} bloquée par #${d.dependsOn}`).join(', ')} ${links.length > 1 ? 'seront écrites' : 'sera écrite'} sur GitHub pour ne pas se perdre.`}
                            </div>
                        </div>
                    )}

                    {existing.length > 0 && (
                        <div className="batch-external">
                            <div className="batch-section">Déjà une branche</div>
                            {existing.map((e) => (
                                <div key={e.number} className="batch-external-row existing-row">
                                    <span className="mono muted">#{e.number}</span>
                                    <span className="batch-title">
                                        {titles.get(e.number) ?? ''}
                                        <br />
                                        <ExistingBranchInfo branch={e.branch} />
                                    </span>
                                    <label className="muted check" title="Relance une session d'implémentation sur cette branche, qui part du travail déjà fait">
                                        <input
                                            type="checkbox"
                                            checked={resume.has(e.number)}
                                            onChange={(event) =>
                                                setResume((current) => {
                                                    const next = new Set(current);
                                                    if (event.target.checked) next.add(e.number);
                                                    else next.delete(e.number);
                                                    return next;
                                                })
                                            }
                                        />{' '}
                                        reprendre
                                    </label>
                                    <button className="small" onClick={() => void openBranchChat(repoId, e.number).then(onClose, () => undefined)} title="Onglet dans son worktree pour faire le point, sans rien relancer">
                                        Ouvrir un chat
                                    </button>
                                </div>
                            ))}
                            <div className="muted batch-note">Écartées du lot : du travail existe déjà. Ce qui en dépend s'empile sur leur PR si elle est ouverte, sinon attend.</div>
                        </div>
                    )}

                    {external.filter((e) => !numbers.includes(e.number)).length > 0 && (
                        <div className="batch-external">
                            <div className="batch-section">Hors sélection</div>
                            {external.filter((e) => !numbers.includes(e.number)).map((e) => (
                                <div key={e.number} className="batch-external-row">
                                    <span className="mono muted">#{e.number}</span>
                                    <span className="batch-title">
                                        {e.kind === 'pr' ? 'PR · ' : ''}
                                        {e.title}
                                    </span>
                                    <span className="muted">
                                        {e.openPr
                                            ? `PR #${e.openPr.number} ouverte : les dépendantes s'empilent dessus`
                                            : e.openSubIssues
                                              ? `issue parente (${e.openSubIssues} sous-issue${e.openSubIssues > 1 ? 's' : ''} ouverte${e.openSubIssues > 1 ? 's' : ''}) : les dépendantes attendent qu'elle soit fermée`
                                              : 'ouverte, sans PR : les dépendantes attendront'}
                                    </span>
                                    {e.kind === 'issue' && !e.openPr && !e.openSubIssues && !parentNumbers.has(e.number) && (
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
                <button className="primary" disabled={!analysis || loading !== null || cycle !== null || launchable.length === 0} onClick={() => void launch()}>
                    Lancer ({startNow} tout de suite{launchable.length - startNow > 0 ? `, ${launchable.length - startNow} ensuite` : ''})
                </button>
            </div>
        </Modal>
    );
}

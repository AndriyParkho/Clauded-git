import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import { BatchDialog } from '../issues/BatchDialog';
import { withProgress } from '../Progress';
import type { Run, SpecIssue, SpecPlan } from '../../../../shared/protocol';

const SAVE_DELAY_MS = 600;

/** Cycle dans les dépendances des issues cochées, décrit (`a → b → a`), ou `null`. */
export function planCycle(issues: SpecIssue[]): string | null {
    const included = issues.filter((i) => i.include);
    const byKey = new Map(included.map((i) => [i.key, i]));
    const state = new Map<string, 'visiting' | 'done'>();
    let found: string | null = null;
    const visit = (issue: SpecIssue, path: string[]): void => {
        if (found || state.get(issue.key) === 'done') return;
        if (state.get(issue.key) === 'visiting') {
            found = [...path.slice(path.indexOf(issue.key)), issue.key].join(' → ');
            return;
        }
        state.set(issue.key, 'visiting');
        for (const dep of issue.dependsOn) {
            const target = byKey.get(dep);
            if (target) visit(target, [...path, issue.key]);
        }
        state.set(issue.key, 'done');
    };
    for (const issue of included) visit(issue, []);
    return found;
}

function IssueCard({ issue, keys, onChange, parent }: { issue: SpecIssue; keys: SpecIssue[]; onChange: (next: SpecIssue) => void; parent?: boolean }): ReactElement {
    const [open, setOpen] = useState(false);
    const [adding, setAdding] = useState(false);
    const created = issue.number !== null;
    const candidates = keys.filter((k) => k.key !== issue.key && !issue.dependsOn.includes(k.key));
    return (
        <li className={`plan-issue ${issue.include ? '' : 'excluded'} ${parent ? 'parent' : ''}`}>
            <div className="plan-issue-head">
                <input type="checkbox" checked={issue.include} disabled={created} onChange={(e) => onChange({ ...issue, include: e.target.checked })} title={created ? 'Déjà créée' : 'Créer cette issue'} />
                <span className="plan-key mono">{parent ? 'parente' : issue.key}</span>
                <input className="plan-title" value={issue.title} disabled={created} onChange={(e) => onChange({ ...issue, title: e.target.value })} />
                {created && issue.url && (
                    <a className="mono" href={issue.url} target="_blank" rel="noreferrer">
                        #{issue.number} ↗
                    </a>
                )}
                <button className="link small-link" onClick={() => setOpen(!open)}>
                    {open ? 'replier' : 'corps'}
                </button>
            </div>
            {!parent && (
                <div className="batch-deps">
                    {issue.dependsOn.length === 0 && <span className="muted">aucune dépendance</span>}
                    {issue.dependsOn.map((dep) => (
                        <span key={dep} className="dep-chip">
                            après {dep}
                            {!created && (
                                <button className="link" onClick={() => onChange({ ...issue, dependsOn: issue.dependsOn.filter((d) => d !== dep) })} title="Retirer cette dépendance">
                                    ×
                                </button>
                            )}
                        </span>
                    ))}
                    {!created &&
                        candidates.length > 0 &&
                        (adding ? (
                            <select
                                autoFocus
                                defaultValue=""
                                onBlur={() => setAdding(false)}
                                onChange={(e) => {
                                    if (e.target.value) onChange({ ...issue, dependsOn: [...issue.dependsOn, e.target.value] });
                                    setAdding(false);
                                }}
                            >
                                <option value="">dépend de…</option>
                                {candidates.map((k) => (
                                    <option key={k.key} value={k.key}>
                                        {k.key} · {k.title}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <button className="link small-link" onClick={() => setAdding(true)}>
                                + dépendance
                            </button>
                        ))}
                </div>
            )}
            {open && <textarea className="plan-body" value={issue.body} disabled={created} rows={12} onChange={(e) => onChange({ ...issue, body: e.target.value })} />}
        </li>
    );
}

/**
 * Découpage de la spec en issues : Claude l'écrit dans un fichier que l'app importe, tu le corriges
 * ici (titres, corps, dépendances, issues à écarter), puis l'app crée les issues sur GitHub et peut
 * lancer leur implémentation en lot.
 */
export function SpecPlanPanel({ run }: { run: Run }): ReactElement {
    const stored = useStore((s) => s.specPlans[run.id]);
    const allRepos = useStore((s) => s.repos);
    const notify = useStore((s) => s.notify);
    const [plan, setPlan] = useState<SpecPlan | undefined>(stored);
    const dirty = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const [asking, setAsking] = useState(false);
    const [batch, setBatch] = useState<number[] | null>(null);
    const repos = allRepos.filter((r) => r.owner);

    useEffect(() => {
        api.specPlan(run.id)
            .then((loaded) => useStore.setState((s) => ({ specPlans: { ...s.specPlans, [run.id]: loaded } })))
            .catch((e: unknown) => notify(String(e), run.id));
    }, [run.id, notify]);

    // Un nouveau découpage (ou la création des issues) remplace la copie locale, sauf modification en cours.
    useEffect(() => {
        if (stored && !dirty.current) setPlan(stored);
    }, [stored]);

    const save = useCallback(
        async (next: SpecPlan): Promise<void> => {
            clearTimeout(timer.current);
            try {
                await api.saveSpecPlan(run.id, { repoId: next.repoId, parent: next.parent, issues: next.issues });
            } catch (error) {
                notify(String(error), run.id);
            } finally {
                dirty.current = false;
            }
        },
        [run.id, notify],
    );

    const edit = (next: SpecPlan): void => {
        setPlan(next);
        dirty.current = true;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void save(next), SAVE_DELAY_MS);
    };

    useEffect(() => () => clearTimeout(timer.current), []);

    const ask = async (): Promise<void> => {
        setAsking(true);
        try {
            await api.generateSpecPlan(run.id);
        } catch (error) {
            notify(String(error), run.id);
        } finally {
            setAsking(false);
        }
    };

    const create = async (): Promise<void> => {
        if (!plan) return;
        if (dirty.current) await save(plan);
        try {
            const result = await withProgress('Création des issues sur GitHub', (opId) => api.createSpecIssues(run.id, opId));
            setPlan(result.plan);
            for (const warning of result.warnings) notify(warning, run.id);
        } catch {
            // L'erreur reste affichée dans le loader ; les issues déjà créées sont enregistrées.
        }
    };

    if (!plan) return <div className="muted pad">chargement…</div>;

    const included = plan.issues.filter((i) => i.include);
    const toCreate = included.filter((i) => i.number === null).length + (plan.parent?.include && plan.parent.number === null ? 1 : 0);
    const created = included.filter((i) => i.number !== null).map((i) => i.number as number);
    const cycle = planCycle(plan.issues);
    const empty = plan.issues.length === 0 && !plan.parent;
    const updateIssue = (next: SpecIssue): void => edit({ ...plan, issues: plan.issues.map((i) => (i.key === next.key ? next : i)) });

    return (
        <div className="spec-plan">
            <div className="spec-plan-head">
                <label className="muted">
                    Dépôt :{' '}
                    <select value={plan.repoId ?? ''} onChange={(e) => edit({ ...plan, repoId: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">choisir…</option>
                        {repos.map((r) => (
                            <option key={r.id} value={r.id}>
                                {r.owner}/{r.name}
                            </option>
                        ))}
                    </select>
                </label>
                <span className="spacer" />
                <button disabled={asking || run.state === 'running'} onClick={() => void ask()} title="Claude découpe la spec et écrit le résultat dans un fichier que l'app importe ici">
                    {empty ? 'Demander le découpage à Claude' : 'Redemander le découpage'}
                </button>
            </div>

            {empty && (
                <p className="muted pad">
                    Quand la spec est prête, demande le découpage : Claude propose une issue parente et ses sous-issues avec leurs dépendances et critères d'acceptation, dans <span className="mono">{plan.file}</span>. Il apparaît ici dès
                    qu'il est écrit ; tu le corriges avant de créer quoi que ce soit.
                </p>
            )}
            {!empty && plan.importedAt && <div className="muted small-link spec-plan-meta">Découpage importé le {new Date(plan.importedAt).toLocaleString('fr-FR')}. Tes corrections sont enregistrées au fil de l'eau.</div>}

            {!empty && (
                <ol className="plan-list">
                    {plan.parent && <IssueCard parent issue={plan.parent} keys={[]} onChange={(next) => edit({ ...plan, parent: next })} />}
                    {plan.issues.map((issue) => (
                        <IssueCard key={issue.key} issue={issue} keys={plan.issues} onChange={updateIssue} />
                    ))}
                </ol>
            )}

            {cycle && <div className="error pad">Dépendances circulaires : {cycle}. Retire une des dépendances.</div>}

            {!empty && (
                <div className="batch-actions spec-plan-actions">
                    <span className="muted">
                        {included.length} sous-issue{included.length > 1 ? 's' : ''} cochée{included.length > 1 ? 's' : ''}
                        {created.length > 0 && `, ${created.length} déjà créée${created.length > 1 ? 's' : ''}`}
                    </span>
                    <span className="spacer" />
                    {created.length > 0 && plan.repoId !== null && (
                        <button onClick={() => setBatch(created)} title="Ouvre le lancement en lot : dépendances, ordre, PR empilées">
                            Implémenter tout ({created.length})
                        </button>
                    )}
                    <button className="primary" disabled={toCreate === 0 || plan.repoId === null || cycle !== null} onClick={() => void create()} title="Issues assignées à toi ; la parente reçoit les autres comme sous-issues, les dépendances deviennent des liens « bloquée par »">
                        Créer {toCreate} issue{toCreate > 1 ? 's' : ''} sur GitHub
                    </button>
                </div>
            )}

            {batch && plan.repoId !== null && <BatchDialog repoId={plan.repoId} numbers={batch} onAdd={(n) => setBatch([...batch, n])} onOpenParent={(_parent, subs) => setBatch(subs)} onClose={() => setBatch(null)} />}
        </div>
    );
}

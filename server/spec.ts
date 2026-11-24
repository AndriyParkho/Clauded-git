import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DATA_DIR } from './config.js';
import { getRepo, getRun, getSpecPlanRow, getSpecVersion, insertRun, insertSpecVersion, latestSpecVersion, listSpecRuns, listSpecVersions, saveSpecPlanRow } from './db.js';
import { exec } from './exec.js';
import { graphql, issueNodeIds, repoSlug } from './github.js';
import { Progress } from './progress.js';
import { watchDirectory, type Closable } from './watch.js';
import { sessions } from './sessions/manager.js';
import type { Repo, Run, SpecFile, SpecIssue, SpecPlan } from '../shared/protocol.js';

const SPECS_DIR = join(DATA_DIR, 'specs');
const DEFAULT_FILE = 'SPEC.md';

// ---------------------------------------------------------------------------------------------
// Création d'un onglet spec
// ---------------------------------------------------------------------------------------------

export interface NewSpec {
    /** Dépôt où écrire la spec ; sinon `cwd`. */
    repoId?: number;
    /** Dossier (créé s'il n'existe pas) quand la spec ne part pas d'un dépôt. */
    cwd?: string;
    /** Fichier de spec, relatif au dossier (`SPEC.md` par défaut). */
    file?: string;
}

function expand(path: string): string {
    return path.startsWith('~') ? path.replace('~', process.env.HOME ?? '') : path;
}

/** Ouvre un onglet spec : le dossier est créé au besoin, la session démarre, la consigne attend dans la saisie. */
export async function startSpec(input: NewSpec): Promise<{ run: Run; draft: string }> {
    const repo = input.repoId !== undefined ? getRepo(input.repoId) : undefined;
    if (input.repoId !== undefined && !repo) throw new Error('dépôt introuvable');
    const raw = repo?.path ?? input.cwd?.trim();
    if (!raw) throw new Error('choisis un dépôt ou un dossier');
    const cwd = resolve(expand(raw));
    await mkdir(cwd, { recursive: true });
    const file = input.file?.trim() || DEFAULT_FILE;
    const specPath = isAbsolute(file) ? file : resolve(cwd, file);
    const existing = await readFile(specPath, 'utf8').catch(() => null);

    const run = insertRun({ repoId: repo?.id ?? null, type: 'spec', cwd, title: `Spec · ${repo?.name ?? basename(cwd)}`, specPath });
    await sessions.open(run.id);
    await specWatcher.watchRun(run.id);
    return { run: getRun(run.id) ?? run, draft: specPrompt(cwd, specPath, existing !== null) };
}

/** Consigne de départ, placée dans la saisie : la première ligne attend l'idée. */
export function specPrompt(cwd: string, specPath: string, exists: boolean): string {
    const shown = relative(cwd, specPath).startsWith('..') ? specPath : relative(cwd, specPath);
    return [
        "L'idée : ",
        '',
        `On écrit ensemble la spec de cette idée dans \`${shown}\`${exists ? ' (le fichier existe déjà : lis-le d\'abord et pars de là)' : ''}.`,
        '',
        "- Pose-moi d'abord les questions qui manquent pour cadrer (le problème, qui s'en sert, ce qui est hors sujet), puis écris.",
        `- Tiens \`${shown}\` à jour à chaque échange : je le vois rendu en direct à côté du chat (markdown, diagrammes en blocs \`\`\`mermaid).`,
        '- Marque les points qui attendent ma décision **[à trancher]**.',
        '- Mes retours citent souvent un passage de la spec (bloc `>`) : modifie ce passage-là, pas le reste.',
        "- Ne crée aucune issue sur GitHub : l'app s'en charge quand la spec est prête.",
    ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Fichier de spec : contenu en direct et versions
// ---------------------------------------------------------------------------------------------

function specRun(runId: number): Run & { specPath: string } {
    const run = getRun(runId);
    if (!run || run.type !== 'spec' || !run.specPath) throw new Error('onglet spec introuvable');
    return run as Run & { specPath: string };
}

export async function readSpec(runId: number): Promise<SpecFile> {
    const run = specRun(runId);
    const content = await readFile(run.specPath, 'utf8').catch(() => null);
    return { runId, path: run.specPath, content, versions: listSpecVersions(runId) };
}

export function specVersionContent(versionId: number): string {
    const version = getSpecVersion(versionId);
    if (!version) throw new Error('version introuvable');
    return version.content;
}

// ---------------------------------------------------------------------------------------------
// Découpage en issues : fichier écrit par la session, importé, modifié, puis créé sur GitHub
// ---------------------------------------------------------------------------------------------

export function planFile(runId: number): string {
    return join(SPECS_DIR, `run-${runId}.issues.json`);
}

export function getPlan(runId: number): SpecPlan {
    const run = specRun(runId);
    const row = getSpecPlanRow(runId);
    const data = row ? (JSON.parse(row.data) as { parent: SpecIssue | null; issues: SpecIssue[] }) : { parent: null, issues: [] };
    return { runId, file: planFile(runId), repoId: row ? row.repoId : run.repoId, parent: data.parent, issues: data.issues, importedAt: row?.importedAt ?? null };
}

function savePlan(plan: SpecPlan, imported?: { at: string; mtime: number }): SpecPlan {
    const previous = getSpecPlanRow(plan.runId);
    saveSpecPlanRow(plan.runId, {
        repoId: plan.repoId,
        data: JSON.stringify({ parent: plan.parent, issues: plan.issues }),
        importedAt: imported?.at ?? previous?.importedAt ?? null,
        importedMtime: imported?.mtime ?? previous?.importedMtime ?? null,
    });
    return getPlan(plan.runId);
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Clé propre et unique (`API v2` → `api-v2`, `api-v2-2` si déjà prise). */
function uniqueKey(raw: string, taken: Set<string>, fallback: string): string {
    const base =
        raw
            .trim()
            .toLowerCase()
            .replace(/[^\w-]+/g, '-')
            .replace(/^-+|-+$/g, '') || fallback;
    let key = base;
    for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
    taken.add(key);
    return key;
}

/**
 * Lit le JSON écrit par la session (`{ parent, issues: [{ key, title, body, dependsOn }] }`). Tolérant :
 * clés manquantes ou en double renommées, dépendances inconnues ignorées.
 */
export function parsePlan(raw: unknown): { parent: SpecIssue | null; issues: SpecIssue[] } {
    if (!raw || typeof raw !== 'object') throw new Error('le découpage doit être un objet JSON');
    const data = raw as { parent?: unknown; issues?: unknown };
    if (!Array.isArray(data.issues)) throw new Error('`issues` doit être un tableau');
    const taken = new Set<string>(['parent']);
    const renamed = new Map<string, string>();
    const issues: SpecIssue[] = [];
    data.issues.forEach((item: unknown, index) => {
        const entry = (item ?? {}) as { key?: unknown; title?: unknown; body?: unknown; dependsOn?: unknown };
        const title = str(entry.title).trim();
        if (!title) return;
        const original = str(entry.key) || String(index + 1);
        const key = uniqueKey(original, taken, `issue-${index + 1}`);
        if (!renamed.has(original)) renamed.set(original, key);
        const dependsOn = Array.isArray(entry.dependsOn) ? entry.dependsOn.map((d) => String(d)) : [];
        issues.push({ key, title, body: str(entry.body), dependsOn, include: true, number: null, url: null });
    });
    const keys = new Set(issues.map((i) => i.key));
    for (const issue of issues) {
        issue.dependsOn = [...new Set(issue.dependsOn.map((d) => renamed.get(d) ?? d).filter((d) => keys.has(d) && d !== issue.key))];
    }
    const parentRaw = data.parent as { title?: unknown; body?: unknown } | null | undefined;
    const parentTitle = str(parentRaw?.title).trim();
    const parent: SpecIssue | null = parentTitle ? { key: 'parent', title: parentTitle, body: str(parentRaw?.body), dependsOn: [], include: true, number: null, url: null } : null;
    return { parent, issues };
}

/** Un nouveau découpage garde les issues déjà créées (même clé, ou même titre). */
export function mergeCreated(next: { parent: SpecIssue | null; issues: SpecIssue[] }, previous: SpecPlan): { parent: SpecIssue | null; issues: SpecIssue[] } {
    const created = [...(previous.parent ? [previous.parent] : []), ...previous.issues].filter((i) => i.number !== null);
    const keep = (issue: SpecIssue): SpecIssue => {
        const same = created.find((c) => c.key === issue.key) ?? created.find((c) => c.title.trim().toLowerCase() === issue.title.trim().toLowerCase());
        return same ? { ...issue, number: same.number, url: same.url } : issue;
    };
    return { parent: next.parent ? keep(next.parent) : null, issues: next.issues.map(keep) };
}

/** Importe le fichier de découpage s'il a changé depuis le dernier import. */
export async function importPlanFile(runId: number): Promise<SpecPlan | undefined> {
    const path = planFile(runId);
    const info = await stat(path).catch(() => undefined);
    if (!info) return undefined;
    const row = getSpecPlanRow(runId);
    if (row?.importedMtime != null && info.mtimeMs <= row.importedMtime) return undefined;
    let parsed: { parent: SpecIssue | null; issues: SpecIssue[] };
    try {
        parsed = parsePlan(JSON.parse(await readFile(path, 'utf8')));
    } catch {
        // Fichier en cours d'écriture, ou invalide : le prochain événement le relira.
        return undefined;
    }
    const previous = getPlan(runId);
    return savePlan({ ...previous, ...mergeCreated(parsed, previous) }, { at: new Date().toISOString(), mtime: info.mtimeMs });
}

/** Modifications faites dans l'app (titres, corps, dépendances, issues décochées, dépôt cible). */
export function updatePlan(runId: number, patch: { repoId?: number | null; parent?: SpecIssue | null; issues?: SpecIssue[] }): SpecPlan {
    const plan = getPlan(runId);
    if (patch.repoId !== undefined) plan.repoId = patch.repoId;
    if (patch.parent !== undefined) plan.parent = patch.parent;
    if (patch.issues !== undefined) {
        const keys = new Set(patch.issues.map((i) => i.key));
        plan.issues = patch.issues.map((i) => ({ ...i, dependsOn: i.dependsOn.filter((d) => keys.has(d) && d !== i.key) }));
    }
    return savePlan(plan);
}

/** Consigne envoyée à la session pour qu'elle écrive le découpage dans le fichier de l'app. */
export function planPrompt(run: Run, repo: Repo | undefined, file: string): string {
    const spec = run.specPath ? (relative(run.cwd, run.specPath).startsWith('..') ? run.specPath : relative(run.cwd, run.specPath)) : DEFAULT_FILE;
    return [
        `Découpe la spec \`${spec}\` en issues GitHub${repo?.owner ? ` pour ${repo.owner}/${repo.name}` : ''}.`,
        '',
        `**Ne crée aucune issue toi-même.** Écris le découpage dans \`${file}\` (écrase le fichier s'il existe) : l'app me le montre, je le corrige, puis elle crée les issues avec les liens parent/enfant et « bloquée par ».`,
        '',
        '```json',
        '{',
        '  "parent": { "title": "…", "body": "…" },',
        '  "issues": [',
        '    { "key": "api", "title": "…", "body": "…", "dependsOn": [] },',
        '    { "key": "ui", "title": "…", "body": "…", "dependsOn": ["api"] }',
        '  ]',
        '}',
        '```',
        '',
        "- `parent` : l'issue qui chapeaute (objectif, contexte, décisions clés de la spec) ; `null` si une seule issue suffit.",
        "- Une issue = une PR raisonnable, livrable et vérifiable seule. Son `body` (markdown) se suffit à lui-même : contexte utile, ce qu'il faut faire, et une section « Critères d'acceptation » en cases à cocher. Celui qui l'implémentera ne lira pas forcément la spec.",
        "- `key` : identifiant court et unique. `dependsOn` : les clés des issues qui doivent être faites avant, sans cycle. Ne mets une dépendance que si elle est réelle : les issues indépendantes seront implémentées en parallèle, chacune dans sa branche.",
        '- Titres et corps dans la langue de la spec.',
        '- Si je te demande de revoir le découpage, réécris le fichier en entier.',
        '',
        'Termine par un résumé court : les issues, leurs dépendances, et ce que tu as laissé de côté.',
    ].join('\n');
}

export async function generatePlan(runId: number): Promise<void> {
    const run = specRun(runId);
    const plan = getPlan(runId);
    const repo = plan.repoId !== null ? getRepo(plan.repoId) : undefined;
    await mkdir(SPECS_DIR, { recursive: true });
    await sessions.prompt(runId, planPrompt(run, repo, plan.file));
}

/** Ordre de création : chaque issue après celles dont elle dépend ; erreur si cycle. */
export function creationOrder(issues: SpecIssue[]): SpecIssue[] {
    const byKey = new Map(issues.map((i) => [i.key, i]));
    const order: SpecIssue[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (issue: SpecIssue, path: string[]): void => {
        const seen = state.get(issue.key);
        if (seen === 'done') return;
        if (seen === 'visiting') throw new Error(`dépendances circulaires : ${[...path.slice(path.indexOf(issue.key)), issue.key].join(' → ')}`);
        state.set(issue.key, 'visiting');
        for (const dep of issue.dependsOn) {
            const target = byKey.get(dep);
            if (target) visit(target, [...path, issue.key]);
        }
        state.set(issue.key, 'done');
        order.push(issue);
    };
    for (const issue of issues) visit(issue, []);
    return order;
}

async function ghCreateIssue(repo: Repo, title: string, body: string): Promise<{ number: number; url: string }> {
    await mkdir(SPECS_DIR, { recursive: true });
    const bodyFile = join(SPECS_DIR, `.body-${randomUUID()}.md`);
    await writeFile(bodyFile, body);
    try {
        const args = ['issue', 'create', '--repo', repoSlug(repo), '--title', title, '--body-file', bodyFile];
        let result = await exec('gh', [...args, '--assignee', '@me'], { cwd: repo.path });
        // Sans droit d'assignation sur le dépôt : créée quand même, sans assignee.
        if (result.code !== 0 && /assign/i.test(result.stderr)) result = await exec('gh', args, { cwd: repo.path });
        if (result.code !== 0) throw new Error(`gh issue create a échoué : ${result.stderr.trim() || result.stdout.trim()}`);
        const url = result.stdout.trim().split('\n').at(-1) ?? '';
        const match = /\/issues\/(\d+)/.exec(url);
        if (!match) throw new Error(`gh issue create : réponse inattendue (${url})`);
        return { number: Number(match[1]), url };
    } finally {
        await unlink(bodyFile).catch(() => undefined);
    }
}


/**
 * Crée sur GitHub les issues cochées qui ne le sont pas encore : la parente, puis les autres dans
 * l'ordre des dépendances (le corps cite les numéros), assignées à moi. Ensuite, liens parent/enfant
 * et « bloquée par ». Chaque numéro est enregistré dès sa création : relancer ne crée pas de doublon.
 */
export async function createPlanIssues(runId: number, opId: string | undefined): Promise<{ plan: SpecPlan; warnings: string[] }> {
    const progress = new Progress(opId);
    return progress.run(async () => {
        let plan = getPlan(runId);
        if (plan.repoId === null) throw new Error('choisis le dépôt où créer les issues');
        const repo = getRepo(plan.repoId);
        if (!repo?.owner) throw new Error('dépôt sans remote GitHub');
        const included = plan.issues.filter((i) => i.include);
        const order = creationOrder(included);
        const parent = plan.parent?.include ? plan.parent : null;
        // Tout existe déjà : seuls les liens sont refaits (utile si une première passe a échoué dessus).
        const toCreate = [...(parent && parent.number === null ? [parent] : []), ...order.filter((i) => i.number === null)];
        progress.plan([...toCreate.map((i) => `Création : ${i.title}`), 'Liens parent/enfant et dépendances']);

        const numberOf = (key: string): number | null => (key === 'parent' ? (plan.parent?.number ?? null) : (plan.issues.find((i) => i.key === key)?.number ?? null));
        for (const issue of toCreate) {
            progress.step(`Création : ${issue.title}`);
            const deps = issue.dependsOn.map(numberOf).filter((n): n is number => n !== null);
            const body = deps.length ? `${issue.body.trimEnd()}\n\n---\nDépend de ${deps.map((n) => `#${n}`).join(', ')}.` : issue.body;
            const created = await ghCreateIssue(repo, issue.title, body);
            progress.detail(`#${created.number}`);
            // Enregistré tout de suite : une erreur plus loin ne fait pas recréer celle-ci.
            if (issue.key === 'parent' && plan.parent) plan = savePlan({ ...plan, parent: { ...plan.parent, ...created } });
            else plan = savePlan({ ...plan, issues: plan.issues.map((i) => (i.key === issue.key ? { ...i, ...created } : i)) });
            specWatcher.emit('plan', plan);
        }

        progress.step('Liens parent/enfant et dépendances');
        const warnings: string[] = [];
        const children = plan.issues.filter((i) => i.include && i.number !== null) as Array<SpecIssue & { number: number }>;
        const parentNumber = parent ? plan.parent?.number ?? null : null;
        const ids = await issueNodeIds(repo, [...(parentNumber !== null ? [parentNumber] : []), ...children.map((c) => c.number)]);
        for (const child of children) {
            const childId = ids.get(child.number);
            if (!childId) continue;
            if (parentNumber !== null) {
                const parentId = ids.get(parentNumber);
                if (parentId) {
                    await graphql(`mutation($parent: ID!, $child: ID!) { addSubIssue(input: { issueId: $parent, subIssueId: $child }) { issue { number } } }`, { parent: parentId, child: childId }).catch((error: unknown) => {
                        // Déjà sous-issue (relance) : pas un problème.
                        if (!/already|duplicate/i.test(String(error))) warnings.push(`#${child.number} → sous-issue de #${parentNumber} : ${String(error)}`);
                    });
                }
            }
            for (const dep of child.dependsOn) {
                const depNumber = numberOf(dep);
                const depId = depNumber !== null ? ids.get(depNumber) : undefined;
                if (!depId) continue;
                await graphql(`mutation($issue: ID!, $blocking: ID!) { addBlockedBy(input: { issueId: $issue, blockingIssueId: $blocking }) { issue { number } } }`, { issue: childId, blocking: depId }).catch((error: unknown) => {
                    if (!/already|duplicate/i.test(String(error))) warnings.push(`#${child.number} bloquée par #${depNumber} : ${String(error)}`);
                });
            }
        }
        if (warnings.length) progress.detail(`${warnings.length} lien(s) refusé(s) : les dépendances restent écrites dans le corps des issues`);
        return { plan, warnings };
    });
}

// ---------------------------------------------------------------------------------------------
// Surveillance : fichiers de spec (versions) et fichiers de découpage
// ---------------------------------------------------------------------------------------------

const PLAN_FILE = /^run-(\d+)\.issues\.json$/;

export class SpecWatcher extends EventEmitter<{ spec: [SpecFile]; plan: [SpecPlan] }> {
    private readonly files = new Map<number, Closable>();
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private plans: Closable | undefined;

    async start(): Promise<void> {
        await mkdir(SPECS_DIR, { recursive: true });
        this.plans = watchDirectory(
            SPECS_DIR,
            (name) => {
                const runId = Number(PLAN_FILE.exec(name)?.[1]);
                this.debounce(`plan:${runId}`, 300, async () => {
                    const plan = await importPlanFile(runId).catch(() => undefined);
                    if (plan) this.emit('plan', plan);
                });
            },
            (name) => PLAN_FILE.test(name),
        );
        for (const run of listSpecRuns()) if (!run.archived) await this.watchRun(run.id).catch(() => undefined);
    }

    stop(): void {
        this.plans?.close();
        for (const watcher of this.files.values()) watcher.close();
        this.files.clear();
    }

    /** Suit le fichier de spec d'un onglet (idempotent) et enregistre sa version actuelle. */
    async watchRun(runId: number): Promise<void> {
        if (this.files.has(runId)) return;
        const run = getRun(runId);
        if (!run || run.type !== 'spec' || !run.specPath) return;
        const name = basename(run.specPath);
        const dir = dirname(run.specPath);
        await mkdir(dir, { recursive: true });
        this.files.set(
            runId,
            watchDirectory(
                dir,
                () => this.debounce(`spec:${runId}`, 200, () => this.capture(runId)),
                (changed) => changed === name,
            ),
        );
        await this.capture(runId);
    }

    unwatchRun(runId: number): void {
        this.files.get(runId)?.close();
        this.files.delete(runId);
    }

    /** Relit le fichier ; s'il a changé depuis la dernière version, en enregistre une et prévient l'UI. */
    private async capture(runId: number): Promise<void> {
        const spec = await readSpec(runId).catch(() => undefined);
        if (!spec || spec.content === null) return;
        if (latestSpecVersion(runId)?.content === spec.content) return;
        insertSpecVersion(runId, spec.content);
        this.emit('spec', { ...spec, versions: listSpecVersions(runId) });
    }

    private debounce(key: string, ms: number, work: () => Promise<void>): void {
        clearTimeout(this.timers.get(key));
        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                void work();
            }, ms),
        );
    }
}

export const specWatcher = new SpecWatcher();

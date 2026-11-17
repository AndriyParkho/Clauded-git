import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { DB_PATH } from './config.js';
import type { BatchItem, DraftLabel, InstallStatus, Repo, ReviewDraft, ReviewEvent, Run, RunState, RunType } from '../shared/protocol.js';

export const db = new DatabaseSync(DB_PATH);

db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS repo (
        id          INTEGER PRIMARY KEY,
        path        TEXT NOT NULL UNIQUE,
        remote      TEXT,
        host        TEXT,
        owner       TEXT,
        name        TEXT,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run (
        id              INTEGER PRIMARY KEY,
        repo_id         INTEGER REFERENCES repo(id) ON DELETE SET NULL,
        type            TEXT NOT NULL,
        cwd             TEXT NOT NULL,
        title           TEXT NOT NULL,
        session_id      TEXT,
        state           TEXT NOT NULL DEFAULT 'closed',
        model           TEXT,
        permission_mode TEXT,
        cost_usd        REAL NOT NULL DEFAULT 0,
        issue_number    INTEGER,
        branch          TEXT,
        worktree        TEXT,
        pr_url          TEXT,
        last_error      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
    );

    -- Review d'une PR en préparation : verdict, corps, commit relu, publication.
    CREATE TABLE IF NOT EXISTS review (
        repo_id         INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
        pr_number       INTEGER NOT NULL,
        commit_id       TEXT,
        body            TEXT NOT NULL DEFAULT '',
        event           TEXT NOT NULL DEFAULT 'PENDING',
        imported_at     TEXT,
        imported_mtime  REAL,
        published_at    TEXT,
        published_url   TEXT,
        PRIMARY KEY (repo_id, pr_number)
    );

    -- Commentaires en brouillon, aux champs de l'API GitHub (path, line, start_line, side, body).
    CREATE TABLE IF NOT EXISTS review_draft (
        id          INTEGER PRIMARY KEY,
        repo_id     INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
        pr_number   INTEGER NOT NULL,
        path        TEXT NOT NULL,
        line        INTEGER NOT NULL,
        start_line  INTEGER,
        side        TEXT NOT NULL DEFAULT 'RIGHT',
        body        TEXT NOT NULL,
        label       TEXT,
        source      TEXT NOT NULL DEFAULT 'claude',
        created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_draft_pr ON review_draft (repo_id, pr_number);

    -- Issue d'un lot d'implémentations qui attend ses dépendances (ou dont le lancement a échoué).
    CREATE TABLE IF NOT EXISTS batch_item (
        repo_id         INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
        issue_number    INTEGER NOT NULL,
        title           TEXT NOT NULL,
        depends_on      TEXT NOT NULL,
        plan_mode       INTEGER NOT NULL DEFAULT 0,
        state           TEXT NOT NULL,
        detail          TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        PRIMARY KEY (repo_id, issue_number)
    );
`);

// Migrations additives : une colonne manquante est ajoutée, jamais supprimée.
const RUN_MIGRATIONS: Array<[column: string, definition: string]> = [
    ['base_branch', 'TEXT'],
    ['install_status', 'TEXT'],
    ['archived', 'INTEGER NOT NULL DEFAULT 0'],
    ['pr_number', 'INTEGER'],
];
const runColumns = new Set(db.prepare('PRAGMA table_info(run)').all().map((row) => String(row.name)));
for (const [column, definition] of RUN_MIGRATIONS) {
    if (!runColumns.has(column)) db.exec(`ALTER TABLE run ADD COLUMN ${column} ${definition}`);
}

type Row = Record<string, SQLOutputValue>;

type Cell = SQLOutputValue | undefined;

const now = (): string => new Date().toISOString();
const str = (value: Cell): string | null => (value === null || value === undefined ? null : String(value));
const text = (value: Cell): string => str(value) ?? '';
const num = (value: Cell): number => Number(value ?? 0);
const numOrNull = (value: Cell): number | null => (value === null || value === undefined ? null : Number(value));

// ---------------------------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------------------------

function toRepo(row: Row): Repo {
    return {
        id: num(row.id),
        path: text(row.path),
        remote: str(row.remote),
        host: str(row.host),
        owner: str(row.owner),
        name: str(row.name),
        enabled: num(row.enabled) === 1,
    };
}

export function listRepos(): Repo[] {
    return db.prepare('SELECT * FROM repo ORDER BY name, path').all().map(toRepo);
}

export function getRepo(id: number): Repo | undefined {
    const row = db.prepare('SELECT * FROM repo WHERE id = ?').get(id);
    return row ? toRepo(row) : undefined;
}

export function findRepoByPath(path: string): Repo | undefined {
    const row = db.prepare('SELECT * FROM repo WHERE path = ?').get(path);
    return row ? toRepo(row) : undefined;
}

export function findRepoByRemote(host: string, owner: string, name: string): Repo | undefined {
    const row = db.prepare('SELECT * FROM repo WHERE host = ? AND owner = ? AND name = ?').get(host, owner, name);
    return row ? toRepo(row) : undefined;
}

export function insertRepo(repo: Omit<Repo, 'id' | 'enabled'>): Repo {
    const result = db
        .prepare('INSERT INTO repo (path, remote, host, owner, name, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .run(repo.path, repo.remote, repo.host, repo.owner, repo.name, now());
    return getRepo(Number(result.lastInsertRowid)) as Repo;
}

export function updateRepo(id: number, patch: Partial<Pick<Repo, 'enabled'>>): Repo | undefined {
    if (patch.enabled !== undefined) db.prepare('UPDATE repo SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    return getRepo(id);
}

export function deleteRepo(id: number): void {
    db.prepare('DELETE FROM repo WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------------------------
// Runs (onglets)
// ---------------------------------------------------------------------------------------------

function toRun(row: Row): Run {
    return {
        id: num(row.id),
        repoId: numOrNull(row.repo_id),
        type: text(row.type) as RunType,
        cwd: text(row.cwd),
        title: text(row.title),
        sessionId: str(row.session_id),
        state: text(row.state) as RunState,
        model: str(row.model),
        permissionMode: str(row.permission_mode) as PermissionMode | null,
        costUsd: num(row.cost_usd),
        issueNumber: numOrNull(row.issue_number),
        prNumber: numOrNull(row.pr_number),
        branch: str(row.branch),
        baseBranch: str(row.base_branch),
        worktree: str(row.worktree),
        prUrl: str(row.pr_url),
        installStatus: str(row.install_status) as InstallStatus | null,
        lastError: str(row.last_error),
        archived: num(row.archived) === 1,
        createdAt: text(row.created_at),
        updatedAt: text(row.updated_at),
    };
}

/** Les onglets ouverts (non archivés), dans l'ordre de création. */
export function listRuns(): Run[] {
    return db.prepare('SELECT * FROM run WHERE archived = 0 ORDER BY created_at').all().map(toRun);
}

export function getRun(id: number): Run | undefined {
    const row = db.prepare('SELECT * FROM run WHERE id = ?').get(id);
    return row ? toRun(row) : undefined;
}

export interface NewRun {
    repoId: number | null;
    type: RunType;
    cwd: string;
    title: string;
    sessionId?: string | null;
    permissionMode?: PermissionMode | null;
    issueNumber?: number | null;
    prNumber?: number | null;
    branch?: string | null;
    baseBranch?: string | null;
    worktree?: string | null;
    installStatus?: InstallStatus | null;
}

export function insertRun(run: NewRun): Run {
    const at = now();
    const result = db
        .prepare(
            `INSERT INTO run (repo_id, type, cwd, title, session_id, state, permission_mode, issue_number, pr_number, branch, base_branch, worktree, install_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            run.repoId,
            run.type,
            run.cwd,
            run.title,
            run.sessionId ?? null,
            run.permissionMode ?? null,
            run.issueNumber ?? null,
            run.prNumber ?? null,
            run.branch ?? null,
            run.baseBranch ?? null,
            run.worktree ?? null,
            run.installStatus ?? null,
            at,
            at,
        );
    return getRun(Number(result.lastInsertRowid)) as Run;
}

const RUN_COLUMNS: Partial<Record<keyof Run, string>> = {
    title: 'title',
    sessionId: 'session_id',
    state: 'state',
    model: 'model',
    permissionMode: 'permission_mode',
    costUsd: 'cost_usd',
    issueNumber: 'issue_number',
    prNumber: 'pr_number',
    branch: 'branch',
    baseBranch: 'base_branch',
    worktree: 'worktree',
    prUrl: 'pr_url',
    installStatus: 'install_status',
    lastError: 'last_error',
    archived: 'archived',
};

/** L'onglet d'implémentation d'une issue, s'il existe. */
export function findImplementRun(repoId: number, issueNumber: number): Run | undefined {
    const row = db.prepare("SELECT * FROM run WHERE repo_id = ? AND issue_number = ? AND type = 'implement' ORDER BY created_at DESC").get(repoId, issueNumber);
    return row ? toRun(row) : undefined;
}

export function listRunsForIssue(repoId: number, issueNumber: number): Run[] {
    return db.prepare('SELECT * FROM run WHERE repo_id = ? AND issue_number = ? ORDER BY created_at').all(repoId, issueNumber).map(toRun);
}

export function updateRun(id: number, patch: Partial<Run>): Run | undefined {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, column] of Object.entries(RUN_COLUMNS) as Array<[keyof Run, string]>) {
        const value = patch[key];
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as SQLInputValue));
    }
    if (sets.length === 0) return getRun(id);
    sets.push('updated_at = ?');
    values.push(now(), id);
    db.prepare(`UPDATE run SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return getRun(id);
}

export function deleteRun(id: number): void {
    db.prepare('DELETE FROM run WHERE id = ?').run(id);
}

/** Ferme l'onglet sans perdre sa trace : il reste listé dans l'historique de son issue. */
export function archiveRun(id: number): void {
    db.prepare("UPDATE run SET archived = 1, state = 'closed', updated_at = ? WHERE id = ?").run(now(), id);
}

export function findRunBySession(sessionId: string): Run | undefined {
    const row = db.prepare('SELECT * FROM run WHERE session_id = ? ORDER BY created_at DESC').get(sessionId);
    return row ? toRun(row) : undefined;
}

/** Le dernier onglet de review d'une PR, s'il existe. */
export function findPrRun(repoId: number, prNumber: number): Run | undefined {
    const row = db.prepare("SELECT * FROM run WHERE repo_id = ? AND pr_number = ? AND type = 'pr' ORDER BY created_at DESC").get(repoId, prNumber);
    return row ? toRun(row) : undefined;
}

export function listRunsForPr(repoId: number, prNumber: number): Run[] {
    return db.prepare('SELECT * FROM run WHERE repo_id = ? AND pr_number = ? ORDER BY created_at').all(repoId, prNumber).map(toRun);
}

// ---------------------------------------------------------------------------------------------
// Reviews (brouillons de commentaires)
// ---------------------------------------------------------------------------------------------

export interface ReviewRow {
    commitId: string | null;
    body: string;
    event: ReviewEvent;
    importedAt: string | null;
    importedMtime: number | null;
    publishedAt: string | null;
    publishedUrl: string | null;
}

function toDraft(row: Row): ReviewDraft {
    return {
        id: num(row.id),
        path: text(row.path),
        line: num(row.line),
        startLine: numOrNull(row.start_line),
        side: text(row.side) === 'LEFT' ? 'LEFT' : 'RIGHT',
        body: text(row.body),
        label: str(row.label) as DraftLabel | null,
        source: text(row.source) === 'me' ? 'me' : 'claude',
    };
}

export function getReviewRow(repoId: number, prNumber: number): ReviewRow {
    const row = db.prepare('SELECT * FROM review WHERE repo_id = ? AND pr_number = ?').get(repoId, prNumber);
    if (!row) return { commitId: null, body: '', event: 'PENDING', importedAt: null, importedMtime: null, publishedAt: null, publishedUrl: null };
    return {
        commitId: str(row.commit_id),
        body: text(row.body),
        event: (str(row.event) ?? 'PENDING') as ReviewEvent,
        importedAt: str(row.imported_at),
        importedMtime: numOrNull(row.imported_mtime),
        publishedAt: str(row.published_at),
        publishedUrl: str(row.published_url),
    };
}

export function saveReviewRow(repoId: number, prNumber: number, patch: Partial<ReviewRow>): void {
    const row = { ...getReviewRow(repoId, prNumber), ...patch };
    db.prepare(
        `INSERT INTO review (repo_id, pr_number, commit_id, body, event, imported_at, imported_mtime, published_at, published_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, pr_number) DO UPDATE SET commit_id = excluded.commit_id, body = excluded.body, event = excluded.event,
             imported_at = excluded.imported_at, imported_mtime = excluded.imported_mtime, published_at = excluded.published_at, published_url = excluded.published_url`,
    ).run(repoId, prNumber, row.commitId, row.body, row.event, row.importedAt, row.importedMtime, row.publishedAt, row.publishedUrl);
}

export function listDrafts(repoId: number, prNumber: number): ReviewDraft[] {
    return db.prepare('SELECT * FROM review_draft WHERE repo_id = ? AND pr_number = ? ORDER BY path, line, id').all(repoId, prNumber).map(toDraft);
}

export type NewDraft = Omit<ReviewDraft, 'id'>;

export function insertDraft(repoId: number, prNumber: number, draft: NewDraft): ReviewDraft {
    const result = db
        .prepare('INSERT INTO review_draft (repo_id, pr_number, path, line, start_line, side, body, label, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(repoId, prNumber, draft.path, draft.line, draft.startLine, draft.side, draft.body, draft.label, draft.source, now());
    return toDraft(db.prepare('SELECT * FROM review_draft WHERE id = ?').get(Number(result.lastInsertRowid)) as Row);
}

/** Modifier un brouillon le fait passer à « moi » : un nouvel import de Claude ne l'écrasera plus. */
export function updateDraft(id: number, patch: Partial<Pick<ReviewDraft, 'body' | 'label' | 'line' | 'startLine' | 'side'>>): void {
    const current = db.prepare('SELECT * FROM review_draft WHERE id = ?').get(id);
    if (!current) throw new Error(`brouillon ${id} introuvable`);
    const draft = { ...toDraft(current), ...patch };
    db.prepare("UPDATE review_draft SET body = ?, label = ?, line = ?, start_line = ?, side = ?, source = 'me' WHERE id = ?").run(draft.body, draft.label, draft.line, draft.startLine, draft.side, id);
}

export function deleteDraft(id: number): void {
    db.prepare('DELETE FROM review_draft WHERE id = ?').run(id);
}

/** Remplace les brouillons écrits par Claude (ceux que tu as touchés restent). */
export function replaceClaudeDrafts(repoId: number, prNumber: number, drafts: NewDraft[]): void {
    db.exec('BEGIN');
    try {
        db.prepare("DELETE FROM review_draft WHERE repo_id = ? AND pr_number = ? AND source = 'claude'").run(repoId, prNumber);
        for (const draft of drafts) insertDraft(repoId, prNumber, draft);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

export function clearDrafts(repoId: number, prNumber: number): void {
    db.prepare('DELETE FROM review_draft WHERE repo_id = ? AND pr_number = ?').run(repoId, prNumber);
}

/** Au démarrage, aucune session n'est vivante : tous les onglets repartent de `closed`. */
export function resetRunStates(): void {
    db.prepare("UPDATE run SET state = 'closed' WHERE state <> 'closed'").run();
}

// ---------------------------------------------------------------------------------------------
// Lots d'implémentations : issues en attente de leurs dépendances
// ---------------------------------------------------------------------------------------------

function toBatchItem(row: Row): BatchItem {
    return {
        repoId: num(row.repo_id),
        issueNumber: num(row.issue_number),
        title: text(row.title),
        dependsOn: JSON.parse(text(row.depends_on) || '[]') as number[],
        planMode: num(row.plan_mode) === 1,
        state: text(row.state) as BatchItem['state'],
        detail: text(row.detail),
        createdAt: text(row.created_at),
    };
}

export function listBatchItems(repoId?: number): BatchItem[] {
    const rows = repoId === undefined ? db.prepare('SELECT * FROM batch_item ORDER BY created_at').all() : db.prepare('SELECT * FROM batch_item WHERE repo_id = ? ORDER BY created_at').all(repoId);
    return rows.map(toBatchItem);
}

export function getBatchItem(repoId: number, issueNumber: number): BatchItem | undefined {
    const row = db.prepare('SELECT * FROM batch_item WHERE repo_id = ? AND issue_number = ?').get(repoId, issueNumber);
    return row ? toBatchItem(row) : undefined;
}

export function saveBatchItem(item: Omit<BatchItem, 'createdAt'>): void {
    db.prepare(
        `INSERT INTO batch_item (repo_id, issue_number, title, depends_on, plan_mode, state, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, issue_number) DO UPDATE SET title = excluded.title, depends_on = excluded.depends_on, plan_mode = excluded.plan_mode, state = excluded.state, detail = excluded.detail`,
    ).run(item.repoId, item.issueNumber, item.title, JSON.stringify(item.dependsOn), item.planMode ? 1 : 0, item.state, item.detail, now());
}

export function deleteBatchItem(repoId: number, issueNumber: number): void {
    db.prepare('DELETE FROM batch_item WHERE repo_id = ? AND issue_number = ?').run(repoId, issueNumber);
}

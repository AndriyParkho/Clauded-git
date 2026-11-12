import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { DB_PATH } from './config.js';
import type { InstallStatus, Repo, Run, RunState, RunType } from '../shared/protocol.js';

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
`);

// Migrations additives : une colonne manquante est ajoutée, jamais supprimée.
const RUN_MIGRATIONS: Array<[column: string, definition: string]> = [
    ['base_branch', 'TEXT'],
    ['install_status', 'TEXT'],
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
        branch: str(row.branch),
        baseBranch: str(row.base_branch),
        worktree: str(row.worktree),
        prUrl: str(row.pr_url),
        installStatus: str(row.install_status) as InstallStatus | null,
        lastError: str(row.last_error),
        createdAt: text(row.created_at),
        updatedAt: text(row.updated_at),
    };
}

export function listRuns(): Run[] {
    return db.prepare('SELECT * FROM run ORDER BY created_at').all().map(toRun);
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
    branch?: string | null;
    baseBranch?: string | null;
    worktree?: string | null;
    installStatus?: InstallStatus | null;
}

export function insertRun(run: NewRun): Run {
    const at = now();
    const result = db
        .prepare(
            `INSERT INTO run (repo_id, type, cwd, title, session_id, state, permission_mode, issue_number, branch, base_branch, worktree, install_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            run.repoId,
            run.type,
            run.cwd,
            run.title,
            run.sessionId ?? null,
            run.permissionMode ?? null,
            run.issueNumber ?? null,
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
    branch: 'branch',
    baseBranch: 'base_branch',
    worktree: 'worktree',
    prUrl: 'pr_url',
    installStatus: 'install_status',
    lastError: 'last_error',
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
        if (patch[key] === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(patch[key] as SQLInputValue);
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

/** Au démarrage, aucune session n'est vivante : tous les onglets repartent de `closed`. */
export function resetRunStates(): void {
    db.prepare("UPDATE run SET state = 'closed' WHERE state <> 'closed'").run();
}

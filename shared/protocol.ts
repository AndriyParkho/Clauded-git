/**
 * Types partagés entre le serveur et l'UI : modèle de données et messages WebSocket.
 * Ce fichier ne doit contenir que des types (il est importé en `import type` côté web).
 */
import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type RunType = 'chat' | 'implement' | 'pr' | 'merge' | 'spec';

/**
 * État d'un onglet.
 * - `closed` : pas de session Claude en cours (au démarrage de l'app, ou après fermeture).
 * - `starting` : la session démarre.
 * - `idle` : prêt, en attente d'un prompt.
 * - `running` : Claude travaille.
 * - `waiting` : Claude attend une réponse (question, validation de plan).
 * - `error` : la session s'est arrêtée sur une erreur (`lastError`).
 */
export type RunState = 'closed' | 'starting' | 'idle' | 'running' | 'waiting' | 'error';

export type InstallStatus = 'pending' | 'running' | 'ok' | 'failed';

export interface Repo {
    id: number;
    path: string;
    remote: string | null;
    host: string | null;
    owner: string | null;
    name: string | null;
    enabled: boolean;
}

export interface Run {
    id: number;
    repoId: number | null;
    type: RunType;
    cwd: string;
    title: string;
    sessionId: string | null;
    state: RunState;
    model: string | null;
    permissionMode: PermissionMode | null;
    costUsd: number;
    issueNumber: number | null;
    branch: string | null;
    baseBranch: string | null;
    worktree: string | null;
    prUrl: string | null;
    installStatus: InstallStatus | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SessionHistoryItem {
    sessionId: string;
    summary: string;
    firstPrompt?: string;
    customTitle?: string;
    gitBranch?: string;
    cwd?: string;
    lastModified: number;
}

export interface SlashCommandInfo {
    name: string;
    description: string;
    argumentHint: string;
}

/** Question posée par Claude (AskUserQuestion) ou plan à valider (ExitPlanMode). */
export interface AskRequest {
    id: string;
    runId: number;
    tool: string;
    input: Record<string, unknown>;
    createdAt: string;
}

export interface PermissionEvent {
    runId: number;
    tool: string;
    input: Record<string, unknown>;
    at: string;
}

export interface ModelChoice {
    value: string;
    displayName: string;
    description: string;
}

export interface RateWindow {
    utilization: number | null;
    resetsAt: string | null;
}

/** Consommation : contexte de la session et limites du compte (fenêtres 5 h et 7 j). */
export interface UsageInfo {
    runId: number;
    at: string;
    context?: { tokens: number; max: number; percent: number };
    subscription?: string | null;
    limits?: {
        fiveHour?: RateWindow;
        sevenDay?: RateWindow;
        sevenDayOpus?: RateWindow;
        sevenDaySonnet?: RateWindow;
        extra?: { enabled: boolean; used: number | null; limit: number | null; utilization: number | null };
    } | null;
}

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

export type IssueFilter = 'assigned' | 'created' | 'all';
export type IssueState = 'open' | 'closed' | 'all';

export interface IssueRef {
    number: number;
    title: string;
    state: 'OPEN' | 'CLOSED';
}

export interface Issue extends IssueRef {
    url: string;
    createdAt: string;
    updatedAt: string;
    author: string;
    assignees: string[];
    labels: Array<{ name: string; color: string }>;
    comments: number;
    parent: number | null;
    subIssues: IssueRef[];
}

export interface IssueComment {
    author: string;
    createdAt: string;
    body: string;
}

export interface IssueDetail extends Issue {
    body: string;
    commentList: IssueComment[];
    linkedBranches: string[];
}

export interface PullRequestRef {
    number: number;
    url: string;
    title: string;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    isDraft: boolean;
    baseRefName: string;
    headRefName: string;
}

export interface RepoIssues {
    repoId: number;
    issues: Issue[];
    error?: string;
    fetchedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Commandes lancées par l'app (install, tests, merges), sortie diffusée en flux
// ---------------------------------------------------------------------------------------------

export type JobStatus = 'running' | 'ok' | 'failed';

export interface JobInfo {
    id: string;
    runId: number;
    name: string;
    status: JobStatus;
    code: number | null;
    startedAt: string;
    endedAt: string | null;
    output: string;
}

export interface WorktreeInfo {
    branch: string | null;
    dirty: boolean;
    changedFiles: number;
    ahead: number;
    behind: number;
    hasUpstream: boolean;
    conflicted: string[];
    pr: PullRequestRef | null;
}

// ---------------------------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------------------------

export type ClientMessage =
    | { type: 'prompt'; runId: number; text: string }
    | { type: 'interrupt'; runId: number }
    | { type: 'answer'; runId: number; requestId: string; allow: boolean; updatedInput?: Record<string, unknown>; message?: string }
    | { type: 'replay'; runId: number }
    | { type: 'setPermissionMode'; runId: number; mode: PermissionMode }
    | { type: 'setModel'; runId: number; model: string };

export type ServerMessage =
    | { type: 'hello'; runs: Run[]; repos: Repo[] }
    | { type: 'sdk'; runId: number; message: SDKMessage }
    | { type: 'run'; run: Run }
    | { type: 'runDeleted'; runId: number }
    | { type: 'replay'; runId: number; messages: SDKMessage[]; asks: AskRequest[]; commands: SlashCommandInfo[]; models: ModelChoice[]; usage?: UsageInfo; jobs: JobInfo[] }
    | { type: 'ask'; ask: AskRequest }
    | { type: 'askResolved'; runId: number; requestId: string }
    | { type: 'permission'; event: PermissionEvent }
    | { type: 'commands'; runId: number; commands: SlashCommandInfo[] }
    | { type: 'models'; runId: number; models: ModelChoice[] }
    | { type: 'usage'; usage: UsageInfo }
    | { type: 'job'; job: JobInfo }
    | { type: 'error'; runId?: number; message: string };

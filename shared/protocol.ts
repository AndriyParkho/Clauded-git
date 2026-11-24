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
    /** PR relue dans un onglet `pr`. */
    prNumber: number | null;
    branch: string | null;
    baseBranch: string | null;
    worktree: string | null;
    prUrl: string | null;
    installStatus: InstallStatus | null;
    lastError: string | null;
    /** Onglet fermé : plus affiché, mais gardé dans l'historique de son issue et reprenable. */
    archived: boolean;
    /** Fichier de spec (chemin absolu) d'un onglet `spec`. */
    specPath: string | null;
    createdAt: string;
    updatedAt: string;
}

export type OpenApp = 'vscode' | 'finder' | 'terminal' | 'iterm';

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

/** Une fenêtre de limite du forfait : `utilization` en pourcentage (0-100), `resetsAt` en ISO 8601. */
export interface RateWindow {
    label: string;
    utilization: number | null;
    resetsAt: string | null;
}

/** Contexte utilisé par une session, après chaque tour. */
export interface UsageInfo {
    runId: number;
    at: string;
    context?: { tokens: number; max: number; percent: number };
}

/**
 * Consommation du compte claude.ai (globale, pas liée à un onglet) : fenêtres 5 h, 7 j et par modèle.
 * `available` est faux pour une clé d'API, Bedrock ou Vertex ; `error` dit pourquoi la lecture a échoué.
 */
export interface AccountUsage {
    at: string;
    subscription: string | null;
    available: boolean;
    windows: RateWindow[];
    extra?: { used: number | null; limit: number | null; utilization: number | null; currency: string | null };
    error?: string;
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

/** Statut de l'issue dans un GitHub Project (champ « Status ») ; `order` = position de l'option dans le projet. */
export interface IssueStatus {
    project: string;
    name: string;
    order: number;
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
    status: IssueStatus | null;
}

export interface IssueComment {
    author: string;
    createdAt: string;
    body: string;
}

export interface IssueDetail extends Issue {
    body: string;
    commentList: IssueComment[];
    /** Branches de la section « Development » (créées par `gh issue develop`). */
    linkedBranches: string[];
    /** PR qui ferment l'issue (`Closes #n`) ; vide quand les PR ne font que la référencer. */
    pullRequests: PullRequestRef[];
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
    /** Curseur GitHub de la page suivante, `null` quand tout est chargé. */
    nextCursor: string | null;
    error?: string;
    fetchedAt: string;
}

/** Worktree local d'une issue (branche liée sortie dans `.worktrees/`). */
export interface IssueWorktree {
    path: string;
    branch: string | null;
}

/** Réponse du détail d'une issue : l'issue, ses onglets (archivés compris), les sessions Claude Code de sa branche, son worktree. */
export interface IssueDetailResponse {
    issue: IssueDetail;
    runs: Run[];
    sessions: SessionHistoryItem[];
    worktree: IssueWorktree | null;
}

// ---------------------------------------------------------------------------------------------
// Pull requests et review
// ---------------------------------------------------------------------------------------------

/** `review` : review demandée à moi ; `mine` : mes PR ; `all` : toutes les ouvertes. */
export type PullFilter = 'review' | 'mine' | 'all';

/** État agrégé des checks du dernier commit (`statusCheckRollup`). */
export type ChecksState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export interface PullSummary {
    number: number;
    title: string;
    url: string;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    isDraft: boolean;
    author: string;
    createdAt: string;
    updatedAt: string;
    baseRefName: string;
    headRefName: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    reviewDecision: ReviewDecision;
    checks: ChecksState;
    labels: Array<{ name: string; color: string }>;
}

export interface CheckInfo {
    name: string;
    /** `SUCCESS`, `FAILURE`, `PENDING`, `SKIPPED`, `NEUTRAL`… (conclusion d'un check run ou état d'un statut). */
    state: string;
    url: string | null;
}

export interface ReviewThreadInfo {
    path: string;
    line: number | null;
    isResolved: boolean;
    isOutdated: boolean;
    comments: IssueComment[];
}

export interface SubmittedReview {
    author: string;
    state: string;
    submittedAt: string | null;
    body: string;
}

export interface PullDetail extends PullSummary {
    body: string;
    headRefOid: string;
    isCrossRepository: boolean;
    files: Array<{ path: string; additions: number; deletions: number }>;
    comments: IssueComment[];
    reviews: SubmittedReview[];
    threads: ReviewThreadInfo[];
    checkList: CheckInfo[];
    /** Issues liées : fermées par la PR (`Closes #n`), citées dans sa description (`Refs #n`), ou numéro de sa branche. */
    issues: IssueRef[];
}

export interface RepoPulls {
    repoId: number;
    pulls: PullSummary[];
    error?: string;
    fetchedAt: string;
}

export interface PullDetailResponse {
    pull: PullDetail;
    /** Onglets ouverts sur cette PR (archivés compris). */
    runs: Run[];
    /** Worktree local où la branche de la PR est sortie, s'il y en a un. */
    worktree: IssueWorktree | null;
}

export type DraftLabel = 'bloquant' | 'à corriger' | 'détail' | 'question';
export type DraftSide = 'LEFT' | 'RIGHT';

/** Un commentaire de review en brouillon, aux champs de l'API GitHub, plus un label de tri. */
export interface ReviewDraft {
    id: number;
    path: string;
    line: number;
    startLine: number | null;
    side: DraftSide;
    body: string;
    label: DraftLabel | null;
    /** `claude` : écrit par la review ; `me` : ajouté ou modifié à la main. */
    source: 'claude' | 'me';
}

/** `PENDING` : review en attente sur GitHub, à soumettre là-bas ; sinon soumise avec ce verdict. */
export type ReviewEvent = 'PENDING' | 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewState {
    repoId: number;
    prNumber: number;
    /** Commit relu (celui des brouillons) ; `null` tant que la review n'a rien écrit. */
    commitId: string | null;
    body: string;
    event: ReviewEvent;
    drafts: ReviewDraft[];
    /** Fichier que la session de review écrit ; l'app l'importe dès qu'il change. */
    file: string;
    importedAt: string | null;
    publishedAt: string | null;
    publishedUrl: string | null;
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
    /** Dossier où la commande tourne, relatif au worktree (absent : sa racine). */
    dir?: string;
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

// ---------------------------------------------------------------------------------------------
// MCP (résultat de `/mcp` dans l'app)
// ---------------------------------------------------------------------------------------------

export type McpServerState = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';

export interface McpServerInfo {
    name: string;
    status: McpServerState;
    scope?: string;
    source?: string;
    version?: string;
    /** `stdio`, `http`, `sse`… et l'URL ou la commande, pour situer le serveur. */
    transport?: string;
    target?: string;
    error?: string;
    tools: Array<{ name: string; description?: string }>;
}

export interface McpStatus {
    runId: number;
    at: string;
    servers: McpServerInfo[];
}

export type McpAction = 'status' | 'reconnect' | 'enable' | 'disable';

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Image jointe à un prompt (collée, glissée ou choisie), en base64. */
export interface ImageAttachment {
    mediaType: ImageMediaType;
    data: string;
    name?: string;
}

export type ClientMessage =
    | { type: 'prompt'; runId: number; text: string; images?: ImageAttachment[] }
    | { type: 'interrupt'; runId: number }
    | { type: 'answer'; runId: number; requestId: string; allow: boolean; updatedInput?: Record<string, unknown>; message?: string }
    | { type: 'replay'; runId: number }
    | { type: 'setPermissionMode'; runId: number; mode: PermissionMode }
    | { type: 'setModel'; runId: number; model: string }
    | { type: 'mcp'; runId: number; action: McpAction; server?: string }
    | { type: 'refreshAccount'; runId?: never };

/** Skill ou commande disponible pour les sessions d'un dépôt (lu sur le disque). */
export interface SkillInfo {
    /** Nom à appeler (`core-pr-review`, `code-review:code-review`). */
    name: string;
    description: string;
    source: 'project' | 'user' | 'plugin';
}

/** Étape d'une opération longue (ouverture d'une PR, implémentation), affichée sous le loader. */
export interface ProgressStep {
    label: string;
    state: 'pending' | 'running' | 'done' | 'failed';
    /** Commande ou précision ; le message d'erreur pour une étape en échec. */
    detail?: string;
    startedAt?: string;
}

// ---------------------------------------------------------------------------------------------
// Implémentation de plusieurs issues (lot)
// ---------------------------------------------------------------------------------------------

/** D'où vient une dépendance : relation GitHub « blocked by », texte de l'issue, parent/sous-issue, Claude, ou ajout à la main. */
export type DependencySource = 'github' | 'text' | 'subissue' | 'claude' | 'manual';

/** `issue` ne peut être faite qu'après `dependsOn`. */
export interface IssueDependency {
    issue: number;
    dependsOn: number;
    source: DependencySource;
    reason?: string;
}

/** État d'une issue (ou PR) dont dépend le lot, vu au moment de l'analyse ou du lancement. */
export interface DependencyStatus {
    number: number;
    title: string;
    kind: 'issue' | 'pr';
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    /** PR ouverte sur laquelle empiler (celle de l'issue, ou la PR elle-même). */
    openPr: { number: number; branch: string } | null;
    /** Prête : fermée/mergée, ou avec une PR ouverte. Sinon, ses dépendantes attendent. */
    ready: boolean;
    /** Issue parente : nombre de sous-issues encore ouvertes (elle n'aura jamais de PR à elle). */
    openSubIssues?: number;
}

/**
 * Branche où une issue a déjà du travail (commits, PR, modifications locales) : on le signale au
 * lieu de relancer l'implémentation à l'aveugle.
 */
export interface ExistingBranch {
    branch: string;
    /** D'où elle vient : worktree déjà sorti, branche liée sur GitHub, PR ouverte, branche distante au numéro de l'issue. */
    source: 'worktree' | 'linked' | 'pr' | 'remote';
    worktree: string | null;
    pr: PullRequestRef | null;
    /** Commits par rapport à la base (`null` si illisible). */
    commits: number | null;
    /** Dernier commit : sujet et date relative. */
    lastCommit: string | null;
    /** Fichiers modifiés non commités dans le worktree. */
    uncommitted: number;
}

/** Résultat de l'analyse d'une sélection d'issues. */
export interface BatchAnalysis {
    issues: IssueRef[];
    dependencies: IssueDependency[];
    /** Issues ou PR hors sélection dont dépend une issue sélectionnée. */
    external: DependencyStatus[];
    /** Problème non bloquant (relations GitHub illisibles, analyse Claude en échec…). */
    warnings: string[];
    /**
     * Issues sélectionnées qui sont elles-mêmes parentes (sous-issues ouvertes) : écartées du lot, à
     * lancer à part. Leurs dépendances restent dans `dependencies`.
     */
    parents: Array<{ number: number; title: string; openSubIssues: number[] }>;
    /** Implémentations en parallèle : limite et places occupées. */
    slots: { max: number; busy: number };
    /** Issues qui ont déjà une branche avec du travail : écartées par défaut. */
    existing: Array<{ number: number; branch: ExistingBranch }>;
}

/** Une issue d'un lot qui attend ses dépendances (ou dont le lancement a échoué). */
export interface BatchItem {
    repoId: number;
    issueNumber: number;
    title: string;
    dependsOn: number[];
    planMode: boolean;
    state: 'waiting' | 'failed';
    /** Ce qu'elle attend, ou l'erreur. */
    detail: string;
    createdAt: string;
}

export interface BatchResult {
    started: Run[];
    waiting: BatchItem[];
    failed: Array<{ issueNumber: number; error: string }>;
}

// ---------------------------------------------------------------------------------------------
// Nettoyage des worktrees et branches, environnement Bruno
// ---------------------------------------------------------------------------------------------

/** Un worktree (avec sa branche) ou une branche locale seule qui semble ne plus servir. */
export interface CleanupItem {
    /** `wt:<chemin>` ou `br:<branche>`. */
    id: string;
    worktree: string | null;
    branch: string | null;
    issue: { number: number; title: string; state: 'OPEN' | 'CLOSED' } | null;
    pr: { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED' } | null;
    /** Pourquoi elle semble inutile (PR mergée, issue fermée…). */
    reasons: string[];
    /** Ce qui serait perdu ou fermé : modifications non commitées, commits jamais poussés, onglet ouvert. */
    warnings: string[];
    /** Sans risque de perte : cochée d'office. */
    safe: boolean;
}

export interface CleanupList {
    items: CleanupItem[];
    /** Worktrees et branches gardés (PR ouverte, issue ouverte, branches de base…). */
    kept: number;
    base: string;
}

/** Commande Bruno du profil et dossier (dépôt ou worktree) sur lequel Bruno pointe. */
export interface BrunoState {
    command: string | null;
    active: string | null;
}

// ---------------------------------------------------------------------------------------------
// Page Spec
// ---------------------------------------------------------------------------------------------

/** Une version du fichier de spec, enregistrée à chaque écriture qui en change le contenu. */
export interface SpecVersion {
    id: number;
    at: string;
    lines: number;
}

/** Fichier de spec d'un onglet `spec` : contenu actuel (`null` tant qu'il n'existe pas) et versions. */
export interface SpecFile {
    runId: number;
    path: string;
    content: string | null;
    versions: SpecVersion[];
}

/** Issue du découpage proposé par Claude, modifiable avant sa création sur GitHub. */
export interface SpecIssue {
    /** Identifiant court dans le découpage (`api`, `ui`…), référencé par `dependsOn`. */
    key: string;
    title: string;
    body: string;
    dependsOn: string[];
    /** Décochée : pas créée. */
    include: boolean;
    /** Numéro et lien une fois créée sur GitHub. */
    number: number | null;
    url: string | null;
}

/** Découpage d'une spec en issues : une parente (facultative) et ses sous-issues. */
export interface SpecPlan {
    runId: number;
    /** Fichier JSON que la session écrit ; l'app l'importe dès qu'il change. */
    file: string;
    /** Dépôt où créer les issues. */
    repoId: number | null;
    parent: SpecIssue | null;
    issues: SpecIssue[];
    importedAt: string | null;
}

/** Passage cité (d'une réponse de Claude ou de la spec), envoyé avec le message suivant. */
export interface Quote {
    id: string;
    text: string;
    /** D'où vient le passage : `SPEC.md`, ou absent pour le fil du chat. */
    source?: string;
    /** Annotation : ce que tu en dis. */
    comment?: string;
}

/** Lien GitHub d'une issue ou d'une PR, pour l'en-tête d'un onglet. */
export interface GithubLink {
    kind: 'issue' | 'pr';
    number: number;
    title: string;
    url: string;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    isDraft?: boolean;
}

/** Workflow GitHub Actions déclenché par le merge de la branche de l'onglet dans develop ou master. */
export interface WorkflowLink {
    id: number;
    name: string;
    url: string;
    /** Branche où le merge a eu lieu (`develop`, `master`). */
    target: string;
    status: string;
    /** `success`, `failure`, `cancelled`… une fois terminé. */
    conclusion: string | null;
    createdAt: string;
}

export interface RunLinks {
    links: GithubLink[];
    workflows: WorkflowLink[];
}

/** Page écrite par une session dans son dossier d'artifacts, servie par l'app. */
export interface ArtifactFile {
    name: string;
    /** Adresse où l'app la sert (`/artifacts/<onglet>/<nom>`). */
    url: string;
    size: number;
    updatedAt: string;
}

export type ServerMessage =
    | { type: 'hello'; runs: Run[]; repos: Repo[]; account?: AccountUsage }
    | { type: 'spec'; spec: SpecFile }
    | { type: 'specPlan'; plan: SpecPlan }
    | { type: 'batch'; items: BatchItem[] }
    | { type: 'account'; account: AccountUsage }
    | { type: 'sdk'; runId: number; message: SDKMessage }
    | { type: 'run'; run: Run }
    | { type: 'runDeleted'; runId: number }
    | { type: 'replay'; runId: number; messages: SDKMessage[]; asks: AskRequest[]; commands: SlashCommandInfo[]; models: ModelChoice[]; usage?: UsageInfo; jobs: JobInfo[] }
    | { type: 'mcp'; status: McpStatus }
    | { type: 'ask'; ask: AskRequest }
    | { type: 'askResolved'; runId: number; requestId: string }
    | { type: 'permission'; event: PermissionEvent }
    | { type: 'commands'; runId: number; commands: SlashCommandInfo[] }
    | { type: 'models'; runId: number; models: ModelChoice[] }
    | { type: 'usage'; usage: UsageInfo }
    | { type: 'job'; job: JobInfo }
    | { type: 'review'; review: ReviewState }
    | { type: 'progress'; opId: string; steps: ProgressStep[] }
    | { type: 'error'; runId?: number; message: string };

import type {
    BatchAnalysis,
    BatchItem,
    BatchResult,
    BrunoState,
    CleanupList,
    IssueDependency,
    IssueDetailResponse,
    IssueFilter,
    IssueState,
    JobInfo,
    OpenApp,
    PullDetail,
    PullDetailResponse,
    PullFilter,
    Repo,
    RepoIssues,
    RepoPulls,
    ReviewDraft,
    ReviewEvent,
    ReviewState,
    Run,
    RunType,
    SessionHistoryItem,
    SkillInfo,
    WorktreeInfo,
} from '../../shared/protocol';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `${method} ${url} : ${response.status}`);
    return payload;
}

/** Projets du worktree d'un onglet (dossiers où lancer les commandes). */
export interface ProjectsInfo {
    projects: string[];
    touched: Array<{ path: string; files: number }>;
    suggested: string;
}

export interface Profile {
    baseBranch: string;
    integrationBranch: string | null;
    branchFormat: string;
    worktreesDir: string;
    install: string | null;
    copyFiles: string[];
    commands: Record<string, string>;
    reviewSkill: string | null;
    instructions: string;
    bruno: string | null;
}

export const api = {
    repos: () => request<Repo[]>('GET', '/api/repos'),
    addRepo: (path: string) => request<{ status: 'added' | 'exists'; repo: Repo }>('POST', '/api/repos', { path }),
    scanRepos: (root: string) => request<{ found: string[]; added: Repo[]; existing: Repo[] }>('POST', '/api/repos/scan', { root }),
    patchRepo: (id: number, patch: { enabled?: boolean }) => request<Repo>('PATCH', `/api/repos/${id}`, patch),
    deleteRepo: (id: number) => request<{ ok: true }>('DELETE', `/api/repos/${id}`),
    repoSessions: (id: number) => request<SessionHistoryItem[]>('GET', `/api/repos/${id}/sessions`),
    profile: (id: number) => request<{ path: string; profile: Profile }>('GET', `/api/repos/${id}/profile`),
    saveProfile: (id: number, profile: Profile) => request<{ path: string; profile: Profile }>('PUT', `/api/repos/${id}/profile`, profile),

    issues: (params: { repoId?: number; filter: IssueFilter; state: IssueState; refresh?: boolean; more?: boolean }) => {
        const query = new URLSearchParams({ filter: params.filter, state: params.state });
        if (params.repoId !== undefined) query.set('repoId', String(params.repoId));
        if (params.refresh) query.set('refresh', '1');
        if (params.more) query.set('more', '1');
        return request<RepoIssues[]>('GET', `/api/issues?${query}`);
    },
    issue: (repoId: number, number: number) => request<IssueDetailResponse>('GET', `/api/repos/${repoId}/issues/${number}`),
    resumeIssueSession: (repoId: number, number: number, sessionId: string) => request<Run>('POST', `/api/repos/${repoId}/issues/${number}/resume`, { sessionId }),
    openIn: (path: string, app: OpenApp) => request<{ ok: true }>('POST', '/api/open-in', { path, app }),
    issueChat: (repoId: number, number: number) => request<{ run: Run; draft: string }>('POST', `/api/repos/${repoId}/issues/${number}/chat`),
    implement: (repoId: number, number: number, planMode: boolean, opId?: string) => request<Run>('POST', `/api/repos/${repoId}/issues/${number}/implement`, { planMode, opId }),
    /** Dépendances entre des issues (et envers des issues/PR hors sélection) ; `claude` ajoute l'avis de Claude. */
    dependencies: (repoId: number, issues: number[], claude = false) => request<BatchAnalysis>('POST', `/api/repos/${repoId}/issues/dependencies`, { issues, claude }),
    batch: (repoId: number, body: { issues: number[]; dependencies: Array<Pick<IssueDependency, 'issue' | 'dependsOn'>>; planMode: boolean; opId?: string }) => request<BatchResult>('POST', `/api/repos/${repoId}/issues/batch`, body),
    cleanup: (repoId: number) => request<CleanupList>('GET', `/api/repos/${repoId}/cleanup`),
    /** Lance la suppression en tâche de fond : le job rendu se suit par websocket. */
    runCleanup: (repoId: number, ids: string[]) => request<JobInfo>('POST', `/api/repos/${repoId}/cleanup`, { ids }),
    bruno: (repoId: number) => request<BrunoState>('GET', `/api/repos/${repoId}/bruno`),
    switchBruno: (repoId: number, path: string) => request<BrunoState & { output: string }>('POST', `/api/repos/${repoId}/bruno`, { path }),
    batchItems: () => request<BatchItem[]>('GET', '/api/batch'),
    startBatchItem: (repoId: number, number: number) => request<Run>('POST', `/api/repos/${repoId}/batch/${number}/start`),
    cancelBatchItem: (repoId: number, number: number) => request<{ ok: true }>('DELETE', `/api/repos/${repoId}/batch/${number}`),

    runs: () => request<Run[]>('GET', '/api/runs'),
    createRun: (body: { repoId?: number; cwd?: string; type?: RunType; title?: string; sessionId?: string }) => request<Run>('POST', '/api/runs', body),
    openRun: (id: number) => request<Run>('POST', `/api/runs/${id}/open`),
    closeRun: (id: number) => request<Run>('POST', `/api/runs/${id}/close`),
    renameRun: (id: number, title: string) => request<Run>('PATCH', `/api/runs/${id}`, { title }),
    deleteRun: (id: number) => request<{ ok: true }>('DELETE', `/api/runs/${id}`),

    worktree: (id: number) => request<WorktreeInfo>('GET', `/api/runs/${id}/worktree`),
    diff: (id: number) => request<{ stat: string; patch: string }>('GET', `/api/runs/${id}/diff`),
    jobs: (id: number) => request<JobInfo[]>('GET', `/api/runs/${id}/jobs`),
    projects: (id: number) => request<ProjectsInfo>('GET', `/api/runs/${id}/projects`),
    command: (id: number, name: string, project?: string) => request<JobInfo>('POST', `/api/runs/${id}/command`, { name, ...(project ? { project } : {}) }),
    exec: (id: number, command: string, project?: string) => request<JobInfo>('POST', `/api/runs/${id}/exec`, { command, ...(project ? { project } : {}) }),
    install: (id: number) => request<JobInfo>('POST', `/api/runs/${id}/install`),
    stopJob: (jobId: string) => request<{ ok: true }>('POST', `/api/jobs/${jobId}/stop`),
    mergeBase: (id: number) => request<JobInfo>('POST', `/api/runs/${id}/merge-base`),
    mergeIntegration: (id: number) => request<JobInfo>('POST', `/api/runs/${id}/merge-integration`),
    /** Merge dans develop de la branche d'une issue ou d'une PR, hors onglet. */
    mergeIntegrationFor: (repoId: number, target: { issueNumber: number } | { prNumber: number }) => request<JobInfo>('POST', `/api/repos/${repoId}/merge-integration`, target),
    /** Merge de master dans la branche d'une issue ou d'une PR, hors onglet. */
    mergeBaseFor: (repoId: number, target: { issueNumber: number } | { prNumber: number }) => request<JobInfo>('POST', `/api/repos/${repoId}/merge-base`, target),
    resolveMerge:(jobId: string) => request<Run>('POST', `/api/jobs/${jobId}/resolve-merge`),
    runPull: (id: number) => request<{ pull: PullDetail | null }>('GET', `/api/runs/${id}/pull`),
    startReview: (id: number) => request<{ ok: true }>('POST', `/api/runs/${id}/review`),
    sendReviewComments: (id: number) => request<{ sent: number }>('POST', `/api/runs/${id}/review-comments`),

    pulls: (params: { repoId?: number; filter: PullFilter; refresh?: boolean }) => {
        const query = new URLSearchParams({ filter: params.filter });
        if (params.repoId !== undefined) query.set('repoId', String(params.repoId));
        if (params.refresh) query.set('refresh', '1');
        return request<RepoPulls[]>('GET', `/api/pulls?${query}`);
    },
    pull: (repoId: number, number: number) => request<PullDetailResponse>('GET', `/api/repos/${repoId}/pulls/${number}`),
    pullDiff: (repoId: number, number: number) => request<{ patch: string }>('GET', `/api/repos/${repoId}/pulls/${number}/diff`),
    openPull: (repoId: number, number: number, review: boolean, opId?: string) => request<Run>('POST', `/api/repos/${repoId}/pulls/${number}/open`, { review, opId }),
    skills: (repoId: number) => request<SkillInfo[]>('GET', `/api/repos/${repoId}/skills`),
    review: (repoId: number, number: number) => request<ReviewState>('GET', `/api/repos/${repoId}/pulls/${number}/review`),
    patchReview: (repoId: number, number: number, patch: { body?: string; event?: ReviewEvent }) => request<ReviewState>('PATCH', `/api/repos/${repoId}/pulls/${number}/review`, patch),
    addDraft: (repoId: number, number: number, draft: Omit<ReviewDraft, 'id' | 'source'>) => request<ReviewState>('POST', `/api/repos/${repoId}/pulls/${number}/review/drafts`, draft),
    patchDraft: (repoId: number, number: number, id: number, patch: Partial<Pick<ReviewDraft, 'body' | 'label'>>) => request<ReviewState>('PATCH', `/api/repos/${repoId}/pulls/${number}/review/drafts/${id}`, patch),
    deleteDraft: (repoId: number, number: number, id: number) => request<ReviewState>('DELETE', `/api/repos/${repoId}/pulls/${number}/review/drafts/${id}`),
    publishReview: (repoId: number, number: number) => request<ReviewState>('POST', `/api/repos/${repoId}/pulls/${number}/review/publish`),
};

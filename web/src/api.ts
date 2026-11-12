import type { IssueDetail, IssueFilter, IssueState, JobInfo, Repo, RepoIssues, Run, RunType, SessionHistoryItem, WorktreeInfo } from '../../shared/protocol';

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

    issues: (params: { repoId?: number; filter: IssueFilter; state: IssueState; refresh?: boolean }) => {
        const query = new URLSearchParams({ filter: params.filter, state: params.state });
        if (params.repoId !== undefined) query.set('repoId', String(params.repoId));
        if (params.refresh) query.set('refresh', '1');
        return request<RepoIssues[]>('GET', `/api/issues?${query}`);
    },
    issue: (repoId: number, number: number) => request<{ issue: IssueDetail; runs: Run[] }>('GET', `/api/repos/${repoId}/issues/${number}`),
    issueChat: (repoId: number, number: number) => request<{ run: Run; draft: string }>('POST', `/api/repos/${repoId}/issues/${number}/chat`),
    implement: (repoId: number, number: number, planMode: boolean) => request<Run>('POST', `/api/repos/${repoId}/issues/${number}/implement`, { planMode }),

    runs: () => request<Run[]>('GET', '/api/runs'),
    createRun: (body: { repoId?: number; cwd?: string; type?: RunType; title?: string; sessionId?: string }) => request<Run>('POST', '/api/runs', body),
    openRun: (id: number) => request<Run>('POST', `/api/runs/${id}/open`),
    closeRun: (id: number) => request<Run>('POST', `/api/runs/${id}/close`),
    renameRun: (id: number, title: string) => request<Run>('PATCH', `/api/runs/${id}`, { title }),
    deleteRun: (id: number) => request<{ ok: true }>('DELETE', `/api/runs/${id}`),

    worktree: (id: number) => request<WorktreeInfo>('GET', `/api/runs/${id}/worktree`),
    diff: (id: number) => request<{ stat: string; patch: string }>('GET', `/api/runs/${id}/diff`),
    jobs: (id: number) => request<JobInfo[]>('GET', `/api/runs/${id}/jobs`),
    openIn: (id: number, app: 'vscode' | 'finder' | 'terminal' | 'iterm') => request<{ ok: true }>('POST', `/api/runs/${id}/open-in`, { app }),
    command: (id: number, name: string) => request<JobInfo>('POST', `/api/runs/${id}/command`, { name }),
    mergeBase: (id: number) => request<JobInfo>('POST', `/api/runs/${id}/merge-base`),
    mergeIntegration: (id: number) => request<JobInfo>('POST', `/api/runs/${id}/merge-integration`),
    resolveMerge: (id: number, jobId: string) => request<Run>('POST', `/api/runs/${id}/resolve-merge`, { jobId }),
};

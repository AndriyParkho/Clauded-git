import { git } from './git.js';
import { getIssue, gh, graphql, pullRequestForBranch, repoSlug } from './github.js';
import { forget, memo } from './memo.js';
import { loadProfile } from './profiles.js';
import { getPull } from './pulls.js';
import type { GithubLink, Repo, Run, RunLinks, WorkflowLink } from '../shared/protocol.js';

/** Adresse GitHub d'une issue du dépôt (y compris GitHub Enterprise, d'après l'hôte du remote). */
function issueUrl(repo: Repo, number: number): string {
    return `https://${repo.host ?? 'github.com'}/${repoSlug(repo)}/issues/${number}`;
}

/**
 * Liens GitHub d'un onglet : son issue et la PR qui l'implémente (celle qui la ferme, ou celle de
 * la branche de l'onglet), ou sa PR et les issues qu'elle ferme ou cite.
 */
async function githubLinks(repo: Repo, run: Run): Promise<GithubLink[]> {
    const links: GithubLink[] = [];
    const add = (link: GithubLink): void => {
        if (!links.some((l) => l.kind === link.kind && l.number === link.number)) links.push(link);
    };

    // La PR et l'issue de l'onglet sont lues en même temps.
    const [pull, issue] = await Promise.all([run.prNumber !== null ? getPull(repo, run.prNumber) : null, run.issueNumber !== null ? getIssue(repo, run.issueNumber) : null]);
    if (pull) {
        add({ kind: 'pr', number: pull.number, title: pull.title, url: pull.url, state: pull.state, isDraft: pull.isDraft });
        for (const ref of pull.issues) add({ kind: 'issue', number: ref.number, title: ref.title, url: issueUrl(repo, ref.number), state: ref.state });
    }
    if (issue) {
        add({ kind: 'issue', number: issue.number, title: issue.title, url: issue.url, state: issue.state });
        for (const pr of issue.pullRequests) add({ kind: 'pr', number: pr.number, title: pr.title, url: pr.url, state: pr.state, isDraft: pr.isDraft });
    }

    // La PR de la branche de l'onglet, même sans « Closes #n » (un onglet de merge, lui, est sur develop).
    if (run.branch && run.type !== 'merge' && !links.some((l) => l.kind === 'pr' && l.state === 'OPEN')) {
        const pr = await pullRequestForBranch(repo, run.branch).catch(() => undefined);
        if (pr) add({ kind: 'pr', number: pr.number, title: pr.title, url: pr.url, state: pr.state, isDraft: pr.isDraft });
    }

    // Issue d'abord, puis PR ; les ouvertes avant les fermées.
    const rank = (l: GithubLink): number => (l.kind === 'issue' ? 0 : 2) + (l.state === 'OPEN' ? 0 : 1);
    return links.sort((a, b) => rank(a) - rank(b) || b.number - a.number);
}

interface PullMerge {
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    mergeCommit: { oid: string } | null;
}

async function pullMerges(repo: Repo, numbers: number[]): Promise<PullMerge[]> {
    if (numbers.length === 0) return [];
    const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { headRefName headRefOid baseRefName mergeCommit { oid } }`).join('\n');
    const data = await graphql<{ repository: Record<string, PullMerge | null> }>(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, {
        owner: repo.owner ?? '',
        name: repo.name ?? '',
    });
    return Object.values(data.repository).filter((p): p is PullMerge => p !== null);
}

/**
 * Commit par lequel la branche est entrée dans `target` (merge fait par l'app avec `git merge`, ou
 * avance rapide) : le plus récent de l'historique de premier parent de `origin/<target>` qui est un
 * commit propre à la branche, ou un merge dont le second parent en est un. `null` sinon.
 */
export async function mergeCommitInto(cwd: string, target: string, base: string, tip: string): Promise<string | null> {
    const own = await git(cwd, ['rev-list', `origin/${base}..${tip}`]);
    if (own.code !== 0) return null;
    const commits = new Set(own.stdout.split('\n').filter(Boolean));
    if (commits.size === 0) return null;
    const log = await git(cwd, ['log', `origin/${target}`, '--first-parent', '-n', '500', '--format=%H %P']);
    if (log.code !== 0) return null;
    for (const line of log.stdout.split('\n')) {
        const [sha, , second] = line.split(' ');
        if (sha && (commits.has(sha) || (second && commits.has(second)))) return sha;
    }
    return null;
}

interface GhRun {
    databaseId: number;
    workflowName: string;
    displayTitle: string;
    url: string;
    status: string;
    conclusion: string;
    event: string;
    headBranch: string;
    createdAt: string;
}

/**
 * Workflows GitHub Actions lancés par le merge de la branche de l'onglet dans develop (merge de
 * l'app, retrouvé dans l'historique git) ou dans la base de sa PR (commit de merge de la PR).
 */
async function mergeWorkflows(repo: Repo, run: Run, links: GithubLink[]): Promise<WorkflowLink[]> {
    const profile = await loadProfile(repo);
    const prNumbers = links.filter((l) => l.kind === 'pr').map((l) => l.number);
    const pulls = await pullMerges(repo, prNumbers).catch(() => [] as PullMerge[]);
    const targets: Array<{ target: string; sha: string }> = [];
    const add = (target: string, sha: string | null): void => {
        if (sha && !targets.some((t) => t.target === target && t.sha === sha)) targets.push({ target, sha });
    };

    // Merge sur GitHub (dans master, ou dans develop pour une PR qui le vise) : le commit de merge de la PR.
    for (const pull of pulls) if (pull.mergeCommit) add(pull.baseRefName, pull.mergeCommit.oid);

    // Merge dans develop fait par l'app : retrouvé dans l'historique de develop.
    const integration = profile.integrationBranch;
    const branch = run.type !== 'merge' && run.branch ? run.branch : (pulls[0]?.headRefName ?? null);
    if (integration && branch) {
        // `git fetch` passe par le réseau : au plus une fois par minute pour ces branches.
        await memo(`fetch:${repo.path}:${integration}:${profile.baseBranch}:${branch}`, FETCH_TTL_MS, async () => {
            await git(repo.path, ['fetch', 'origin', integration, profile.baseBranch]);
            await git(repo.path, ['fetch', 'origin', branch]);
        });
        const ref = await git(repo.path, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
        // Branche supprimée après merge : on repart du dernier commit connu de sa PR.
        const tip = ref.code === 0 ? ref.stdout.trim() : (pulls.find((p) => p.headRefName === branch)?.headRefOid ?? null);
        if (tip) add(integration, await mergeCommitInto(repo.path, integration, profile.baseBranch, tip));
    }

    const workflows: WorkflowLink[] = [];
    // Un `gh run list` par commit de merge, tous en même temps.
    const lists = await Promise.all(
        targets.map(({ sha }) =>
            gh<GhRun[]>(['run', 'list', '--repo', repoSlug(repo), '--commit', sha, '--limit', '20', '--json', 'databaseId,workflowName,displayTitle,url,status,conclusion,event,headBranch,createdAt']).catch(() => [] as GhRun[]),
        ),
    );
    targets.forEach(({ target }, i) => {
        for (const r of lists[i] ?? []) {
            if (r.headBranch !== target) continue;
            workflows.push({ id: r.databaseId, name: r.workflowName || r.displayTitle, url: r.url, target, status: r.status, conclusion: r.conclusion || null, createdAt: r.createdAt });
        }
    });
    return workflows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Les liens d'un onglet sont relus à chaque fin de tour et toutes les 30 s tant qu'un workflow tourne. */
const LINKS_TTL_MS = 15_000;
const FETCH_TTL_MS = 60_000;

/**
 * Tout ce que l'en-tête d'un onglet montre de GitHub : issue, PR, et workflows lancés par ses merges.
 * Gardé LINKS_TTL_MS par onglet (plusieurs volets ou une reconnexion le redemandent en même temps).
 */
export function runLinks(repo: Repo, run: Run): Promise<RunLinks> {
    if (run.state === 'running' || run.state === 'starting') forgetRunLinks(repo, run);
    return memo(`links:${run.id}:${run.issueNumber}:${run.prNumber}:${run.branch}`, LINKS_TTL_MS, async () => {
        const links = await githubLinks(repo, run);
        const workflows = await mergeWorkflows(repo, run, links).catch(() => [] as WorkflowLink[]);
        return { links, workflows };
    });
}


/**
 * Oublie ce qu'on sait de GitHub pour cet onglet : appelé quand un tour se termine, puisque Claude a
 * pu ouvrir une PR ou pousser pendant le tour.
 */
export function forgetRunLinks(repo: Repo, run: Run): void {
    forget(`links:${run.id}:`);
    if (run.branch) forget(`branch-pr:${repo.id}:${run.branch}`);
    if (run.prNumber !== null) forget(`pull:${repo.id}:${run.prNumber}`);
    if (run.issueNumber !== null) forget(`issue:${repo.id}:${run.issueNumber}`);
}

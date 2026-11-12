import { exec } from './exec.js';
import type { Issue, IssueDetail, IssueFilter, IssueRef, IssueState, PullRequestRef, Repo } from '../shared/protocol.js';

type IssueSummary = Issue;

export function repoSlug(repo: Repo): string {
    if (!repo.owner || !repo.name) throw new Error(`dépôt sans remote GitHub : ${repo.path}`);
    return `${repo.owner}/${repo.name}`;
}

async function gh<T>(args: string[], cwd?: string): Promise<T> {
    const result = await exec('gh', args, cwd ? { cwd } : {});
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}… a échoué : ${result.stderr.trim() || result.stdout.trim()}`);
    try {
        return JSON.parse(result.stdout) as T;
    } catch {
        throw new Error(`gh ${args.slice(0, 3).join(' ')}… : réponse illisible`);
    }
}

async function graphql<T>(query: string, variables: Record<string, string | number>): Promise<T> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    const payload = await gh<{ data?: T; errors?: Array<{ message: string }> }>(args);
    if (payload.errors?.length) throw new Error(`GitHub : ${payload.errors.map((e) => e.message).join(' ; ')}`);
    if (!payload.data) throw new Error('GitHub : réponse vide');
    return payload.data;
}

// Champs GraphQL d'une issue, sous-issues et parent compris (relations natives GitHub).
const ISSUE_FIELDS = `
    number title state url createdAt updatedAt
    author { login }
    assignees(first: 10) { nodes { login } }
    labels(first: 20) { nodes { name color } }
    comments { totalCount }
    parent { number }
    subIssues(first: 50) { nodes { number title state } }
`;

interface IssueNode {
    number: number;
    title: string;
    state: 'OPEN' | 'CLOSED';
    url: string;
    body?: string;
    createdAt: string;
    updatedAt: string;
    author: { login: string } | null;
    assignees: { nodes: Array<{ login: string }> };
    labels: { nodes: Array<{ name: string; color: string }> };
    comments: { totalCount: number };
    commentList?: { nodes: Array<{ author: { login: string } | null; createdAt: string; body: string }> };
    parent: { number: number } | null;
    subIssues: { nodes: IssueRef[] };
}

function toSummary(node: IssueNode): IssueSummary {
    return {
        number: node.number,
        title: node.title,
        state: node.state,
        url: node.url,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        author: node.author?.login ?? 'ghost',
        assignees: node.assignees.nodes.map((a) => a.login),
        labels: node.labels.nodes,
        comments: node.comments.totalCount,
        parent: node.parent?.number ?? null,
        subIssues: node.subIssues.nodes,
    };
}

/** Issues d'un dépôt, via la recherche GitHub (`@me` = le compte connecté à `gh`). */
export async function listIssues(repo: Repo, filter: IssueFilter, state: IssueState): Promise<IssueSummary[]> {
    const q = [
        `repo:${repoSlug(repo)}`,
        'is:issue',
        state === 'all' ? '' : `state:${state}`,
        filter === 'assigned' ? 'assignee:@me' : filter === 'created' ? 'author:@me' : '',
        'sort:updated-desc',
    ]
        .filter(Boolean)
        .join(' ');
    const data = await graphql<{ search: { nodes: Array<IssueNode | Record<string, never>> } }>(
        `query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on Issue { ${ISSUE_FIELDS} } } } }`,
        { q },
    );
    return data.search.nodes.filter((node): node is IssueNode => 'number' in node).map(toSummary);
}

export async function getIssue(repo: Repo, number: number): Promise<IssueDetail> {
    const data = await graphql<{ repository: { issue: IssueNode } }>(
        `query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
                issue(number: $number) { ${ISSUE_FIELDS} body commentList: comments(first: 100) { nodes { author { login } createdAt body } } }
            }
        }`,
        { owner: repo.owner ?? '', name: repo.name ?? '', number },
    );
    const node = data.repository.issue;
    return {
        ...toSummary(node),
        body: node.body ?? '',
        commentList: (node.commentList?.nodes ?? []).map((c) => ({ author: c.author?.login ?? 'ghost', createdAt: c.createdAt, body: c.body })),
        linkedBranches: await linkedBranches(repo, number),
    };
}

/** Branches liées à l'issue dans sa section « Development ». */
export async function linkedBranches(repo: Repo, number: number): Promise<string[]> {
    const result = await exec('gh', ['issue', 'develop', String(number), '--list', '--repo', repoSlug(repo)]);
    if (result.code !== 0) return [];
    return result.stdout
        .split('\n')
        .map((line) => line.split('\t')[0]?.trim() ?? '')
        .filter(Boolean);
}

/** Crée côté GitHub une branche liée à l'issue, depuis une branche distante. */
export async function createLinkedBranch(repo: Repo, number: number, name: string, base: string): Promise<void> {
    const result = await exec('gh', ['issue', 'develop', String(number), '--repo', repoSlug(repo), '--name', name, '--base', base]);
    if (result.code !== 0) throw new Error(`gh issue develop a échoué : ${result.stderr.trim() || result.stdout.trim()}`);
}

export async function pullRequestForBranch(repo: Repo, branch: string): Promise<PullRequestRef | undefined> {
    const list = await gh<PullRequestRef[]>(['pr', 'list', '--repo', repoSlug(repo), '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,title,state,isDraft,baseRefName,headRefName']);
    return list[0];
}

/** Texte de l'issue tel qu'il est attaché aux prompts : des données, pas des instructions. */
export function issueAsContext(repo: Repo, issue: IssueDetail): string {
    const lines = [`<issue repo="${repoSlug(repo)}" number="${issue.number}" url="${issue.url}" author="${issue.author}" state="${issue.state.toLowerCase()}">`, `# ${issue.title}`, ''];
    if (issue.labels.length) lines.push(`Labels : ${issue.labels.map((l) => l.name).join(', ')}`, '');
    lines.push(issue.body.trim() || '(pas de description)');
    if (issue.subIssues.length) {
        lines.push('', '## Sous-issues', ...issue.subIssues.map((s) => `- #${s.number} ${s.title} (${s.state.toLowerCase()})`));
    }
    if (issue.commentList.length) {
        lines.push('', '## Commentaires');
        for (const comment of issue.commentList) lines.push(`### @${comment.author} · ${comment.createdAt.slice(0, 10)}`, comment.body.trim(), '');
    }
    lines.push('</issue>');
    return lines.join('\n');
}

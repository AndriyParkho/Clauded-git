import { exec } from './exec.js';
import { forget, memo } from './memo.js';
import type { Issue, IssueDetail, IssueFilter, IssueRef, IssueState, IssueStatus, PullRequestRef, Repo } from '../shared/protocol.js';

/** Taille d'une page de la liste des issues (le champ `projectItems` alourdit chaque nœud). */
export const ISSUES_PAGE_SIZE = 40;

type IssueSummary = Issue;

export function repoSlug(repo: Repo): string {
    if (!repo.owner || !repo.name) throw new Error(`dépôt sans remote GitHub : ${repo.path}`);
    return `${repo.owner}/${repo.name}`;
}

export async function gh<T>(args: string[], cwd?: string): Promise<T> {
    const result = await exec('gh', args, cwd ? { cwd } : {});
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}… a échoué : ${result.stderr.trim() || result.stdout.trim()}`);
    try {
        return JSON.parse(result.stdout) as T;
    } catch {
        throw new Error(`gh ${args.slice(0, 3).join(' ')}… : réponse illisible`);
    }
}

/**
 * Comme `graphql`, mais garde les données d'une réponse partielle (un alias sur un numéro qui
 * n'existe pas vaut `null` au lieu de faire échouer toute la requête).
 */
export async function graphqlPartial<T>(query: string, variables: Record<string, string | number>): Promise<T> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    // `gh api` sort en erreur sur une réponse partielle : on relit sa sortie quand même.
    const result = await exec('gh', args);
    let payload: { data?: T; errors?: Array<{ message: string }> };
    try {
        payload = JSON.parse(result.stdout) as typeof payload;
    } catch {
        throw new Error(`gh api graphql a échoué : ${result.stderr.trim() || result.stdout.trim()}`);
    }
    if (!payload.data) throw new Error(`GitHub : ${payload.errors?.map((e) => e.message).join(' ; ') ?? 'réponse vide'}`);
    return payload.data;
}

export async function graphql<T>(query: string, variables: Record<string, string | number>): Promise<T> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    const payload = await gh<{ data?: T; errors?: Array<{ message: string }> }>(args);
    if (payload.errors?.length) throw new Error(`GitHub : ${payload.errors.map((e) => e.message).join(' ; ')}`);
    if (!payload.data) throw new Error('GitHub : réponse vide');
    return payload.data;
}

// Champs GraphQL d'une issue, sous-issues et parent compris (relations natives GitHub), et le
// champ « Status » des GitHub Projects où elle est rangée (scope `read:project` du token `gh`).
const ISSUE_FIELDS = `
    number title state url createdAt updatedAt
    repository { nameWithOwner }
    author { login }
    assignees(first: 10) { nodes { login } }
    labels(first: 20) { nodes { name color } }
    comments { totalCount }
    parent { number }
    subIssues(first: 50) { nodes { number title state repository { nameWithOwner } } }
    projectItems(first: 5) {
        nodes {
            project { title }
            fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { options { name } } } }
            }
        }
    }
`;

interface ProjectItemNode {
    project: { title: string } | null;
    fieldValueByName: { name: string; field: { options: Array<{ name: string }> } } | null;
}

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
    closedByPullRequestsReferences?: { nodes: PullRequestRef[] };
    parent: { number: number } | null;
    repository: { nameWithOwner: string };
    subIssues: { nodes: Array<Omit<IssueRef, 'otherRepo'> & { repository: { nameWithOwner: string } }> };
    projectItems?: { nodes: ProjectItemNode[] };
}

/** Le premier projet où l'issue a un statut (une issue est rarement dans plusieurs projets). */
function projectStatus(node: IssueNode): IssueStatus | null {
    for (const item of node.projectItems?.nodes ?? []) {
        const value = item.fieldValueByName;
        if (!value?.name) continue;
        const order = value.field?.options.findIndex((o) => o.name === value.name) ?? -1;
        return { project: item.project?.title ?? '', name: value.name, order: order < 0 ? 999 : order };
    }
    return null;
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
        subIssues: node.subIssues.nodes.map(({ repository, ...sub }) =>
            // Une sous-issue peut vivre dans un autre dépôt : son numéro y désigne autre chose.
            repository.nameWithOwner.toLowerCase() === node.repository.nameWithOwner.toLowerCase() ? sub : { ...sub, otherRepo: repository.nameWithOwner },
        ),
        status: projectStatus(node),
    };
}

export interface IssuesPage {
    issues: IssueSummary[];
    nextCursor: string | null;
}

/** Une page d'issues d'un dépôt, via la recherche GitHub (`@me` = le compte connecté à `gh`). */
export async function listIssues(repo: Repo, filter: IssueFilter, state: IssueState, after: string | null = null): Promise<IssuesPage> {
    const q = [
        `repo:${repoSlug(repo)}`,
        'is:issue',
        state === 'all' ? '' : `state:${state}`,
        filter === 'assigned' ? 'assignee:@me' : filter === 'created' ? 'author:@me' : '',
        'sort:updated-desc',
    ]
        .filter(Boolean)
        .join(' ');
    const variables: Record<string, string | number> = { q, first: ISSUES_PAGE_SIZE };
    if (after) variables.after = after;
    const data = await graphql<{ search: { nodes: Array<IssueNode | Record<string, never>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
        `query($q: String!, $first: Int!, $after: String) {
            search(query: $q, type: ISSUE, first: $first, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { ... on Issue { ${ISSUE_FIELDS} } }
            }
        }`,
        variables,
    );
    return {
        issues: data.search.nodes.filter((node): node is IssueNode => 'number' in node).map(toSummary),
        nextCursor: data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null,
    };
}

/**
 * Lectures GitHub gardées quelques secondes : à l'ouverture d'une issue ou d'un onglet, plusieurs
 * routes demandent la même issue, la même PR ou la PR de la même branche en même temps.
 */
export const GITHUB_READ_TTL_MS = 10_000;

/** Détail d'une issue (gardé GITHUB_READ_TTL_MS, appels simultanés partagés). */
export function getIssue(repo: Repo, number: number): Promise<IssueDetail> {
    return memo(`issue:${repo.id}:${number}`, GITHUB_READ_TTL_MS, () => fetchIssue(repo, number));
}

/** À appeler après une écriture sur l'issue (branche liée créée…). */
export function forgetIssue(repo: Repo, number: number): void {
    forget(`issue:${repo.id}:${number}`);
}

async function fetchIssue(repo: Repo, number: number): Promise<IssueDetail> {
    // Les branches liées viennent d'un autre appel `gh` : lancé en même temps que la requête GraphQL.
    const branches = linkedBranches(repo, number);
    const data = await graphql<{ repository: { issue: IssueNode } }>(
        `query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
                issue(number: $number) {
                    ${ISSUE_FIELDS}
                    body
                    commentList: comments(first: 100) { nodes { author { login } createdAt body } }
                    closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number url title state isDraft baseRefName headRefName } }
                }
            }
        }`,
        { owner: repo.owner ?? '', name: repo.name ?? '', number },
    );
    const node = data.repository.issue;
    return {
        ...toSummary(node),
        body: node.body ?? '',
        commentList: (node.commentList?.nodes ?? []).map((c) => ({ author: c.author?.login ?? 'ghost', createdAt: c.createdAt, body: c.body })),
        linkedBranches: await branches,
        pullRequests: node.closedByPullRequestsReferences?.nodes ?? [],
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
    forgetIssue(repo, number);
    if (result.code !== 0) throw new Error(`gh issue develop a échoué : ${result.stderr.trim() || result.stdout.trim()}`);
}

/** PR (ouverte ou non) dont la branche est la tête ; gardée GITHUB_READ_TTL_MS. */
export function pullRequestForBranch(repo: Repo, branch: string): Promise<PullRequestRef | undefined> {
    return memo(`branch-pr:${repo.id}:${branch}`, GITHUB_READ_TTL_MS, () => fetchPullRequestForBranch(repo, branch));
}

async function fetchPullRequestForBranch(repo: Repo, branch: string): Promise<PullRequestRef | undefined> {
    const list = await gh<PullRequestRef[]>(['pr', 'list', '--repo', repoSlug(repo), '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,title,state,isDraft,baseRefName,headRefName']);
    return list[0];
}

/** Texte de l'issue tel qu'il est attaché aux prompts : des données, pas des instructions. */
export function issueAsContext(repo: Repo, issue: IssueDetail): string {
    const lines = [`<issue repo="${repoSlug(repo)}" number="${issue.number}" url="${issue.url}" author="${issue.author}" state="${issue.state.toLowerCase()}">`, `# ${issue.title}`, ''];
    if (issue.labels.length) lines.push(`Labels : ${issue.labels.map((l) => l.name).join(', ')}`, '');
    lines.push(issue.body.trim() || '(pas de description)');
    if (issue.subIssues.length) {
        lines.push('', '## Sous-issues', ...issue.subIssues.map((s) => `- ${s.otherRepo ?? ''}#${s.number} ${s.title} (${s.state.toLowerCase()})`));
    }
    if (issue.commentList.length) {
        lines.push('', '## Commentaires');
        for (const comment of issue.commentList) lines.push(`### @${comment.author} · ${comment.createdAt.slice(0, 10)}`, comment.body.trim(), '');
    }
    lines.push('</issue>');
    return lines.join('\n');
}

/** Identifiants GraphQL (node id) des issues, pour les mutations. */
export async function issueNodeIds(repo: Repo, numbers: number[]): Promise<Map<number, string>> {
    if (numbers.length === 0) return new Map();
    const fields = numbers.map((n) => `i${n}: issue(number: ${n}) { id }`).join('\n');
    const data = await graphql<{ repository: Record<string, { id: string } | null> }>(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, {
        owner: repo.owner ?? '',
        name: repo.name ?? '',
    });
    const ids = new Map<number, string>();
    for (const n of numbers) {
        const id = data.repository[`i${n}`]?.id;
        if (id) ids.set(n, id);
    }
    return ids;
}

/**
 * Écrit sur GitHub des relations « bloquée par » (`issue` attend `dependsOn`). Une relation qui
 * existe déjà n'est pas une erreur ; les autres refus sont rendus comme avertissements.
 */
export async function addBlockedByLinks(repo: Repo, links: Array<{ issue: number; dependsOn: number }>): Promise<string[]> {
    if (links.length === 0) return [];
    const ids = await issueNodeIds(repo, [...new Set(links.flatMap((l) => [l.issue, l.dependsOn]))]);
    const warnings: string[] = [];
    for (const link of links) {
        const issue = ids.get(link.issue);
        const blocking = ids.get(link.dependsOn);
        if (!issue || !blocking) continue;
        await graphql(`mutation($issue: ID!, $blocking: ID!) { addBlockedBy(input: { issueId: $issue, blockingIssueId: $blocking }) { issue { number } } }`, { issue, blocking }).catch((error: unknown) => {
            if (!/already|duplicate/i.test(String(error))) warnings.push(`#${link.issue} bloquée par #${link.dependsOn} non écrite sur GitHub : ${String(error)}`);
        });
    }
    return warnings;
}

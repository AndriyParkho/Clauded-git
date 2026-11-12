import type { ReactElement } from 'react';
import { useState } from 'react';
import type { Item, ToolItem } from './items';
import { ItemView } from './MessageList';

const PREVIEW_LIMIT = 6000;

function str(value: unknown): string {
    return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}

/** Résumé d'une ligne, selon l'outil, comme dans Claude Code. */
function summary(tool: ToolItem): { label: string; detail: string } {
    const input = tool.input;
    switch (tool.name) {
        case 'Bash':
            return { label: 'Bash', detail: str(input.description) || str(input.command) };
        case 'Read':
            return { label: 'Lecture', detail: str(input.file_path) };
        case 'Edit':
            return { label: 'Édition', detail: str(input.file_path) };
        case 'Write':
            return { label: 'Écriture', detail: str(input.file_path) };
        case 'Glob':
            return { label: 'Glob', detail: `${str(input.pattern)}${input.path ? ` dans ${str(input.path)}` : ''}` };
        case 'Grep':
            return { label: 'Grep', detail: `${str(input.pattern)}${input.path ? ` dans ${str(input.path)}` : ''}` };
        case 'Agent':
        case 'Task':
            return { label: `Sous-agent${input.subagent_type ? ` ${str(input.subagent_type)}` : ''}`, detail: str(input.description) };
        case 'Skill':
            return { label: 'Skill', detail: `${str(input.skill)} ${str(input.args)}`.trim() };
        case 'TodoWrite':
            return { label: 'Tâches', detail: `${Array.isArray(input.todos) ? input.todos.length : 0} éléments` };
        case 'WebFetch':
        case 'WebSearch':
            return { label: tool.name, detail: str(input.url ?? input.query) };
        case 'AskUserQuestion':
            return { label: 'Question', detail: Array.isArray(input.questions) ? str((input.questions[0] as { question?: string })?.question) : '' };
        case 'ExitPlanMode':
            return { label: 'Plan', detail: 'proposition de plan' };
        default:
            return { label: tool.name, detail: str(input.description ?? input.file_path ?? input.command ?? '') };
    }
}

function Truncated({ text, className }: { text: string; className?: string }): ReactElement {
    const [full, setFull] = useState(false);
    const long = text.length > PREVIEW_LIMIT;
    return (
        <pre className={className}>
            {full || !long ? text : `${text.slice(0, PREVIEW_LIMIT)}…`}
            {long && (
                <button className="link" onClick={() => setFull(!full)}>
                    {full ? ' réduire' : ` voir tout (${text.length.toLocaleString('fr-FR')} caractères)`}
                </button>
            )}
        </pre>
    );
}

function EditDiff({ input }: { input: Record<string, unknown> }): ReactElement {
    return (
        <div className="diff">
            <pre className="diff-old">{str(input.old_string)}</pre>
            <pre className="diff-new">{str(input.new_string)}</pre>
        </div>
    );
}

function Todos({ input }: { input: Record<string, unknown> }): ReactElement {
    const todos = (Array.isArray(input.todos) ? input.todos : []) as Array<{ content: string; status: string }>;
    return (
        <ul className="todos">
            {todos.map((todo, i) => (
                <li key={i} className={`todo-${todo.status}`}>
                    {todo.status === 'completed' ? '☑' : todo.status === 'in_progress' ? '◐' : '☐'} {todo.content}
                </li>
            ))}
        </ul>
    );
}

export function ToolCard({ tool }: { tool: ToolItem }): ReactElement {
    const { label, detail } = summary(tool);
    const isError = tool.result?.isError ?? false;
    const pending = !tool.result;
    const openByDefault = tool.name === 'Edit' || tool.name === 'TodoWrite' || isError;

    return (
        <details className={`tool ${isError ? 'tool-error' : ''} ${pending ? 'tool-pending' : ''}`} open={openByDefault}>
            <summary>
                <span className="tool-label">{label}</span>
                <span className="tool-detail">{detail}</span>
                {pending && <span className="tool-spinner" title="en cours">…</span>}
            </summary>
            <div className="tool-body">
                {tool.name === 'Bash' && <pre className="cmd">$ {str(tool.input.command)}</pre>}
                {tool.name === 'Edit' && <EditDiff input={tool.input} />}
                {tool.name === 'Write' && <Truncated text={str(tool.input.content)} className="file" />}
                {tool.name === 'TodoWrite' && <Todos input={tool.input} />}
                {!['Bash', 'Edit', 'Write', 'TodoWrite'].includes(tool.name) && <pre className="json">{JSON.stringify(tool.input, null, 2)}</pre>}
                {tool.children.length > 0 && (
                    <div className="subagent">
                        {tool.children.map((child: Item) => (
                            <ItemView key={child.key} item={child} />
                        ))}
                    </div>
                )}
                {tool.result && <Truncated text={tool.result.content || '(vide)'} className={`result ${isError ? 'error' : ''}`} />}
            </div>
        </details>
    );
}

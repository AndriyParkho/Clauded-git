import type { ReactElement } from 'react';
import { useState } from 'react';
import { Markdown } from '../Markdown';
import { send } from '../../ws';
import type { AskRequest } from '../../../../shared/protocol';

interface Question {
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
}

function QuestionsCard({ ask }: { ask: AskRequest }): ReactElement {
    const questions = (Array.isArray(ask.input.questions) ? ask.input.questions : []) as Question[];
    const [choices, setChoices] = useState<Record<string, string[]>>({});
    const [other, setOther] = useState<Record<string, string>>({});

    const toggle = (question: Question, label: string): void => {
        const current = choices[question.question] ?? [];
        const next = question.multiSelect ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label];
        setChoices({ ...choices, [question.question]: next });
    };

    const complete = questions.every((q) => (choices[q.question]?.length ?? 0) > 0 || other[q.question]?.trim());

    const submit = (): void => {
        const answers: Record<string, string> = {};
        for (const q of questions) {
            const free = other[q.question]?.trim();
            answers[q.question] = free || (choices[q.question] ?? []).join(', ');
        }
        send({ type: 'answer', runId: ask.runId, requestId: ask.id, allow: true, updatedInput: { ...ask.input, answers } });
    };

    return (
        <div className="ask">
            <div className="ask-title">Claude te pose une question</div>
            {questions.map((q) => (
                <div key={q.question} className="ask-question">
                    {q.header && <div className="ask-header">{q.header}</div>}
                    <div className="ask-text">{q.question}</div>
                    <div className="ask-options">
                        {q.options.map((option) => (
                            <button key={option.label} className={`option ${(choices[q.question] ?? []).includes(option.label) ? 'selected' : ''}`} onClick={() => toggle(q, option.label)} title={option.description}>
                                <span>{option.label}</span>
                                {option.description && <span className="muted">{option.description}</span>}
                            </button>
                        ))}
                    </div>
                    <input className="ask-other" placeholder="Autre réponse…" value={other[q.question] ?? ''} onChange={(e) => setOther({ ...other, [q.question]: e.target.value })} />
                </div>
            ))}
            <div className="ask-actions">
                <button className="primary" disabled={!complete} onClick={submit}>
                    Répondre
                </button>
            </div>
        </div>
    );
}

function PlanCard({ ask }: { ask: AskRequest }): ReactElement {
    const [feedback, setFeedback] = useState('');
    const plan = typeof ask.input.plan === 'string' ? ask.input.plan : JSON.stringify(ask.input, null, 2);
    return (
        <div className="ask">
            <div className="ask-title">Plan proposé</div>
            <div className="plan">
                <Markdown text={plan} />
            </div>
            <textarea className="ask-feedback" placeholder="Remarques si tu refuses (optionnel)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            <div className="ask-actions">
                <button className="primary" onClick={() => send({ type: 'answer', runId: ask.runId, requestId: ask.id, allow: true })}>
                    Valider et implémenter
                </button>
                <button onClick={() => send({ type: 'answer', runId: ask.runId, requestId: ask.id, allow: false, message: feedback || 'Plan refusé, propose autre chose.' })}>
                    Refuser
                </button>
            </div>
        </div>
    );
}

function GenericCard({ ask }: { ask: AskRequest }): ReactElement {
    return (
        <div className="ask">
            <div className="ask-title">{ask.tool}</div>
            <pre className="json">{JSON.stringify(ask.input, null, 2)}</pre>
            <div className="ask-actions">
                <button className="primary" onClick={() => send({ type: 'answer', runId: ask.runId, requestId: ask.id, allow: true })}>
                    Autoriser
                </button>
                <button onClick={() => send({ type: 'answer', runId: ask.runId, requestId: ask.id, allow: false })}>Refuser</button>
            </div>
        </div>
    );
}

export function AskCard({ ask }: { ask: AskRequest }): ReactElement {
    if (ask.tool === 'AskUserQuestion') return <QuestionsCard ask={ask} />;
    if (ask.tool === 'ExitPlanMode') return <PlanCard ask={ask} />;
    return <GenericCard ask={ask} />;
}

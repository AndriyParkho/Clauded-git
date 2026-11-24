import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MermaidApi = typeof import('mermaid').default;

let mermaidLoad: Promise<MermaidApi> | undefined;
let mermaidId = 0;
/** SVG déjà rendus, par source : un message ou une spec rerendu ne refait pas le diagramme. */
const rendered = new Map<string, { svg: string } | { error: string }>();

/** Mermaid est lourd : chargé au premier diagramme seulement. */
function loadMermaid(): Promise<MermaidApi> {
    mermaidLoad ??= import('mermaid').then(({ default: mermaid }) => {
        // Couleurs alignées sur le design system (styles.css, :root).
        mermaid.initialize({
            startOnLoad: false,
            theme: 'base',
            securityLevel: 'strict',
            fontFamily: 'inherit',
            themeVariables: {
                darkMode: true,
                background: '#0F172A',
                primaryColor: '#1B2336',
                primaryTextColor: '#E2E8F0',
                primaryBorderColor: '#60A5FA',
                secondaryColor: '#1E293B',
                tertiaryColor: '#131B2E',
                lineColor: '#94A3B8',
                textColor: '#E2E8F0',
                noteBkgColor: '#1A2A47',
                noteTextColor: '#E2E8F0',
                noteBorderColor: '#3A475D',
            },
        });
        return mermaid;
    });
    return mermaidLoad;
}

function Mermaid({ code }: { code: string }): ReactElement {
    const [result, setResult] = useState(rendered.get(code));
    useEffect(() => {
        const cached = rendered.get(code);
        if (cached) {
            setResult(cached);
            return;
        }
        let live = true;
        setResult(undefined);
        loadMermaid()
            .then((mermaid) => mermaid.render(`mermaid-${++mermaidId}`, code))
            .then(({ svg }) => ({ svg }))
            .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
            .then((next) => {
                rendered.set(code, next);
                if (live) setResult(next);
            });
        return () => {
            live = false;
        };
    }, [code]);

    if (result && 'svg' in result) return <div className="mermaid" dangerouslySetInnerHTML={{ __html: result.svg }} />;
    return (
        <div className="mermaid-source">
            <pre>
                <code>{code}</code>
            </pre>
            {result && 'error' in result && <div className="muted small-link">diagramme illisible : {result.error.split('\n')[0]}</div>}
        </div>
    );
}

interface HastNode {
    type: string;
    tagName?: string;
    value?: string;
    properties?: { className?: unknown };
    children?: HastNode[];
}

/** Source d'un bloc ```mermaid, si `pre` en est un. */
function mermaidSource(pre: HastNode | undefined): string | undefined {
    const code = pre?.children?.find((c) => c.type === 'element');
    const classes = code?.tagName === 'code' && Array.isArray(code.properties?.className) ? (code.properties.className as unknown[]) : [];
    if (!classes.includes('language-mermaid')) return undefined;
    return (code?.children ?? [])
        .map((c) => c.value ?? '')
        .join('')
        .trimEnd();
}

export function Markdown({ text }: { text: string }): ReactElement {
    return (
        <div className="markdown">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noreferrer">
                            {children}
                        </a>
                    ),
                    pre: ({ node, children }) => {
                        const source = mermaidSource(node as HastNode | undefined);
                        return source !== undefined ? <Mermaid code={source} /> : <pre>{children}</pre>;
                    },
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}

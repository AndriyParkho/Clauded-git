import type { ReactElement } from 'react';

/**
 * Icônes SVG au trait (tracés inspirés de Lucide, sans dépendance). Elles héritent de la couleur
 * du texte et sont décoratives : le libellé ou le `title` du bouton porte le sens.
 */
const PATHS = {
    issue: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
    pr: 'M6 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M6 9v12 M13 6h3a2 2 0 0 1 2 2v7',
    spec: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
    repos: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    code: 'M16 18l6-6-6-6 M8 6l-6 6 6 6',
    merge: 'M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M6 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M6 21V9a9 9 0 0 0 9 9',
    search: 'M11 11m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0 M21 21l-4.35-4.35',
    plus: 'M12 5v14 M5 12h14',
    x: 'M18 6L6 18 M6 6l12 12',
    chevronDown: 'M6 9l6 6 6-6',
    chevronRight: 'M9 18l6-6-6-6',
    sidebar: 'M3 3h18v18H3z M9 3v18',
    more: 'M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0 M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0 M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
    terminal: 'M4 17l6-6-6-6 M12 19h8',
    external: 'M15 3h6v6 M10 14L21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    keyboard: 'M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l4 2',
    gauge: 'M12 14l4-4 M3.34 19a10 10 0 1 1 17.32 0',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    play: 'M6 4l14 8-14 8z',
    split: 'M3 3h18v18H3z M12 3v18',
    maximize: 'M8 3H5a2 2 0 0 0-2 2v3 M21 8V5a2 2 0 0 0-2-2h-3 M3 16v3a2 2 0 0 0 2 2h3 M16 21h3a2 2 0 0 0 2-2v-3',
    refresh: 'M21 12a9 9 0 1 1-2.64-6.36L21 8 M21 3v5h-5',
    investigate: 'M22 12h-4l-3 9L9 3l-3 9H2',
    question: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01',
    commit: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M3 12h5M16 12h5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }): ReactElement {
    return (
        <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d={PATHS[name]} />
        </svg>
    );
}

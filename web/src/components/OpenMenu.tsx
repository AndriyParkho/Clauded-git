import type { ReactElement, ReactNode } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Menu, MenuLabel, MenuSeparator } from './Menu';
import type { OpenApp } from '../../../shared/protocol';

const APPS: Array<{ value: OpenApp; label: string }> = [
    { value: 'vscode', label: 'VS Code' },
    { value: 'finder', label: 'Finder' },
    { value: 'terminal', label: 'Terminal' },
    { value: 'iterm', label: 'iTerm' },
];

/**
 * « Ouvrir ▾ » : un dossier (dépôt ou worktree) dans VS Code, le Finder, Terminal ou iTerm.
 * `children` : actions en plus sous un séparateur (Bruno).
 */
export function OpenMenu({ path, label = 'Ouvrir', runId, small, children }: { path: string; label?: string; runId?: number; small?: boolean; children?: ReactNode }): ReactElement {
    const notify = useStore((s) => s.notify);
    const openIn = async (app: OpenApp): Promise<void> => {
        try {
            await api.openIn(path, app);
        } catch (error) {
            notify(String(error), runId);
        }
    };
    return (
        <Menu label={label} icon="external" title={path} small={small ?? false} keepMounted={children !== undefined}>
            <MenuLabel>{path.replace(/^\/Users\/[^/]+/, '~')}</MenuLabel>
            {APPS.map((app) => (
                <button key={app.value} role="menuitem" onClick={() => void openIn(app.value)}>
                    {app.label}
                </button>
            ))}
            {children && (
                <>
                    <MenuSeparator />
                    {children}
                </>
            )}
        </Menu>
    );
}

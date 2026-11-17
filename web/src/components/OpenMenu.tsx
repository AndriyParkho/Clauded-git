import type { ReactElement } from 'react';
import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { OpenApp } from '../../../shared/protocol';

const APPS: Array<{ value: OpenApp; label: string }> = [
    { value: 'vscode', label: 'VS Code' },
    { value: 'finder', label: 'Finder' },
    { value: 'terminal', label: 'Terminal' },
    { value: 'iterm', label: 'iTerm' },
];

/** « Ouvrir ▾ » : un dossier (dépôt ou worktree) dans VS Code, le Finder, Terminal ou iTerm. */
export function OpenMenu({ path, label = 'Ouvrir ▾', runId, small }: { path: string; label?: string; runId?: number; small?: boolean }): ReactElement {
    const notify = useStore((s) => s.notify);
    const [open, setOpen] = useState(false);
    const openIn = async (app: OpenApp): Promise<void> => {
        setOpen(false);
        try {
            await api.openIn(path, app);
        } catch (error) {
            notify(String(error), runId);
        }
    };
    return (
        <span className="menu">
            <button className={small ? 'small' : ''} onClick={() => setOpen(!open)} title={path}>
                {label}
            </button>
            {open && (
                <div className="menu-items" onMouseLeave={() => setOpen(false)}>
                    {APPS.map((app) => (
                        <button key={app.value} onClick={() => void openIn(app.value)}>
                            {app.label}
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
}

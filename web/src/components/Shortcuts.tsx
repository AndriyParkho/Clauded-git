import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { useStore } from '../store';
import { ALT, MOD, paneRun, showRun, useUi } from '../ui';
import { Modal } from './Modal';
import { orderedRuns } from './Tabs';

function editable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/**
 * Raccourcis globaux : ⌘K palette, ⌘B rail, ⌥1…⌥9 et ⌥↑/⌥↓ pour changer d'onglet, ? pour l'aide.
 * ⌥ + chiffre est lu sur `code` : sur Mac, `key` donne le caractère spécial (¡, ™…).
 */
export function useShortcuts(): void {
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            const ui = useUi.getState();
            const mod = e.metaKey || e.ctrlKey;
            if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                ui.setPalette(!ui.palette);
                return;
            }
            if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
                e.preventDefault();
                ui.toggleRail();
                return;
            }
            if (e.altKey && !mod) {
                const { runs, repos } = useStore.getState();
                const order = orderedRuns(runs, repos);
                const digit = /^Digit([1-9])$/.exec(e.code);
                if (digit) {
                    const run = order[Number(digit[1]) - 1];
                    if (run) {
                        e.preventDefault();
                        showRun(run.id);
                    }
                    return;
                }
                if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !editable(e.target) && order.length > 0) {
                    e.preventDefault();
                    const shown = paneRun(ui.focusedPane);
                    const current = shown === undefined ? -1 : order.findIndex((r) => r.id === shown);
                    const step = e.key === 'ArrowDown' ? 1 : -1;
                    const next = current === -1 ? (step === 1 ? 0 : order.length - 1) : (current + step + order.length) % order.length;
                    const run = order[next];
                    if (run) showRun(run.id);
                }
                return;
            }
            if (e.key === '?' && !mod && !editable(e.target)) {
                e.preventDefault();
                ui.setShortcuts(!ui.shortcuts);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
}

const KEYS: Array<{ keys: string[]; label: string }> = [
    { keys: [MOD, 'K'], label: 'Palette : onglets, pages, nouveau chat, anciennes sessions' },
    { keys: [MOD, 'B'], label: 'Replier / déplier le rail' },
    { keys: [ALT, '1…9'], label: 'Aller au n-ième onglet du rail' },
    { keys: [ALT, '↑ / ↓'], label: 'Onglet précédent / suivant' },
    { keys: [ALT, 'clic'], label: 'Ouvrir un onglet du rail à côté (ou le glisser vers la droite)' },
    { keys: [MOD, '↵'], label: 'Dans la palette : ouvrir à côté' },
    { keys: ['?'], label: 'Afficher cette aide' },
    { keys: ['Échap'], label: 'Fermer un menu, la palette ou une fenêtre' },
];

export function ShortcutsDialog(): ReactElement | null {
    const open = useUi((s) => s.shortcuts);
    const setShortcuts = useUi((s) => s.setShortcuts);
    if (!open) return null;
    return (
        <Modal className="shortcuts-modal" onClose={() => setShortcuts(false)}>
            <div className="panel-head">
                <span>Raccourcis clavier</span>
                <button className="small" onClick={() => setShortcuts(false)} aria-label="Fermer">
                    ×
                </button>
            </div>
            <dl className="shortcuts">
                {KEYS.map((k) => (
                    <div key={k.label} className="shortcut-row">
                        <dt>
                            {k.keys.map((key) => (
                                <kbd key={key}>{key}</kbd>
                            ))}
                        </dt>
                        <dd>{k.label}</dd>
                    </div>
                ))}
            </dl>
        </Modal>
    );
}

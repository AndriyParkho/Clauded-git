import '../styles/notifications.css';
import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { nextWaiting, refreshPermission, useNotificationPrefs } from '../attention';
import { useStore } from '../store';
import { ALT, MOD, paneRun, showRun, useUi } from '../ui';
import { Modal } from './Modal';
import { orderedRuns } from './Tabs';

function editable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/**
 * Raccourcis globaux : ⌘K palette, ⌘B rail, ⌥1…⌥9 et ⌥↑/⌥↓ pour changer d'onglet, ⌥A pour le
 * prochain onglet qui attend, ? pour l'aide.
 * ⌥ + chiffre ou lettre est lu sur `code` : sur Mac, `key` donne le caractère spécial (¡, ™, æ…).
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
                // ⌥A tape « å » sur Mac : dans un champ de saisie, la touche reste au champ.
                if (e.code === 'KeyA' && !e.shiftKey && !editable(e.target)) {
                    const run = nextWaiting(order, paneRun(ui.focusedPane));
                    if (run) {
                        e.preventDefault();
                        showRun(run.id);
                    } else if (!editable(e.target)) {
                        e.preventDefault();
                        useStore.getState().notify("Aucun autre onglet n'attend ta réponse.", { kind: 'info', key: 'next-waiting' });
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
    { keys: [ALT, 'A'], label: 'Prochain onglet qui attend ta réponse' },
    { keys: [ALT, 'clic'], label: 'Ouvrir un onglet du rail à côté (ou le glisser vers la droite)' },
    { keys: [MOD, '↵'], label: 'Dans la palette : ouvrir à côté' },
    { keys: ['j', 'k'], label: 'Issues et PR : ligne suivante / précédente (aussi ↓ ↑)' },
    { keys: ['↵'], label: 'Issues et PR : aller à l\'action principale (↵ encore pour la lancer)' },
    { keys: ['x'], label: 'Issues : cocher pour un lot' },
    { keys: ['/'], label: 'Issues et PR : rechercher dans la liste' },
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
            <NotificationPref />
        </Modal>
    );
}

/** Interrupteur des notifications système (onglet qui attend ou finit son tour hors de vue). */
function NotificationPref(): ReactElement {
    const system = useNotificationPrefs((s) => s.system);
    const permission = useNotificationPrefs((s) => s.permission);
    const setSystem = useNotificationPrefs((s) => s.setSystem);
    useEffect(refreshPermission, []);
    let hint = 'La permission du navigateur est demandée à la première notification.';
    if (permission === 'unsupported') hint = 'Ce navigateur ne gère pas les notifications système.';
    else if (permission === 'denied') hint = 'Bloquées par le navigateur : autorise-les dans les réglages du site.';
    else if (permission === 'granted') hint = 'Envoyées quand la fenêtre n\'a pas le focus ; sinon, un toast suffit.';
    return (
        <div className="notif-pref">
            <label className="notif-pref-row">
                <input type="checkbox" role="switch" className="notif-switch" checked={system} disabled={permission === 'unsupported'} onChange={(e) => setSystem(e.target.checked)} aria-describedby="notif-pref-hint" />
                Notifications système quand un onglet attend ta réponse ou finit son tour
            </label>
            <p id="notif-pref-hint" className={`notif-pref-hint ${system && permission === 'denied' ? 'warn' : ''}`}>
                {hint}
            </p>
        </div>
    );
}

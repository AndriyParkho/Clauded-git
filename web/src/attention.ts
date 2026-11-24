import { useEffect } from 'react';
import { create } from 'zustand';
import { onRunTransition, useStore } from './store';
import { paneRun, showRun, useUi } from './ui';
import { repoName } from './components/Tabs';
import type { Run } from '../../shared/protocol';

/**
 * Attention portée aux onglets qui attendent : quand un onglet hors de vue (ou la fenêtre sans le
 * focus) attend une réponse ou finit son tour, un toast « Ouvrir » et une notification système le
 * signalent ; le titre du document compte les onglets qui attendent.
 */

const PREF_KEY = 'clauded.notifications';

const supported = typeof window !== 'undefined' && 'Notification' in window;

function readPref(): boolean {
    try {
        return localStorage.getItem(PREF_KEY) !== 'off';
    } catch {
        return true;
    }
}

interface NotificationPrefs {
    /** Notifications système voulues (la permission du navigateur est à part). */
    system: boolean;
    /** Permission du navigateur, relue après chaque demande. */
    permission: NotificationPermission | 'unsupported';
    setSystem(on: boolean): void;
}

export const useNotificationPrefs = create<NotificationPrefs>((set) => ({
    system: readPref(),
    permission: supported ? Notification.permission : 'unsupported',
    setSystem: (on) => {
        try {
            localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
        } catch {
            // stockage indisponible : le choix ne survivra pas au rechargement
        }
        set({ system: on });
        // Activé à la main : c'est le bon moment pour demander la permission (geste de l'utilisateur).
        if (on) void askPermission();
    },
}));

/** Relit la permission (elle a pu changer dans les réglages du navigateur). */
export function refreshPermission(): void {
    if (supported) useNotificationPrefs.setState({ permission: Notification.permission });
}

async function askPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!supported) return 'unsupported';
    if (Notification.permission !== 'default') {
        useNotificationPrefs.setState({ permission: Notification.permission });
        return Notification.permission;
    }
    try {
        const permission = await Notification.requestPermission();
        useNotificationPrefs.setState({ permission });
        return permission;
    } catch {
        return Notification.permission;
    }
}

/** Notification système affichée par onglet, pour la fermer quand il ne l'attend plus. */
const shown = new Map<number, Notification>();

function closeSystem(runId: number): void {
    shown.get(runId)?.close();
    shown.delete(runId);
}

async function notifySystem(run: Run, text: string): Promise<void> {
    if (!useNotificationPrefs.getState().system) return;
    // La permission ne se demande que sur un clic (Safari et Firefox refusent sinon) : si elle n'est
    // pas encore accordée, le toast propose de l'activer.
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    closeSystem(run.id);
    const repo = repoName(run, useStore.getState().repos);
    const notification = new Notification(run.title || `Onglet #${run.id}`, { body: `${repo} · ${text}`, tag: `clauded-run-${run.id}` });
    notification.onclick = () => {
        window.focus();
        showRun(run.id);
        notification.close();
    };
    notification.onclose = () => {
        if (shown.get(run.id) === notification) shown.delete(run.id);
    };
    shown.set(run.id, notification);
}

/** L'onglet est-il sous les yeux : fenêtre au premier plan et onglet affiché dans un volet. */
function inView(runId: number): { focused: boolean; visible: boolean } {
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    const visible = paneRun(0) === runId || useUi.getState().panes.includes(runId);
    return { focused, visible };
}

const attentionKey = (runId: number): string => `attention:${runId}`;

function onTransition(run: Run, previous: Run): void {
    const store = useStore.getState();
    // L'onglet n'attend plus (réponse donnée ailleurs, tour relancé) : son signalement est périmé.
    if (previous.state === 'waiting' && run.state !== 'waiting') {
        store.dismissNoticeKey(attentionKey(run.id));
        closeSystem(run.id);
    }
    let text: string | undefined;
    if (run.state === 'waiting') text = 'attend ta réponse';
    else if (previous.state === 'running' && run.state === 'idle') text = 'a terminé son tour';
    else if (previous.state === 'running' && run.state === 'error') text = "s'est arrêté sur une erreur";
    if (!text) return;

    const { focused, visible } = inView(run.id);
    if (focused && visible) return;
    store.notify(`${run.title || `Onglet #${run.id}`} ${text}`, {
        kind: 'info',
        key: attentionKey(run.id),
        action: { label: 'Ouvrir', run: () => showRun(run.id) },
    });
    // Fenêtre au premier plan : le toast suffit, inutile de doubler par une notification système.
    if (!focused) void notifySystem(run, text);
    offerPermission();
}

let offered = false;

/**
 * Notifications système voulues mais jamais autorisées : une fois par visite, un toast propose de
 * les activer. Le clic sur « Activer » est le geste que les navigateurs exigent pour demander.
 */
function offerPermission(): void {
    if (offered || !useNotificationPrefs.getState().system || !('Notification' in window) || Notification.permission !== 'default') return;
    offered = true;
    useStore.getState().notify('Active les notifications système pour être prévenu quand un onglet attend, même fenêtre en arrière-plan.', {
        kind: 'info',
        key: 'notifications-permission',
        action: { label: 'Activer', run: () => void askPermission() },
    });
}

/** Nombre d'onglets qui attendent une réponse. */
function waitingCount(runs: Run[]): number {
    let count = 0;
    for (const run of runs) if (run.state === 'waiting') count++;
    return count;
}

/** Branche le suivi des onglets qui attendent et le titre du document. À appeler une fois (App). */
export function useAttention(): void {
    useEffect(() => onRunTransition(onTransition), []);

    const waiting = useStore((s) => waitingCount(s.runs));
    useEffect(() => {
        document.title = waiting > 0 ? `(${waiting}) clauded_git` : 'clauded_git';
    }, [waiting]);

    // Revenir sur la fenêtre ferme les notifications système des onglets désormais affichés.
    useEffect(() => {
        const onFocus = (): void => {
            for (const runId of [...shown.keys()]) if (inView(runId).visible) closeSystem(runId);
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, []);
}

/** Prochain onglet qui attend une réponse, dans l'ordre du rail, après `from` (en boucle). */
export function nextWaiting(order: Run[], from: number | undefined): Run | undefined {
    const start = from === undefined ? -1 : order.findIndex((r) => r.id === from);
    for (let step = 1; step <= order.length; step++) {
        const run = order[(start + step + order.length) % order.length];
        if (run?.state === 'waiting' && run.id !== from) return run;
    }
    return undefined;
}

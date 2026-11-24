import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { send } from '../ws';
import { Icon } from './Icon';
import { Menu } from './Menu';
import type { RateWindow } from '../../../shared/protocol';

export function timeAgo(timestamp: number): string {
    const minutes = Math.round((Date.now() - timestamp) / 60_000);
    if (minutes < 1) return 'à l\'instant';
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `il y a ${hours} h`;
    return `il y a ${Math.round(hours / 24)} j`;
}

function resetIn(target: Date): string {
    const minutes = Math.round((target.getTime() - Date.now()) / 60_000);
    if (minutes <= 0) return 'maintenant';
    if (minutes < 60) return `dans ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `dans ${hours} h ${String(minutes % 60).padStart(2, '0')}`;
    return `dans ${Math.floor(hours / 24)} j ${hours % 24} h`;
}

/** « 18:30 » si c'est aujourd'hui, sinon « mar. 18 nov. 09:00 ». */
function resetDate(target: Date): string {
    const time = target.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (target.toDateString() === new Date().toDateString()) return time;
    return `${target.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** Re-rendu périodique pour que les comptes à rebours restent justes. */
function useTick(ms: number): void {
    const [, setTick] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setTick((t) => t + 1), ms);
        return () => clearInterval(timer);
    }, [ms]);
}

function percentOf(window: RateWindow): number | null {
    // `utilization` est déjà un pourcentage (0-100).
    return window.utilization === null ? null : Math.round(window.utilization);
}

function levelOf(percent: number | null): string {
    return percent === null ? '' : percent >= 85 ? 'error' : percent >= 65 ? 'warn' : '';
}

function Gauge({ window }: { window: RateWindow }): ReactElement {
    const percent = percentOf(window);
    const level = levelOf(percent);
    const reset = window.resetsAt ? new Date(window.resetsAt) : null;
    return (
        <div className="gauge-row">
            <div className="gauge">
                <span className="gauge-label">{window.label}</span>
                <span className="gauge-bar">
                    <span className={`gauge-fill ${level}`} style={{ width: `${Math.min(percent ?? 0, 100)}%` }} />
                </span>
                <span className={`gauge-value ${level}`}>{percent === null ? '—' : `${percent} %`}</span>
            </div>
            {reset && (
                <div className="gauge-reset muted" title={reset.toLocaleString('fr-FR')}>
                    reset {resetDate(reset)} · {resetIn(reset)}
                </div>
            )}
        </div>
    );
}

/** Détail de la consommation du compte (fenêtres, extra, erreurs), avec relecture à la demande. */
export function UsageDetails(): ReactElement {
    const account = useStore((s) => s.account);
    const [refreshing, setRefreshing] = useState(false);
    useTick(30_000);
    useEffect(() => setRefreshing(false), [account]);

    const refresh = (): void => {
        setRefreshing(true);
        send({ type: 'refreshAccount' });
        // Filet si la réponse ne vient pas (serveur déconnecté) : le bouton redevient cliquable.
        setTimeout(() => setRefreshing(false), 35_000);
    };

    return (
        <div className="usage">
            <div className="usage-head">
                <span className="usage-title">Consommation{account?.subscription ? ` · ${account.subscription}` : ''}</span>
                <button className="small" data-keep-open="1" onClick={refresh} disabled={refreshing} title="Relire la consommation maintenant">
                    {refreshing ? '…' : <Icon name="refresh" size={13} />}
                </button>
            </div>
            {!account && <div className="muted gauge-note">lecture en cours…</div>}
            {account && !account.available && !account.error && <div className="muted gauge-note">pas de limites de forfait (clé d'API, Bedrock ou Vertex)</div>}
            {account?.windows.map((window) => <Gauge key={window.label} window={window} />)}
            {account?.extra && (
                <div className="muted gauge-note">
                    extra : {account.extra.used ?? 0}
                    {account.extra.limit !== null ? ` / ${account.extra.limit}` : ''}
                    {account.extra.currency ? ` ${account.extra.currency}` : ''}
                </div>
            )}
            {account?.error && (
                <div className="error gauge-note" title={account.error}>
                    lecture impossible : {account.error}
                </div>
            )}
            {account && <div className="muted gauge-note">mis à jour {timeAgo(new Date(account.at).getTime())}</div>}
        </div>
    );
}

/** Rail replié : l'icône de consommation, colorée selon la fenêtre la plus chargée, et le détail au clic. */
export function UsageButton(): ReactElement {
    const account = useStore((s) => s.account);
    const windows = account?.windows ?? [];
    const worst = Math.max(-1, ...windows.map((w) => percentOf(w) ?? -1));
    const summary = windows.map((w) => `${w.label} ${percentOf(w) ?? '—'} %`).join(' · ');
    return (
        <Menu icon="gauge" title={summary || 'Consommation du compte'} className={`usage-menu ${levelOf(worst < 0 ? null : worst)}`} closeOnClick={false}>
            <UsageDetails />
        </Menu>
    );
}

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { send } from '../ws';
import type { RateWindow, Repo, SessionHistoryItem } from '../../../shared/protocol';

const PAGE = 8;

function timeAgo(timestamp: number): string {
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

function Gauge({ window }: { window: RateWindow }): ReactElement {
    // `utilization` est déjà un pourcentage (0-100).
    const percent = window.utilization === null ? null : Math.round(window.utilization);
    const level = percent === null ? '' : percent >= 85 ? 'error' : percent >= 65 ? 'warn' : '';
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

function Usage(): ReactElement {
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
                <span className="sidebar-section">Consommation{account?.subscription ? ` · ${account.subscription}` : ''}</span>
                <button className="small" onClick={refresh} disabled={refreshing} title="Relire la consommation maintenant">
                    {refreshing ? '…' : '↻'}
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

function RepoItem({ repo }: { repo: Repo }): ReactElement {
    const [open, setOpen] = useState(false);
    const [sessions, setSessions] = useState<SessionHistoryItem[] | undefined>();
    const [loading, setLoading] = useState(false);
    const [shown, setShown] = useState(PAGE);
    const [filter, setFilter] = useState('');
    const upsertRun = useStore((s) => s.upsertRun);
    const setActive = useStore((s) => s.setActive);
    const notify = useStore((s) => s.notify);

    const toggle = async (): Promise<void> => {
        setOpen(!open);
        if (!open && sessions === undefined) {
            setLoading(true);
            try {
                setSessions(await api.repoSessions(repo.id));
            } catch (error) {
                notify(String(error));
            } finally {
                setLoading(false);
            }
        }
    };

    const newChat = async (): Promise<void> => {
        try {
            const run = await api.createRun({ repoId: repo.id });
            upsertRun(run);
            setActive(run.id);
        } catch (error) {
            notify(String(error));
        }
    };

    const resume = async (session: SessionHistoryItem): Promise<void> => {
        try {
            const title = (session.customTitle ?? session.summary ?? session.firstPrompt ?? 'Session').slice(0, 40);
            const run = await api.createRun({ repoId: repo.id, cwd: session.cwd ?? repo.path, sessionId: session.sessionId, title });
            upsertRun(run);
            setActive(run.id);
        } catch (error) {
            notify(String(error));
        }
    };

    const needle = filter.trim().toLowerCase();
    const filtered = (sessions ?? []).filter((s) => !needle || `${s.customTitle ?? ''} ${s.summary} ${s.firstPrompt ?? ''} ${s.gitBranch ?? ''}`.toLowerCase().includes(needle));
    const visible = filtered.slice(0, shown);

    return (
        <div className={`repo ${repo.enabled ? '' : 'disabled'}`}>
            <div className="repo-head">
                <button className="link" onClick={() => void toggle()} title={repo.path}>
                    {open ? '▾' : '▸'} {repo.owner ? `${repo.owner}/${repo.name}` : repo.name}
                </button>
                <button className="small" onClick={() => void newChat()} title="Nouveau chat dans ce dépôt">
                    + chat
                </button>
            </div>
            {open && (
                <div className="repo-body">
                    {loading && <div className="muted">chargement…</div>}
                    {sessions && sessions.length > PAGE && <input className="filter" placeholder="filtrer les sessions…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
                    {sessions?.length === 0 && <div className="muted">aucune session Claude Code</div>}
                    {visible.map((session) => (
                        <button key={session.sessionId} className="session" onClick={() => void resume(session)} title={`${session.sessionId}\n${session.cwd ?? ''}`}>
                            <span className="session-title">{session.customTitle ?? session.summary ?? session.firstPrompt ?? session.sessionId}</span>
                            <span className="muted">
                                {session.gitBranch ? `${session.gitBranch} · ` : ''}
                                {timeAgo(session.lastModified)}
                            </span>
                        </button>
                    ))}
                    {filtered.length > shown && (
                        <button className="link more" onClick={() => setShown(shown + 2 * PAGE)}>
                            voir plus ({filtered.length - shown} autres)
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export function Sidebar(): ReactElement {
    const repos = useStore((s) => s.repos);
    const setPage = useStore((s) => s.setPage);
    const enabled = repos.filter((r) => r.enabled);

    return (
        <aside className="sidebar">
            <div className="sidebar-head">
                <span className="brand">Clauded GIT</span>
                <button className="small" onClick={() => setPage('repos')} title="Gérer les dépôts">
                    ⚙
                </button>
            </div>
            <div className="sidebar-scroll">
                <div className="sidebar-section">Dépôts</div>
                {enabled.length === 0 && (
                    <div className="muted pad">
                        Aucun dépôt.{' '}
                        <button className="link" onClick={() => setPage('repos')}>
                            En ajouter
                        </button>
                    </div>
                )}
                {enabled.map((repo) => (
                    <RepoItem key={repo.id} repo={repo} />
                ))}
            </div>
            <Usage />
        </aside>
    );
}

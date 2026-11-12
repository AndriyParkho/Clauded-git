import type { ReactElement } from 'react';
import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
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

function resetIn(iso: string | null): string {
    if (!iso) return '';
    const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
    if (minutes <= 0) return 'maintenant';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
    return `${Math.round(hours / 24)} j`;
}

function Gauge({ label, window }: { label: string; window: RateWindow | undefined }): ReactElement | null {
    if (!window || window.utilization === null) return null;
    const percent = Math.round(window.utilization * (window.utilization <= 1 ? 100 : 1));
    const level = percent >= 85 ? 'error' : percent >= 65 ? 'warn' : '';
    return (
        <div className="gauge" title={window.resetsAt ? `réinitialisation dans ${resetIn(window.resetsAt)}` : undefined}>
            <span className="gauge-label">{label}</span>
            <span className="gauge-bar">
                <span className={`gauge-fill ${level}`} style={{ width: `${Math.min(percent, 100)}%` }} />
            </span>
            <span className={`gauge-value ${level}`}>{percent} %</span>
        </div>
    );
}

function Usage(): ReactElement | null {
    const limits = useStore((s) => s.limits);
    if (!limits?.limits) return null;
    const { fiveHour, sevenDay, sevenDayOpus, sevenDaySonnet, extra } = limits.limits;
    return (
        <div className="usage">
            <div className="sidebar-section">Consommation{limits.subscription ? ` · ${limits.subscription}` : ''}</div>
            <Gauge label="5 h" window={fiveHour} />
            <Gauge label="7 j" window={sevenDay} />
            <Gauge label="7 j Opus" window={sevenDayOpus} />
            <Gauge label="7 j Sonnet" window={sevenDaySonnet} />
            {extra?.enabled && (
                <div className="muted gauge-note">
                    extra : {extra.used ?? 0}
                    {extra.limit !== null ? ` / ${extra.limit}` : ''}
                </div>
            )}
            <div className="muted gauge-note">mis à jour {timeAgo(new Date(limits.at).getTime())}</div>
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

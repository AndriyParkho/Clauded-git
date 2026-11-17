import type { ReactElement } from 'react';
import { useState } from 'react';
import { useStore } from '../../store';
import { send } from '../../ws';
import type { McpServerInfo, McpServerState, McpStatus } from '../../../../shared/protocol';

const STATE: Record<McpServerState, { label: string; dot: string; order: number }> = {
    connected: { label: 'connecté', dot: 'dot-idle', order: 0 },
    pending: { label: 'connexion…', dot: 'dot-starting', order: 1 },
    'needs-auth': { label: 'authentification requise', dot: 'dot-waiting', order: 2 },
    failed: { label: 'échec', dot: 'dot-error', order: 3 },
    disabled: { label: 'désactivé', dot: '', order: 4 },
};

function ServerRow({ server, runId, busy }: { server: McpServerInfo; runId: number; busy: boolean }): ReactElement {
    const [open, setOpen] = useState(false);
    const state = STATE[server.status];
    const act = (action: 'reconnect' | 'enable' | 'disable'): void => send({ type: 'mcp', runId, action, server: server.name });
    return (
        <div className={`mcp-server ${server.status}`}>
            <div className="mcp-row">
                <span className={`dot ${state.dot}`} title={state.label} />
                <span className="mcp-name">{server.name}</span>
                <span className="muted">
                    {state.label}
                    {server.version ? ` · v${server.version}` : ''}
                    {server.transport ? ` · ${server.transport}` : ''}
                    {server.scope ? ` · ${server.scope}` : ''}
                </span>
                <span className="spacer" />
                {server.tools.length > 0 && (
                    <button className="link" onClick={() => setOpen(!open)}>
                        {server.tools.length} outil{server.tools.length > 1 ? 's' : ''} {open ? '▴' : '▾'}
                    </button>
                )}
                {server.status !== 'disabled' && (
                    <button className="small" disabled={busy} onClick={() => act('reconnect')} title="Relancer la connexion à ce serveur">
                        Reconnecter
                    </button>
                )}
                <button className="small" disabled={busy} onClick={() => act(server.status === 'disabled' ? 'enable' : 'disable')}>
                    {server.status === 'disabled' ? 'Activer' : 'Désactiver'}
                </button>
            </div>
            {server.target && <div className="muted mono mcp-target">{server.target}</div>}
            {server.error && <div className="error mcp-error">{server.error}</div>}
            {server.status === 'needs-auth' && <div className="muted">L'authentification OAuth se fait depuis un terminal : `claude` puis `/mcp`.</div>}
            {open && (
                <div className="mcp-tools">
                    {server.tools.map((tool) => (
                        <div key={tool.name} className="mcp-tool" title={tool.description}>
                            <span className="mono">{tool.name}</span>
                            {tool.description && <span className="muted"> — {tool.description.split('\n')[0]?.slice(0, 140)}</span>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Fenêtre ouverte par `/mcp` ou le bouton MCP : chaque serveur, son état, ses outils, et des actions.
 * Elle s'affiche au-dessus du chat et n'ajoute rien à la conversation.
 */
export function McpDialog({ status }: { status: McpStatus }): ReactElement {
    const dismiss = useStore((s) => s.dismissMcp);
    return (
        <div className="modal-backdrop" onClick={() => dismiss(status.runId)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <McpCard status={status} />
            </div>
        </div>
    );
}

function McpCard({ status }: { status: McpStatus }): ReactElement {
    const dismiss = useStore((s) => s.dismissMcp);
    const [busyUntil, setBusyUntil] = useState(0);
    const busy = Date.now() < busyUntil;
    const servers = [...status.servers].sort((a, b) => STATE[a.status].order - STATE[b.status].order || a.name.localeCompare(b.name));
    const counts = servers.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});
    const summary = (Object.keys(STATE) as McpServerState[])
        .filter((k) => counts[k])
        .map((k) => `${counts[k]} ${STATE[k].label}`)
        .join(', ');

    return (
        <div className="mcp-card" onClickCapture={() => setBusyUntil(Date.now() + 1500)}>
            <div className="mcp-head">
                <strong>Serveurs MCP</strong>
                <span className="muted">
                    {servers.length} serveur{servers.length > 1 ? 's' : ''} : {summary || 'aucun'} · {new Date(status.at).toLocaleTimeString('fr-FR')}
                </span>
                <span className="spacer" />
                <button className="small" onClick={() => send({ type: 'mcp', runId: status.runId, action: 'status' })} title="Rafraîchir">
                    ↻
                </button>
                <button className="small" onClick={() => dismiss(status.runId)} title="Fermer">
                    ×
                </button>
            </div>
            {servers.map((server) => (
                <ServerRow key={server.name} server={server} runId={status.runId} busy={busy} />
            ))}
        </div>
    );
}

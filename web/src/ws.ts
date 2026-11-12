import { useStore } from './store';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';

let socket: WebSocket | undefined;
let retryDelay = 500;
const pending: string[] = [];

export function connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.onopen = () => {
        retryDelay = 500;
        useStore.getState().setConnected(true);
        for (const payload of pending.splice(0)) socket?.send(payload);
        const active = useStore.getState().activeRunId;
        if (active !== null) send({ type: 'replay', runId: active });
    };
    socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        useStore.getState().apply(message);
        if (message.type === 'hello') {
            // Après une reconnexion, les vues doivent être rejouées.
            useStore.getState().markUnloaded();
            const active = useStore.getState().activeRunId;
            if (active !== null) send({ type: 'replay', runId: active });
        }
    };
    socket.onclose = () => {
        useStore.getState().setConnected(false);
        socket = undefined;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10_000);
    };
}

export function send(message: ClientMessage): void {
    const payload = JSON.stringify(message);
    if (socket?.readyState === WebSocket.OPEN) socket.send(payload);
    else pending.push(payload);
}

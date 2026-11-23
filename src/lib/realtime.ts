import type { ChatMessage, MediaComment } from '../types/media';

export type RealtimeEvent =
  | { type: 'presence:update'; onlineUserIds: string[] }
  | { type: 'chat:message'; message: ChatMessage }
  | { type: 'chat:read'; conversationId: string; readerId: string; readAt: string }
  | { type: 'comment:created'; mediaId: string; comment: MediaComment }
  | { type: 'comment:deleted'; mediaId: string; commentId: string }
  | { type: 'ws:connected' }
  | { type: 'ws:reconnected' };

type Listener = (event: RealtimeEvent) => void;

class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private token: string | null = null;
  private shouldStayConnected = false;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private hasConnectedBefore = false;
  private onlineSet = new Set<string>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.onlineSet.size > 0) {
      listener({ type: 'presence:update', onlineUserIds: Array.from(this.onlineSet) });
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  getOnlineUserIds(): string[] {
    return Array.from(this.onlineSet);
  }

  connect(token: string | null): void {
    this.token = token;
    this.shouldStayConnected = true;
    this.clearReconnectTimer();

    // Avoid reopening if already open/connecting with same token
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
      this.ws = null;
    }

    this.openSocket();
  }

  disconnect(): void {
    this.shouldStayConnected = false;
    this.token = null;
    this.hasConnectedBefore = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emit(event: RealtimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // isolate subscriber errors
      }
    }
  }

  private openSocket(): void {
    if (typeof window === 'undefined' || !this.shouldStayConnected) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    const url = `${proto}//${window.location.host}/ws${query}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;

    socket.onopen = () => {
      const wasReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.reconnectAttempt = 0;
      this.emit({ type: wasReconnect ? 'ws:reconnected' : 'ws:connected' });
    };

    socket.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as RealtimeEvent;
        if (parsed.type === 'presence:update' && Array.isArray(parsed.onlineUserIds)) {
          this.onlineSet = new Set(parsed.onlineUserIds);
        }
        this.emit(parsed);
      } catch {
        // ignore malformed frames
      }
    };

    socket.onclose = () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      if (this.shouldStayConnected) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // onclose will trigger reconnect cleanly
    };
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delayMs = Math.min(15000, 1000 * Math.pow(2, Math.min(this.reconnectAttempt, 4)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      if (this.shouldStayConnected) {
        this.openSocket();
      }
    }, delayMs);
  }
}

export const realtimeClient = new RealtimeClient();

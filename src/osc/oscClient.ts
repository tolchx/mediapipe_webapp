import type { OscConfig, OscMessageItem, OscStats } from '../types/hand';

export interface LoopbackTestResult {
  ok: boolean;
  latencyMs?: number;
  bytes?: number;
  decoded?: unknown;
  error?: string;
}

export class OscBridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private disposed = false;
  private lastSentAt = 0;
  private autoReconnect = true;
  private activeWsUrl: string | null = null;

  private config: OscConfig = {
    enabled: true,
    host: '127.0.0.1',
    port: 9000,
    sendMode: 'bundle',
    rateHz: 60,
    channels: {
      palm: true,
      fingers: true,
      phalanges: true,
      landmarks: false,
      synth: true,
      triggers: true,
      triggerSubchannels: true,
    },
  };

  private stats: OscStats = {
    bridgeMode: 'connecting',
    wsConnected: false,
    udpReady: false,
    targetHost: '127.0.0.1',
    targetPort: 9000,
    sendMode: 'bundle',
    packetsSent: 0,
    messagesSent: 0,
    bytesSent: 0,
    packetsPerSec: 0,
    messagesPerSec: 0,
    lastError: null,
  };

  private onStatsListeners: Array<(stats: OscStats) => void> = [];
  private onLoopbackListeners: Array<(res: LoopbackTestResult) => void> = [];
  private onTestPacketListeners: Array<(info: { host: string; port: number; count: number }) => void> = [];

  connect(customWsUrl?: string): void {
    if (this.disposed) return;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (customWsUrl) {
      const cleaned = customWsUrl.trim();
      if (!cleaned) return;
      this.autoReconnect = false;
      this.activeWsUrl = cleaned;
      this.closeCurrentSocket();
      this.stats.bridgeMode = 'connecting';
      this.stats.lastError = null;
      this.emitStats();
      this.openWebSocket(cleaned);
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    void this.probeAndConnectSameOrigin();
  }

  private closeCurrentSocket(): void {
    if (!this.ws) return;
    const prev = this.ws;
    this.ws = null;
    try {
      prev.close();
    } catch {
      // ignore close errors
    }
  }

  private async probeAndConnectSameOrigin(): Promise<void> {
    if (this.disposed) return;

    const baseUrl = new URL(import.meta.env.BASE_URL || './', window.location.href);
    const healthUrl = new URL('api/health', baseUrl).href;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2000);

    let hasSameOriginBridge = false;
    try {
      const res = await fetch(healthUrl, { cache: 'no-store', signal: controller.signal });
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = (await res.json()) as { ok?: unknown; udpReady?: unknown };
        hasSameOriginBridge = data?.ok === true && typeof data?.udpReady === 'boolean';
      }
    } catch {
      hasSameOriginBridge = false;
    } finally {
      clearTimeout(timer);
    }

    if (this.disposed) return;

    if (!hasSameOriginBridge) {
      this.autoReconnect = false;
      this.stats.bridgeMode = 'standalone';
      this.stats.wsConnected = false;
      this.stats.udpReady = false;
      this.stats.lastError = null;
      this.emitStats();
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/osc`;
    this.autoReconnect = true;
    this.activeWsUrl = wsUrl;
    this.openWebSocket(wsUrl);
  }

  private openWebSocket(url: string): void {
    if (this.disposed) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.stats.wsConnected = false;
      this.stats.bridgeMode = this.autoReconnect ? 'disconnected' : 'standalone';
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      this.emitStats();
      return;
    }

    this.ws = ws;
    let opened = false;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      opened = true;
      this.stats.bridgeMode = 'connected';
      this.stats.wsConnected = true;
      this.stats.lastError = null;
      this.pushConfigToServer();
      this.emitStats();
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      try {
        const data = JSON.parse(String(event.data));
        if (data.type === 'stats') {
          this.stats = {
            ...this.stats,
            bridgeMode: 'connected',
            wsConnected: true,
            udpReady: Boolean(data.udpReady),
            targetHost: data.targetHost ?? this.stats.targetHost,
            targetPort: data.targetPort ?? this.stats.targetPort,
            sendMode: data.sendMode ?? this.stats.sendMode,
            packetsSent: data.packetsSent ?? 0,
            messagesSent: data.messagesSent ?? 0,
            bytesSent: data.bytesSent ?? 0,
            packetsPerSec: data.packetsPerSec ?? 0,
            messagesPerSec: data.messagesPerSec ?? 0,
            lastError: data.lastError ?? null,
          };
          this.emitStats();
        } else if (data.type === 'loopback_result') {
          for (const cb of this.onLoopbackListeners) cb(data as LoopbackTestResult);
        } else if (data.type === 'test_packet_sent') {
          for (const cb of this.onTestPacketListeners) cb(data);
        } else if (data.type === 'error') {
          this.stats.lastError = data.message;
          this.emitStats();
        }
      } catch {
        // ignore malformed json
      }
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stats.wsConnected = false;
      if (this.autoReconnect && !this.disposed) {
        this.stats.bridgeMode = 'disconnected';
        this.emitStats();
        this.scheduleReconnect();
      } else {
        this.stats.bridgeMode = 'standalone';
        if (!opened && !this.stats.lastError) {
          this.stats.lastError = 'No se pudo conectar al puente WebSocket local';
        }
        this.emitStats();
      }
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.stats.wsConnected = false;
      if (!this.autoReconnect) {
        this.stats.lastError = `No se encontró puente WebSocket en ${url}`;
      }
      this.emitStats();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.autoReconnect || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.activeWsUrl) this.openWebSocket(this.activeWsUrl);
    }, 1500);
  }

  getConfig(): OscConfig {
    return {
      ...this.config,
      channels: { ...this.config.channels },
    };
  }

  getStats(): OscStats {
    return { ...this.stats };
  }

  updateConfig(partial: Partial<OscConfig>): void {
    this.config = {
      ...this.config,
      ...partial,
      channels: {
        ...this.config.channels,
        ...(partial.channels ?? {}),
      },
    };
    this.pushConfigToServer();
  }

  private pushConfigToServer(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'config',
        host: this.config.host,
        port: this.config.port,
        sendMode: this.config.sendMode,
      })
    );
  }

  sendBatch(messages: OscMessageItem[], nowMs: number, forceImmediate = false): boolean {
    if (!this.config.enabled || messages.length === 0) return false;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    if (!forceImmediate && this.config.rateHz > 0) {
      const minInterval = 1000 / this.config.rateHz;
      if (nowMs - this.lastSentAt < minInterval) return false;
    }

    this.lastSentAt = nowMs;
    this.ws.send(JSON.stringify({ type: 'osc_batch', messages }));
    return true;
  }

  sendTestPacket(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: 'send_test_packet' }));
    return true;
  }

  runLoopbackTest(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: 'loopback_test' }));
    return true;
  }

  onStats(cb: (stats: OscStats) => void): void {
    this.onStatsListeners.push(cb);
  }

  onLoopback(cb: (res: LoopbackTestResult) => void): void {
    this.onLoopbackListeners.push(cb);
  }

  onTestPacketSent(cb: (info: { host: string; port: number; count: number }) => void): void {
    this.onTestPacketListeners.push(cb);
  }

  private emitStats(): void {
    const snap = this.getStats();
    for (const cb of this.onStatsListeners) cb(snap);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

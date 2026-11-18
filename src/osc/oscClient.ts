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
    },
  };

  private stats: OscStats = {
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

  connect(): void {
    if (this.disposed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/osc`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.stats.wsConnected = true;
      this.stats.lastError = null;
      this.pushConfigToServer();
      this.emitStats();
    });

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.type === 'stats') {
          this.stats = {
            ...this.stats,
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
      this.stats.wsConnected = false;
      this.emitStats();
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      this.stats.wsConnected = false;
      this.emitStats();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
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

  sendBatch(messages: OscMessageItem[], nowMs: number): boolean {
    if (!this.config.enabled || messages.length === 0) return false;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    if (this.config.rateHz > 0) {
      const minInterval = 1000 / this.config.rateHz;
      if (nowMs - this.lastSentAt < minInterval) return false;
    }

    this.lastSentAt = nowMs;
    this.ws.send(JSON.stringify({ type: 'osc_batch', messages }));
    return true;
  }

  sendTestPacket(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'send_test_packet' }));
  }

  runLoopbackTest(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'loopback_test' }));
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

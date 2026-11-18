import dgram from 'node:dgram';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const osc = require('osc');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_OSC_HOST = process.env.OSC_HOST || '127.0.0.1';
const DEFAULT_OSC_PORT = Number(process.env.OSC_PORT || 9000);
const MAX_BUNDLE_MESSAGES = 16;

const app = express();
app.use(express.json());

const udpSocket = dgram.createSocket('udp4');
let udpReady = false;
let lastUdpError = null;

udpSocket.on('error', (err) => {
  lastUdpError = err.message;
  console.error('[OSC-UDP] Socket error:', err.message);
});

udpSocket.bind(0, () => {
  udpReady = true;
  const addr = udpSocket.address();
  console.log(`[OSC-UDP] Transmitter bound on ephemeral UDP port ${addr.port}`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath === '/osc') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

function sanitizeArg(arg) {
  if (arg && typeof arg === 'object' && 'type' in arg && 'value' in arg) {
    if (arg.type === 'i') return { type: 'i', value: Math.trunc(Number(arg.value) || 0) };
    if (arg.type === 'f') {
      const n = Number(arg.value);
      return { type: 'f', value: Number.isFinite(n) ? n : 0 };
    }
    if (arg.type === 's') return { type: 's', value: String(arg.value) };
    if (arg.type === 'T' || arg.type === 'F') return { type: arg.value ? 'T' : 'F' };
  }
  if (typeof arg === 'number') {
    return { type: 'f', value: Number.isFinite(arg) ? arg : 0 };
  }
  if (typeof arg === 'boolean') {
    return { type: arg ? 'T' : 'F' };
  }
  return { type: 's', value: String(arg ?? '') };
}

function toOscMessage(raw) {
  const address = typeof raw?.address === 'string' && raw.address.startsWith('/')
    ? raw.address
    : '/hand/unknown';
  const args = Array.isArray(raw?.args) ? raw.args.map(sanitizeArg) : [];
  return { address, args };
}

function sendUdpBuffer(buffer, host, port) {
  return new Promise((resolve, reject) => {
    udpSocket.send(buffer, 0, buffer.length, port, host, (err) => {
      if (err) reject(err);
      else resolve(buffer.length);
    });
  });
}

async function dispatchOscMessages(messages, config, stats) {
  if (!messages.length) return;

  if (config.sendMode === 'individual') {
    for (const raw of messages) {
      const packet = toOscMessage(raw);
      const bytes = Buffer.from(osc.writePacket(packet));
      await sendUdpBuffer(bytes, config.host, config.port);
      stats.packetsSent += 1;
      stats.messagesSent += 1;
      stats.bytesSent += bytes.length;
      stats.windowPackets += 1;
      stats.windowMessages += 1;
    }
    return;
  }

  // Bundle mode: chunk into <= MAX_BUNDLE_MESSAGES to stay safely under typical UDP MTU
  for (let i = 0; i < messages.length; i += MAX_BUNDLE_MESSAGES) {
    const chunk = messages.slice(i, i + MAX_BUNDLE_MESSAGES).map(toOscMessage);
    const bundle = {
      timeTag: osc.timeTag(0),
      packets: chunk,
    };
    const bytes = Buffer.from(osc.writePacket(bundle));
    await sendUdpBuffer(bytes, config.host, config.port);
    stats.packetsSent += 1;
    stats.messagesSent += chunk.length;
    stats.bytesSent += bytes.length;
    stats.windowPackets += 1;
    stats.windowMessages += chunk.length;
  }
}

function runLoopbackTest() {
  return new Promise((resolve) => {
    const rx = dgram.createSocket('udp4');
    const startedAt = performance.now();
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try {
        rx.close();
      } catch {
        // ignore close errors
      }
      resolve(payload);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Timeout esperando paquete UDP loopback (1500 ms)' });
    }, 1500);

    rx.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });

    rx.on('message', (msg) => {
      clearTimeout(timer);
      const latencyMs = Number((performance.now() - startedAt).toFixed(2));
      try {
        const decoded = osc.readPacket(msg, { metadata: true });
        finish({
          ok: true,
          latencyMs,
          bytes: msg.length,
          decoded,
        });
      } catch (err) {
        finish({ ok: false, error: `Error decodificando OSC: ${err.message}` });
      }
    });

    rx.bind(0, '127.0.0.1', () => {
      const { port } = rx.address();
      const testPacket = {
        timeTag: osc.timeTag(0),
        packets: [
          {
            address: '/hand/right/phalanx/index/proximal/angle',
            args: [{ type: 'f', value: 37.5 }],
          },
          {
            address: '/synth/frequency',
            args: [{ type: 'f', value: 440.0 }],
          },
        ],
      };
      const buf = Buffer.from(osc.writePacket(testPacket));
      udpSocket.send(buf, 0, buf.length, port, '127.0.0.1', (err) => {
        if (err) {
          clearTimeout(timer);
          finish({ ok: false, error: err.message });
        }
      });
    });
  });
}

wss.on('connection', (ws) => {
  const clientConfig = {
    host: DEFAULT_OSC_HOST,
    port: DEFAULT_OSC_PORT,
    sendMode: 'bundle', // 'bundle' | 'individual'
  };

  const stats = {
    packetsSent: 0,
    messagesSent: 0,
    bytesSent: 0,
    windowPackets: 0,
    windowMessages: 0,
    lastError: null,
  };

  const sendStats = () => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'stats',
        udpReady,
        targetHost: clientConfig.host,
        targetPort: clientConfig.port,
        sendMode: clientConfig.sendMode,
        packetsSent: stats.packetsSent,
        messagesSent: stats.messagesSent,
        bytesSent: stats.bytesSent,
        packetsPerSec: stats.windowPackets * 2,
        messagesPerSec: stats.windowMessages * 2,
        lastError: stats.lastError || lastUdpError,
      })
    );
    stats.windowPackets = 0;
    stats.windowMessages = 0;
  };

  const statsTimer = setInterval(sendStats, 500);
  sendStats();

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'config') {
        if (typeof msg.host === 'string' && msg.host.trim()) {
          clientConfig.host = msg.host.trim();
        }
        const parsedPort = Number(msg.port);
        if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
          clientConfig.port = parsedPort;
        }
        if (msg.sendMode === 'bundle' || msg.sendMode === 'individual') {
          clientConfig.sendMode = msg.sendMode;
        }
        stats.lastError = null;
        sendStats();
        return;
      }

      if (msg.type === 'osc_batch' && Array.isArray(msg.messages)) {
        await dispatchOscMessages(msg.messages, clientConfig, stats);
        stats.lastError = null;
        return;
      }

      if (msg.type === 'send_test_packet') {
        const testMessages = [
          { address: '/hand/test/ping', args: [{ type: 'i', value: 1 }] },
          { address: '/hand/right/phalanx/index/proximal/angle', args: [{ type: 'f', value: 45.0 }] },
          { address: '/synth/frequency', args: [{ type: 'f', value: 440.0 }] },
        ];
        await dispatchOscMessages(testMessages, clientConfig, stats);
        stats.lastError = null;
        ws.send(
          JSON.stringify({
            type: 'test_packet_sent',
            host: clientConfig.host,
            port: clientConfig.port,
            count: testMessages.length,
          })
        );
        sendStats();
        return;
      }

      if (msg.type === 'loopback_test') {
        const result = await runLoopbackTest();
        ws.send(JSON.stringify({ type: 'loopback_result', ...result }));
      }
    } catch (err) {
      stats.lastError = err.message;
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }
  });

  ws.on('close', () => {
    clearInterval(statsTimer);
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    udpReady,
    defaultTargetHost: DEFAULT_OSC_HOST,
    defaultTargetPort: DEFAULT_OSC_PORT,
    lastUdpError,
  });
});

if (!process.env.DEV_MODE && fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

server.listen(PORT, () => {
  const modeLabel = process.env.DEV_MODE ? 'Bridge Dev' : 'Production';
  console.log(`[Server:${modeLabel}] Listening on http://localhost:${PORT}`);
  console.log(`[OSC-UDP] Default target -> ${DEFAULT_OSC_HOST}:${DEFAULT_OSC_PORT}`);
});

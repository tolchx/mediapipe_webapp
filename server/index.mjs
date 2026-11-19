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
const DEFAULT_GESTURES_PORT = Number(process.env.OSC_GESTURES_PORT || 9001);
const DEFAULT_SKELETON_PORT = Number(process.env.OSC_SKELETON_PORT || 9002);
const MAX_BUNDLE_MESSAGES = 16;

const MODULE_IDS = ['main', 'gestures', 'skeleton'];

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
  const address =
    typeof raw?.address === 'string' && raw.address.startsWith('/')
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

async function dispatchOscMessages(messages, routeConfig, modStats) {
  if (!messages.length) return;

  if (routeConfig.sendMode === 'individual') {
    for (const raw of messages) {
      const packet = toOscMessage(raw);
      const bytes = Buffer.from(osc.writePacket(packet));
      await sendUdpBuffer(bytes, routeConfig.host, routeConfig.port);
      modStats.packetsSent += 1;
      modStats.messagesSent += 1;
      modStats.bytesSent += bytes.length;
      modStats.windowPackets += 1;
      modStats.windowMessages += 1;
    }
    return;
  }

  for (let i = 0; i < messages.length; i += MAX_BUNDLE_MESSAGES) {
    const chunk = messages.slice(i, i + MAX_BUNDLE_MESSAGES).map(toOscMessage);
    const bundle = {
      timeTag: osc.timeTag(0),
      packets: chunk,
    };
    const bytes = Buffer.from(osc.writePacket(bundle));
    await sendUdpBuffer(bytes, routeConfig.host, routeConfig.port);
    modStats.packetsSent += 1;
    modStats.messagesSent += chunk.length;
    modStats.bytesSent += bytes.length;
    modStats.windowPackets += 1;
    modStats.windowMessages += chunk.length;
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
            address: '/gestures/right/active/victory',
            args: [{ type: 'i', value: 1 }],
          },
          {
            address: '/pose/0/angles',
            args: [{ type: 'f', value: 145.0 }],
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

function createModuleState(defaultPort) {
  return {
    config: {
      host: DEFAULT_OSC_HOST,
      port: defaultPort,
      sendMode: 'bundle',
    },
    stats: {
      packetsSent: 0,
      messagesSent: 0,
      bytesSent: 0,
      windowPackets: 0,
      windowMessages: 0,
      lastError: null,
    },
  };
}

function normalizeModuleId(raw) {
  return MODULE_IDS.includes(raw) ? raw : 'main';
}

function buildTestMessagesForModule(moduleId) {
  if (moduleId === 'gestures') {
    return [
      { address: '/gestures/right/top', args: [{ type: 's', value: 'victory' }, { type: 'f', value: 0.95 }] },
      { address: '/gestures/right/active/victory', args: [{ type: 'i', value: 1 }] },
      { address: '/gestures/body/active/arms_up', args: [{ type: 'i', value: 0 }] },
    ];
  }
  if (moduleId === 'skeleton') {
    return [
      { address: '/pose/detected', args: [{ type: 'i', value: 1 }] },
      { address: '/pose/0/center', args: [{ type: 'f', value: 0.5 }, { type: 'f', value: 0.55 }, { type: 'f', value: 0.0 }] },
      {
        address: '/pose/0/angles',
        args: [
          { type: 'f', value: 150.0 },
          { type: 'f', value: 148.0 },
          { type: 'f', value: 45.0 },
          { type: 'f', value: 46.0 },
          { type: 'f', value: 175.0 },
          { type: 'f', value: 175.0 },
          { type: 'f', value: 176.0 },
          { type: 'f', value: 176.0 },
        ],
      },
    ];
  }
  return [
    { address: '/hand/test/ping', args: [{ type: 'i', value: 1 }] },
    { address: '/hand/right/phalanx/index/proximal/angle', args: [{ type: 'f', value: 45.0 }] },
    { address: '/synth/frequency', args: [{ type: 'f', value: 440.0 }] },
  ];
}

wss.on('connection', (ws) => {
  const modules = {
    main: createModuleState(DEFAULT_OSC_PORT),
    gestures: createModuleState(DEFAULT_GESTURES_PORT),
    skeleton: createModuleState(DEFAULT_SKELETON_PORT),
  };

  const applyConfigToModule = (moduleId, cfg) => {
    const mod = modules[moduleId];
    if (!mod || !cfg) return;
    if (typeof cfg.host === 'string' && cfg.host.trim()) {
      mod.config.host = cfg.host.trim();
    }
    const parsedPort = Number(cfg.port);
    if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
      mod.config.port = parsedPort;
    }
    if (cfg.sendMode === 'bundle' || cfg.sendMode === 'individual') {
      mod.config.sendMode = cfg.sendMode;
    }
    mod.stats.lastError = null;
  };

  const sendStats = () => {
    if (ws.readyState !== ws.OPEN) return;

    const moduleSnapshots = {};
    let totalPackets = 0;
    let totalMessages = 0;
    let totalBytes = 0;
    let totalPacketsPerSec = 0;
    let totalMessagesPerSec = 0;
    let anyError = lastUdpError;

    for (const id of MODULE_IDS) {
      const m = modules[id];
      const pps = m.stats.windowPackets * 2;
      const mps = m.stats.windowMessages * 2;

      moduleSnapshots[id] = {
        targetHost: m.config.host,
        targetPort: m.config.port,
        sendMode: m.config.sendMode,
        packetsSent: m.stats.packetsSent,
        messagesSent: m.stats.messagesSent,
        bytesSent: m.stats.bytesSent,
        packetsPerSec: pps,
        messagesPerSec: mps,
        lastError: m.stats.lastError || lastUdpError,
      };

      totalPackets += m.stats.packetsSent;
      totalMessages += m.stats.messagesSent;
      totalBytes += m.stats.bytesSent;
      totalPacketsPerSec += pps;
      totalMessagesPerSec += mps;
      if (!anyError && m.stats.lastError) anyError = m.stats.lastError;

      m.stats.windowPackets = 0;
      m.stats.windowMessages = 0;
    }

    ws.send(
      JSON.stringify({
        type: 'stats',
        udpReady,
        targetHost: modules.main.config.host,
        targetPort: modules.main.config.port,
        sendMode: modules.main.config.sendMode,
        packetsSent: totalPackets,
        messagesSent: totalMessages,
        bytesSent: totalBytes,
        packetsPerSec: totalPacketsPerSec,
        messagesPerSec: totalMessagesPerSec,
        lastError: anyError,
        modules: moduleSnapshots,
      })
    );
  };

  const statsTimer = setInterval(sendStats, 500);
  sendStats();

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'config') {
        if (msg.modules && typeof msg.modules === 'object') {
          for (const id of MODULE_IDS) {
            if (msg.modules[id]) applyConfigToModule(id, msg.modules[id]);
          }
        } else {
          applyConfigToModule(normalizeModuleId(msg.module), msg);
        }
        sendStats();
        return;
      }

      if (msg.type === 'osc_batch' && Array.isArray(msg.messages)) {
        const modId = normalizeModuleId(msg.module);
        const mod = modules[modId];
        await dispatchOscMessages(msg.messages, mod.config, mod.stats);
        mod.stats.lastError = null;
        return;
      }

      if (msg.type === 'send_test_packet') {
        const modId = normalizeModuleId(msg.module);
        const mod = modules[modId];
        const testMessages = buildTestMessagesForModule(modId);
        await dispatchOscMessages(testMessages, mod.config, mod.stats);
        mod.stats.lastError = null;
        ws.send(
          JSON.stringify({
            type: 'test_packet_sent',
            module: modId,
            host: mod.config.host,
            port: mod.config.port,
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
      modules.main.stats.lastError = err.message;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    ok: true,
    udpReady,
    defaultTargetHost: DEFAULT_OSC_HOST,
    defaultTargetPort: DEFAULT_OSC_PORT,
    defaultGesturesPort: DEFAULT_GESTURES_PORT,
    defaultSkeletonPort: DEFAULT_SKELETON_PORT,
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
  console.log(
    `[OSC-UDP] Default ports -> main:${DEFAULT_OSC_HOST}:${DEFAULT_OSC_PORT} | gestures:${DEFAULT_OSC_HOST}:${DEFAULT_GESTURES_PORT} | skeleton:${DEFAULT_OSC_HOST}:${DEFAULT_SKELETON_PORT}`
  );
});

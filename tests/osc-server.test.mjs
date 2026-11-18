import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const osc = require('osc');

test('OSC Bridge transmits real binary UDP OSC bundles and individual messages', async () => {
  const TEST_HTTP_PORT = 3199;

  // 1. Bind ephemeral UDP receiver
  const udpRx = dgram.createSocket('udp4');
  await new Promise((resolve) => udpRx.bind(0, '127.0.0.1', resolve));
  const { port: rxPort } = udpRx.address();

  const receivedPackets = [];
  udpRx.on('message', (buf) => {
    receivedPackets.push(osc.readPacket(buf, { metadata: true }));
  });

  // 2. Start server/index.mjs on TEST_HTTP_PORT
  const serverProc = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(TEST_HTTP_PORT), DEV_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
    serverProc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`http://localhost:${TEST_HTTP_PORT}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProc.stderr.on('data', (chunk) => {
      // keep stderr visible on failure
      const msg = chunk.toString();
      if (msg.includes('Error')) reject(new Error(msg));
    });
  });

  try {
    // 3. Connect WebSocket client
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_HTTP_PORT}/osc`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    // Configure bundle target to our ephemeral UDP receiver
    ws.send(JSON.stringify({ type: 'config', host: '127.0.0.1', port: rxPort, sendMode: 'bundle' }));

    // Send phalanx + synth telemetry batch
    ws.send(
      JSON.stringify({
        type: 'osc_batch',
        messages: [
          {
            address: '/hand/right/phalanx/index/proximal/angle',
            args: [{ type: 'f', value: 48.25 }],
          },
          {
            address: '/hand/right/phalanx/index/proximal/flex',
            args: [{ type: 'f', value: 0.45 }],
          },
          {
            address: '/synth/frequency',
            args: [{ type: 'f', value: 440.0 }],
          },
        ],
      })
    );

    // Wait for UDP packet delivery
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(receivedPackets.length, 1, 'Expected 1 OSC bundle datagram');
    const bundle = receivedPackets[0];
    assert.ok(Array.isArray(bundle.packets), 'Expected decoded packet to be an OSC bundle');
    assert.equal(bundle.packets.length, 3);
    assert.equal(bundle.packets[0].address, '/hand/right/phalanx/index/proximal/angle');
    assert.ok(Math.abs(bundle.packets[0].args[0].value - 48.25) < 1e-4);
    assert.equal(bundle.packets[2].address, '/synth/frequency');
    assert.ok(Math.abs(bundle.packets[2].args[0].value - 440.0) < 1e-4);

    // 4. Test built-in loopback_test RPC
    const loopbackPromise = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'loopback_result') resolve(parsed);
      });
    });
    ws.send(JSON.stringify({ type: 'loopback_test' }));
    const loopback = await loopbackPromise;
    assert.equal(loopback.ok, true);
    assert.ok(loopback.bytes > 0);

    ws.close();
  } finally {
    udpRx.close();
    serverProc.kill('SIGTERM');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

import { PoseKinematicsProcessor, buildVirtualPose } from '../src/vision/poseKinematics.ts';
import { GestureDetectorEngine } from '../src/vision/gestureEngine.ts';
import { buildGestureOscMessages, buildSkeletonOscMessages } from '../src/osc/oscProtocol.ts';

const require = createRequire(import.meta.url);
const osc = require('osc');

test('PoseKinematicsProcessor and GestureDetectorEngine compute 33-point skeleton and gesture list', () => {
  const poseProc = new PoseKinematicsProcessor();
  const { landmarks, worldLandmarks } = buildVirtualPose(1000, []);

  // Levantar ambas muñecas por encima de los hombros para disparar Arms_Up
  landmarks[15].y = landmarks[11].y - 0.15;
  landmarks[16].y = landmarks[12].y - 0.15;
  worldLandmarks[15].y = worldLandmarks[11].y - 0.25;
  worldLandmarks[16].y = worldLandmarks[12].y - 0.25;

  const pose = poseProc.processPose(0, landmarks, worldLandmarks, 1000);
  assert.equal(pose.landmarks.length, 33);
  assert.equal(pose.worldLandmarks.length, 33);
  assert.ok(pose.angles.leftElbow > 0 && pose.angles.leftElbow <= 180);

  const frame = {
    timestamp: 1000,
    source: 'camera',
    hands: [],
    left: null,
    right: null,
    poses: [pose],
    rawGestures: [{ side: 'right', categoryName: 'Victory', score: 0.94 }],
  };

  // Añadir mano derecha ficticia mínima para habilitar evaluación de gesto nativo right:victory
  frame.right = {
    side: 'right',
    score: 0.95,
    landmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 })),
    worldLandmarks: Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })),
    palmCenter: { x: 0.5, y: 0.5, z: 0 },
    palmOpenness: 0.4,
    palmOrientation: { pitch: 0, yaw: 0, roll: 0 },
    palmVelocity: 0,
    spread: { thumbIndex: 0.2, indexMiddle: 0.4, middleRing: 0.1, ringPinky: 0.1 },
    fingers: {
      thumb: { key: 'thumb', label: 'Pulgar', tipIndex: 4, curl: 0.7, extended: 0.3, phalanges: {}, tipPosition: { x: 0.5, y: 0.5, z: 0 } },
      index: { key: 'index', label: 'Índice', tipIndex: 8, curl: 0.1, extended: 0.9, phalanges: {}, tipPosition: { x: 0.5, y: 0.4, z: 0 } },
      middle: { key: 'middle', label: 'Medio', tipIndex: 12, curl: 0.1, extended: 0.9, phalanges: {}, tipPosition: { x: 0.5, y: 0.4, z: 0 } },
      ring: { key: 'ring', label: 'Anular', tipIndex: 16, curl: 0.9, extended: 0.1, phalanges: {}, tipPosition: { x: 0.5, y: 0.6, z: 0 } },
      pinky: { key: 'pinky', label: 'Meñique', tipIndex: 20, curl: 0.9, extended: 0.1, phalanges: {}, tipPosition: { x: 0.5, y: 0.6, z: 0 } },
    },
    pinches: {
      index: { target: 'index', label: 'Pulgar · Índice', distanceNorm: 1.0, closeness: 0.1, active: false },
      middle: { target: 'middle', label: 'Pulgar · Medio', distanceNorm: 1.0, closeness: 0.1, active: false },
      ring: { target: 'ring', label: 'Pulgar · Anular', distanceNorm: 1.0, closeness: 0.1, active: false },
      pinky: { target: 'pinky', label: 'Pulgar · Meñique', distanceNorm: 1.0, closeness: 0.1, active: false },
    },
  };
  frame.hands = [frame.right];

  const gestEngine = new GestureDetectorEngine();
  const gestFrame = gestEngine.evaluate(frame);

  const victoryItem = gestFrame.items.find((g) => g.id === 'right:victory');
  assert.ok(victoryItem && victoryItem.active, 'Expected right:victory gesture to be active');
  assert.equal(gestFrame.topRight?.slug, 'victory');

  const armsUpItem = gestFrame.items.find((g) => g.id === 'body:arms_up');
  assert.ok(armsUpItem && armsUpItem.active, 'Expected body:arms_up pose gesture to be active');

  const gestOsc = buildGestureOscMessages(gestFrame, {
    sendTopGesture: true,
    sendScores: true,
    onlyActiveOrChanged: false,
  });
  assert.ok(gestOsc.some((m) => m.address === '/gestures/right/active/victory' && m.args[0].value === 1));
  assert.ok(gestOsc.some((m) => m.address === '/gestures/body/active/arms_up' && m.args[0].value === 1));

  const skelOsc = buildSkeletonOscMessages(frame, {
    namedJoints: true,
    angles: true,
    torsoMetrics: true,
    landmarks: true,
    worldLandmarks: false,
  });
  assert.ok(skelOsc.some((m) => m.address === '/pose/detected' && m.args[0].value === 1));
  assert.ok(skelOsc.some((m) => m.address === '/pose/0/joint/left_wrist'));
  assert.ok(skelOsc.some((m) => m.address === '/pose/0/landmark/32'));
});

test('OSC Bridge routes gestures and skeleton modules to two distinct UDP ports concurrently', async () => {
  const TEST_HTTP_PORT = 3299;

  const rxGestures = dgram.createSocket('udp4');
  const rxSkeleton = dgram.createSocket('udp4');
  await new Promise((r) => rxGestures.bind(0, '127.0.0.1', r));
  await new Promise((r) => rxSkeleton.bind(0, '127.0.0.1', r));

  const gestPort = rxGestures.address().port;
  const skelPort = rxSkeleton.address().port;
  assert.notEqual(gestPort, skelPort);

  const gestPackets = [];
  const skelPackets = [];
  rxGestures.on('message', (buf) => gestPackets.push(osc.readPacket(buf, { metadata: true })));
  rxSkeleton.on('message', (buf) => skelPackets.push(osc.readPacket(buf, { metadata: true })));

  const serverProc = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(TEST_HTTP_PORT), DEV_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server timeout')), 5000);
    serverProc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`http://localhost:${TEST_HTTP_PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_HTTP_PORT}/osc`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(
      JSON.stringify({
        type: 'config',
        modules: {
          gestures: { host: '127.0.0.1', port: gestPort, sendMode: 'bundle' },
          skeleton: { host: '127.0.0.1', port: skelPort, sendMode: 'bundle' },
        },
      })
    );

    ws.send(
      JSON.stringify({
        type: 'osc_batch',
        module: 'gestures',
        messages: [{ address: '/gestures/right/active/victory', args: [{ type: 'i', value: 1 }] }],
      })
    );
    ws.send(
      JSON.stringify({
        type: 'osc_batch',
        module: 'skeleton',
        messages: [{ address: '/pose/0/angles', args: [{ type: 'f', value: 142.5 }] }],
      })
    );

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(gestPackets.length, 1);
    assert.equal(gestPackets[0].packets[0].address, '/gestures/right/active/victory');

    assert.equal(skelPackets.length, 1);
    assert.equal(skelPackets[0].packets[0].address, '/pose/0/angles');
    assert.ok(Math.abs(skelPackets[0].packets[0].args[0].value - 142.5) < 1e-4);

    ws.close();
  } finally {
    rxGestures.close();
    rxSkeleton.close();
    serverProc.kill('SIGTERM');
  }
});

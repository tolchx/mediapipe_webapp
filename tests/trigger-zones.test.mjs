import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TriggerZoneEngine,
  getZoneHandles,
  hitTestZoneNormalized,
} from '../src/vision/triggerZones.ts';
import { buildOscMessages } from '../src/osc/oscProtocol.ts';

function makeMockFrame(timestamp, indexTipX, indexTipY, side = 'right', pinchActive = false) {
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.9, y: 0.9, z: 0 }));
  landmarks[4] = { x: indexTipX - 0.02, y: indexTipY, z: 0 };
  landmarks[8] = { x: indexTipX, y: indexTipY, z: 0 };
  const palmCenter = { x: indexTipX, y: indexTipY + 0.1, z: 0 };

  const hand = {
    side,
    score: 0.98,
    landmarks,
    worldLandmarks: landmarks,
    palmCenter,
    palmOpenness: 0.8,
    palmOrientation: { pitch: 0, yaw: 0, roll: 0 },
    palmVelocity: 0.1,
    spread: { thumbIndex: 0.5, indexMiddle: 0.2, middleRing: 0.2, ringPinky: 0.2 },
    fingers: {
      thumb: { key: 'thumb', label: 'Pulgar', tipIndex: 4, curl: 0.1, extended: 0.9, phalanges: { proximal: { flex: 0.1, angleDeg: 10 }, intermediate: { flex: 0.1, angleDeg: 10 }, distal: { flex: 0.1, angleDeg: 10 } }, tipPosition: landmarks[4] },
      index: { key: 'index', label: 'Índice', tipIndex: 8, curl: 0.1, extended: 0.9, phalanges: { proximal: { flex: 0.1, angleDeg: 10 }, intermediate: { flex: 0.1, angleDeg: 10 }, distal: { flex: 0.1, angleDeg: 10 } }, tipPosition: landmarks[8] },
      middle: { key: 'middle', label: 'Medio', tipIndex: 12, curl: 0.1, extended: 0.9, phalanges: { proximal: { flex: 0.1, angleDeg: 10 }, intermediate: { flex: 0.1, angleDeg: 10 }, distal: { flex: 0.1, angleDeg: 10 } }, tipPosition: landmarks[12] },
      ring: { key: 'ring', label: 'Anular', tipIndex: 16, curl: 0.1, extended: 0.9, phalanges: { proximal: { flex: 0.1, angleDeg: 10 }, intermediate: { flex: 0.1, angleDeg: 10 }, distal: { flex: 0.1, angleDeg: 10 } }, tipPosition: landmarks[16] },
      pinky: { key: 'pinky', label: 'Meñique', tipIndex: 20, curl: 0.1, extended: 0.9, phalanges: { proximal: { flex: 0.1, angleDeg: 10 }, intermediate: { flex: 0.1, angleDeg: 10 }, distal: { flex: 0.1, angleDeg: 10 } }, tipPosition: landmarks[20] },
    },
    pinches: {
      index: { target: 'index', label: 'Pulgar · Índice', distanceNorm: pinchActive ? 0.3 : 1.0, closeness: pinchActive ? 0.95 : 0.1, active: pinchActive },
      middle: { target: 'middle', label: 'Pulgar · Medio', distanceNorm: 1.0, closeness: 0.1, active: false },
      ring: { target: 'ring', label: 'Pulgar · Anular', distanceNorm: 1.0, closeness: 0.1, active: false },
      pinky: { target: 'pinky', label: 'Pulgar · Meñique', distanceNorm: 1.0, closeness: 0.1, active: false },
    },
  };

  return {
    timestamp,
    source: 'simulator',
    hands: [hand],
    left: side === 'left' ? hand : null,
    right: side === 'right' ? hand : null,
  };
}

test('TriggerZoneEngine handles pulse, momentary, and toggle modes with rect and circle shapes', () => {
  const engine = new TriggerZoneEngine();
  engine.applyPreset('clear');

  const pulsePad = engine.addZone({
    id: 'p_pulse',
    name: 'Pulse Pad',
    shape: 'rect',
    x: 0.2,
    y: 0.3,
    width: 0.2,
    height: 0.2,
    mode: 'pulse',
    pulseDurationMs: 100,
    cooldownMs: 150,
    target: 'index_tip',
    oscAddress: '/td/pad/pulse',
  });

  const holdPad = engine.addZone({
    id: 'p_hold',
    name: 'Hold Circle',
    shape: 'circle',
    x: 0.7,
    y: 0.5,
    width: 0.3,
    mode: 'momentary',
    target: 'index_tip',
    oscAddress: '/td/pad/hold',
  });

  const togglePad = engine.addZone({
    id: 'p_toggle',
    name: 'Toggle Pad',
    shape: 'rect',
    x: 0.5,
    y: 0.8,
    width: 0.2,
    height: 0.2,
    mode: 'toggle',
    cooldownMs: 100,
    target: 'index_tip',
    oscAddress: '/td/pad/toggle',
  });

  // Check circle geometry symmetry & handles
  assert.equal(hitTestZoneNormalized(holdPad, 0.7, 0.5, 16 / 9).inside, true);
  assert.equal(hitTestZoneNormalized(holdPad, 0.7, 0.7, 16 / 9).inside, false);
  assert.equal(getZoneHandles(pulsePad, { x: 0, y: 0, w: 1280, h: 720 }).length, 8);
  assert.equal(getZoneHandles(holdPad, { x: 0, y: 0, w: 1280, h: 720 }).length, 4);

  // Frame 1: outside all zones
  let res = engine.evaluate(makeMockFrame(1000, 0.05, 0.05), false, 16 / 9);
  assert.deepEqual(res.map((r) => r.value), [0, 0, 0]);

  // Frame 2: index enters pulsePad at (0.2, 0.3)
  res = engine.evaluate(makeMockFrame(1020, 0.2, 0.3), false, 16 / 9);
  assert.equal(res[0].zone.id, pulsePad.id);
  assert.equal(res[0].justTriggered, true);
  assert.equal(res[0].value, 1);

  // Frame 3: still inside pulsePad after pulseDurationMs (1020 + 100 = 1120) -> returns to 0
  res = engine.evaluate(makeMockFrame(1150, 0.2, 0.3), false, 16 / 9);
  assert.equal(res[0].inside, true);
  assert.equal(res[0].value, 0);

  // Frame 4: enters holdPad circle -> stays 1 while inside, then 0 on exit
  res = engine.evaluate(makeMockFrame(1200, 0.7, 0.5), false, 16 / 9);
  assert.equal(res[1].value, 1);
  res = engine.evaluate(makeMockFrame(1250, 0.9, 0.9), false, 16 / 9);
  assert.equal(res[1].value, 0);

  // Frame 5 & 6: togglePad flips 0 -> 1 on entry, stays 1 on exit, flips 1 -> 0 on re-entry
  res = engine.evaluate(makeMockFrame(1300, 0.5, 0.8), false, 16 / 9);
  assert.equal(res[2].value, 1);
  res = engine.evaluate(makeMockFrame(1350, 0.9, 0.9), false, 16 / 9);
  assert.equal(res[2].value, 1);
  res = engine.evaluate(makeMockFrame(1500, 0.5, 0.8), false, 16 / 9);
  assert.equal(res[2].value, 0);
  assert.equal(togglePad.id, res[2].zone.id);

  // Verify OSC serialization emits /td/pad/* messages
  const frame = makeMockFrame(1600, 0.7, 0.5);
  const evals = engine.evaluate(frame, false, 16 / 9);
  const msgs = buildOscMessages(
    frame,
    {
      active: false,
      handDetected: true,
      primarySide: 'right',
      rawFreqHz: 220,
      quantizedFreqHz: 220,
      midiNote: 57,
      noteName: 'A3',
      centsOff: 0,
      cutoffHz: 2200,
      resonanceQ: 3.2,
      fmDepthHz: 0,
      lfoRateHz: 4.5,
      lfoDepthHz: 0,
      subMix: 0,
      gain: 0.5,
      pitchBendCents: 0,
      driverValues: {
        pitchDriverLabel: 'Palma Y',
        pitchDriverNorm: 0.5,
        cutoffDriverLabel: 'Índice',
        cutoffDriverNorm: 0.5,
        fmDriverLabel: 'Medio',
        fmDriverNorm: 0,
        lfoDriverLabel: 'Anular',
        lfoDriverNorm: 0,
        subDriverLabel: 'Meñique',
        subDriverNorm: 0,
      },
    },
    { palm: false, fingers: false, phalanges: false, landmarks: false, synth: false, triggers: true, triggerSubchannels: true },
    evals
  );

  const holdMsg = msgs.find((m) => m.address === '/td/pad/hold');
  assert.ok(holdMsg, 'Expected /td/pad/hold OSC message');
  assert.equal(holdMsg.args[0].value, 1);
  assert.ok(msgs.some((m) => m.address === '/td/pad/hold/xy'));
  assert.ok(msgs.some((m) => m.address === '/td/pad/hold/count'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { HandBlobSystem } from '../src/vision/handBlobSystem.ts';

function makeHand(side, x, y, pinchActive = false) {
  const mkTip = (tx, ty) => ({ x: tx, y: ty, z: 0 });
  const finger = (key, tx, ty) => ({
    key,
    label: key,
    tipIndex: 8,
    curl: 0.2,
    extended: 0.8,
    phalanges: {
      proximal: { key: 'proximal', label: 'p', joint: 'MCP', indices: [0, 1, 2], boneIndices: [1, 2], angleDeg: 10, flex: 0.1, extended: 0.9, lengthWorld: 0.03 },
      intermediate: { key: 'intermediate', label: 'i', joint: 'PIP', indices: [1, 2, 3], boneIndices: [2, 3], angleDeg: 10, flex: 0.1, extended: 0.9, lengthWorld: 0.02 },
      distal: { key: 'distal', label: 'd', joint: 'DIP', indices: [2, 3, 4], boneIndices: [3, 4], angleDeg: 10, flex: 0.1, extended: 0.9, lengthWorld: 0.015 },
    },
    tipPosition: mkTip(tx, ty),
  });

  return {
    side,
    score: 0.98,
    landmarks: [],
    worldLandmarks: [],
    palmCenter: { x, y, z: 0 },
    palmOpenness: 0.8,
    palmOrientation: { pitch: 0, yaw: 0, roll: 0 },
    palmVelocity: 0.1,
    spread: { thumbIndex: 0.3, indexMiddle: 0.2, middleRing: 0.2, ringPinky: 0.2 },
    fingers: {
      thumb: finger('thumb', x - 0.05, y - 0.04),
      index: finger('index', x + 0.02, y - 0.12),
      middle: finger('middle', x + 0.04, y - 0.13),
      ring: finger('ring', x + 0.06, y - 0.11),
      pinky: finger('pinky', x + 0.08, y - 0.08),
    },
    pinches: {
      index: { target: 'index', label: 'Index', distanceNorm: pinchActive ? 0.02 : 0.2, closeness: pinchActive ? 0.95 : 0.1, active: pinchActive },
      middle: { target: 'middle', label: 'Middle', distanceNorm: 0.2, closeness: 0.1, active: false },
      ring: { target: 'ring', label: 'Ring', distanceNorm: 0.2, closeness: 0.1, active: false },
      pinky: { target: 'pinky', label: 'Pinky', distanceNorm: 0.2, closeness: 0.1, active: false },
    },
  };
}

test('HandBlobSystem computes mirrored coordinates, velocity deltas, and emitter modes', () => {
  const system = new HandBlobSystem({ emitterMode: 'palms_and_index', minSpeedThreshold: 0.002 });

  const frame1 = {
    timestamp: 1000,
    source: 'simulator',
    hands: [makeHand('right', 0.3, 0.5)],
    left: null,
    right: null,
    poses: [],
    rawGestures: [],
  };
  frame1.right = frame1.hands[0];

  const blobs1 = system.processFrame(frame1, true);
  assert.equal(blobs1.length, 2);
  // Mirrored: 1 - 0.3 = 0.7
  assert.ok(Math.abs(blobs1[0].x - 0.7) < 1e-6);
  assert.equal(blobs1[0].active, false); // First frame has zero delta

  const frame2 = {
    ...frame1,
    timestamp: 1016.67,
    hands: [makeHand('right', 0.35, 0.45)],
  };
  frame2.right = frame2.hands[0];

  const blobs2 = system.processFrame(frame2, true);
  assert.equal(blobs2.length, 2);
  // Mirrored x moved from 0.70 to 0.65 => dx ~ -0.05, y moved from 0.50 to 0.45 => dy ~ -0.05
  assert.ok(blobs2[0].dx < -0.04);
  assert.ok(blobs2[0].dy < -0.04);
  assert.equal(blobs2[0].active, true);

  // Fingertips mode produces 5 blobs per hand
  system.updateConfig({ emitterMode: 'fingertips' });
  const blobs3 = system.processFrame(frame2, false);
  assert.equal(blobs3.length, 5);

  // Pinch mode activates only when pinching
  system.updateConfig({ emitterMode: 'pinch' });
  const pinchOff = system.processFrame(frame2, false);
  assert.equal(pinchOff.length, 1);
  assert.equal(pinchOff[0].active, false);

  const framePinch = {
    ...frame2,
    timestamp: 1033.34,
    hands: [makeHand('right', 0.4, 0.4, true)],
  };
  const pinchOn = system.processFrame(framePinch, false);
  assert.equal(pinchOn.length, 1);
  assert.equal(pinchOn[0].active, true);
});

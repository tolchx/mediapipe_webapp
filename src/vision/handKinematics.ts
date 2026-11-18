import type {
  FingerKey,
  FingerState,
  HandKinematics,
  HandSide,
  PalmOrientation,
  PhalanxKey,
  PhalanxState,
  PinchState,
  PinchTarget,
  Vec3,
} from '../types/hand';

interface PhalanxSpec {
  key: PhalanxKey;
  label: string;
  joint: string;
  indices: [number, number, number];
  boneIndices: [number, number];
  deadzoneDeg: number;
  maxAngleDeg: number;
}

interface FingerSpec {
  key: FingerKey;
  label: string;
  tipIndex: number;
  phalanges: PhalanxSpec[];
}

export const FINGER_SPECS: FingerSpec[] = [
  {
    key: 'thumb',
    label: 'Pulgar',
    tipIndex: 4,
    phalanges: [
      {
        key: 'proximal',
        label: 'Metacarpiano',
        joint: 'CMC',
        indices: [0, 1, 2],
        boneIndices: [1, 2],
        deadzoneDeg: 18,
        maxAngleDeg: 58,
      },
      {
        key: 'intermediate',
        label: 'Falange Proximal',
        joint: 'MCP',
        indices: [1, 2, 3],
        boneIndices: [2, 3],
        deadzoneDeg: 8,
        maxAngleDeg: 68,
      },
      {
        key: 'distal',
        label: 'Falange Distal',
        joint: 'IP',
        indices: [2, 3, 4],
        boneIndices: [3, 4],
        deadzoneDeg: 6,
        maxAngleDeg: 80,
      },
    ],
  },
  {
    key: 'index',
    label: 'Índice',
    tipIndex: 8,
    phalanges: [
      {
        key: 'proximal',
        label: 'Falange Proximal',
        joint: 'MCP',
        indices: [0, 5, 6],
        boneIndices: [5, 6],
        deadzoneDeg: 10,
        maxAngleDeg: 95,
      },
      {
        key: 'intermediate',
        label: 'Falange Media',
        joint: 'PIP',
        indices: [5, 6, 7],
        boneIndices: [6, 7],
        deadzoneDeg: 6,
        maxAngleDeg: 105,
      },
      {
        key: 'distal',
        label: 'Falange Distal',
        joint: 'DIP',
        indices: [6, 7, 8],
        boneIndices: [7, 8],
        deadzoneDeg: 5,
        maxAngleDeg: 80,
      },
    ],
  },
  {
    key: 'middle',
    label: 'Medio',
    tipIndex: 12,
    phalanges: [
      {
        key: 'proximal',
        label: 'Falange Proximal',
        joint: 'MCP',
        indices: [0, 9, 10],
        boneIndices: [9, 10],
        deadzoneDeg: 10,
        maxAngleDeg: 95,
      },
      {
        key: 'intermediate',
        label: 'Falange Media',
        joint: 'PIP',
        indices: [9, 10, 11],
        boneIndices: [10, 11],
        deadzoneDeg: 6,
        maxAngleDeg: 105,
      },
      {
        key: 'distal',
        label: 'Falange Distal',
        joint: 'DIP',
        indices: [10, 11, 12],
        boneIndices: [11, 12],
        deadzoneDeg: 5,
        maxAngleDeg: 80,
      },
    ],
  },
  {
    key: 'ring',
    label: 'Anular',
    tipIndex: 16,
    phalanges: [
      {
        key: 'proximal',
        label: 'Falange Proximal',
        joint: 'MCP',
        indices: [0, 13, 14],
        boneIndices: [13, 14],
        deadzoneDeg: 10,
        maxAngleDeg: 95,
      },
      {
        key: 'intermediate',
        label: 'Falange Media',
        joint: 'PIP',
        indices: [13, 14, 15],
        boneIndices: [14, 15],
        deadzoneDeg: 6,
        maxAngleDeg: 105,
      },
      {
        key: 'distal',
        label: 'Falange Distal',
        joint: 'DIP',
        indices: [14, 15, 16],
        boneIndices: [15, 16],
        deadzoneDeg: 5,
        maxAngleDeg: 80,
      },
    ],
  },
  {
    key: 'pinky',
    label: 'Meñique',
    tipIndex: 20,
    phalanges: [
      {
        key: 'proximal',
        label: 'Falange Proximal',
        joint: 'MCP',
        indices: [0, 17, 18],
        boneIndices: [17, 18],
        deadzoneDeg: 10,
        maxAngleDeg: 95,
      },
      {
        key: 'intermediate',
        label: 'Falange Media',
        joint: 'PIP',
        indices: [17, 18, 19],
        boneIndices: [18, 19],
        deadzoneDeg: 6,
        maxAngleDeg: 105,
      },
      {
        key: 'distal',
        label: 'Falange Distal',
        joint: 'DIP',
        indices: [18, 19, 20],
        boneIndices: [19, 20],
        deadzoneDeg: 5,
        maxAngleDeg: 80,
      },
    ],
  },
];

const PINCH_TARGETS: Array<{ target: PinchTarget; label: string; tipIndex: number }> = [
  { target: 'index', label: 'Pulgar · Índice', tipIndex: 8 },
  { target: 'middle', label: 'Pulgar · Medio', tipIndex: 12 },
  { target: 'ring', label: 'Pulgar · Anular', tipIndex: 16 },
  { target: 'pinky', label: 'Pulgar · Meñique', tipIndex: 20 },
];

export const LANDMARK_NAMES: string[] = [
  'WRIST',
  'THUMB_CMC',
  'THUMB_MCP',
  'THUMB_IP',
  'THUMB_TIP',
  'INDEX_MCP',
  'INDEX_PIP',
  'INDEX_DIP',
  'INDEX_TIP',
  'MIDDLE_MCP',
  'MIDDLE_PIP',
  'MIDDLE_DIP',
  'MIDDLE_TIP',
  'RING_MCP',
  'RING_PIP',
  'RING_DIP',
  'RING_TIP',
  'PINKY_MCP',
  'PINKY_PIP',
  'PINKY_DIP',
  'PINKY_TIP',
];

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function norm(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function normalize(v: Vec3): Vec3 {
  const len = norm(v);
  if (len < 1e-7) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function angleBetweenDeg(v1: Vec3, v2: Vec3): number {
  const u1 = normalize(v1);
  const u2 = normalize(v2);
  const cosTheta = clamp(dot(u1, u2), -1, 1);
  return (Math.acos(cosTheta) * 180) / Math.PI;
}

function jointFlexionAngleDeg(a: Vec3, b: Vec3, c: Vec3): number {
  return angleBetweenDeg(sub(b, a), sub(c, b));
}

function lerpVec3Array(prev: Vec3[], next: Vec3[], alpha: number): Vec3[] {
  return next.map((p, i) => {
    const q = prev[i] ?? p;
    return {
      x: q.x + (p.x - q.x) * alpha,
      y: q.y + (p.y - q.y) * alpha,
      z: q.z + (p.z - q.z) * alpha,
    };
  });
}

function computePalmCenter(landmarks: Vec3[]): Vec3 {
  // Promedio de muñeca (0) y las 4 bases MCP (5, 9, 13, 17)
  const indices = [0, 5, 9, 13, 17];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const idx of indices) {
    x += landmarks[idx].x;
    y += landmarks[idx].y;
    z += landmarks[idx].z;
  }
  const n = indices.length;
  return { x: x / n, y: y / n, z: z / n };
}

function computePalmOrientation(world: Vec3[]): PalmOrientation {
  const wrist = world[0];
  const indexMcp = world[5];
  const middleMcp = world[9];
  const pinkyMcp = world[17];

  const up = normalize(sub(middleMcp, wrist)); // eje longitudinal de la mano
  const across = normalize(sub(pinkyMcp, indexMcp)); // eje transversal
  const normal = normalize(cross(up, across)); // normal de la palma

  const pitch = (Math.asin(clamp(-up.z, -1, 1)) * 180) / Math.PI;
  const yaw = (Math.atan2(normal.x, normal.z) * 180) / Math.PI;
  const roll = (Math.atan2(up.x, -up.y) * 180) / Math.PI;

  return { pitch, yaw, roll };
}

interface SmoothingCache {
  landmarks: Vec3[];
  worldLandmarks: Vec3[];
  palmCenter: Vec3;
  timestamp: number;
  velocity: number;
}

export class HandKinematicsProcessor {
  private cache = new Map<HandSide, SmoothingCache>();
  private smoothingAlpha = 0.48;

  setSmoothing(alpha: number): void {
    this.smoothingAlpha = clamp(alpha, 0.1, 1.0);
  }

  getSmoothing(): number {
    return this.smoothingAlpha;
  }

  reset(): void {
    this.cache.clear();
  }

  processHand(
    side: HandSide,
    score: number,
    rawLandmarks: Vec3[],
    rawWorldLandmarks: Vec3[],
    timestamp: number
  ): HandKinematics {
    const prev = this.cache.get(side);
    const stale = !prev || timestamp - prev.timestamp > 300;
    const alpha = stale ? 1.0 : this.smoothingAlpha;

    const landmarks = stale ? rawLandmarks : lerpVec3Array(prev.landmarks, rawLandmarks, alpha);
    const worldSource = rawWorldLandmarks.length === 21 ? rawWorldLandmarks : rawLandmarks;
    const worldLandmarks = stale
      ? worldSource
      : lerpVec3Array(prev.worldLandmarks, worldSource, alpha);

    const palmCenter = computePalmCenter(landmarks);
    let palmVelocity = 0;
    if (!stale && prev) {
      const dt = Math.max((timestamp - prev.timestamp) / 1000, 1 / 120);
      const rawVel = dist(palmCenter, prev.palmCenter) / dt;
      palmVelocity = prev.velocity * 0.6 + rawVel * 0.4;
    }

    this.cache.set(side, {
      landmarks,
      worldLandmarks,
      palmCenter,
      timestamp,
      velocity: palmVelocity,
    });

    const fingers = {} as Record<FingerKey, FingerState>;
    let opennessSum = 0;

    for (const spec of FINGER_SPECS) {
      const phalanges = {} as Record<PhalanxKey, PhalanxState>;
      for (const pSpec of spec.phalanges) {
        const [a, b, c] = pSpec.indices;
        const angleDeg = jointFlexionAngleDeg(
          worldLandmarks[a],
          worldLandmarks[b],
          worldLandmarks[c]
        );
        const flex = clamp(
          (angleDeg - pSpec.deadzoneDeg) / (pSpec.maxAngleDeg - pSpec.deadzoneDeg),
          0,
          1
        );
        const [b0, b1] = pSpec.boneIndices;
        phalanges[pSpec.key] = {
          key: pSpec.key,
          label: pSpec.label,
          joint: pSpec.joint,
          indices: pSpec.indices,
          boneIndices: pSpec.boneIndices,
          angleDeg,
          flex,
          extended: 1 - flex,
          lengthWorld: dist(worldLandmarks[b0], worldLandmarks[b1]),
        };
      }

      const curl = clamp(
        phalanges.proximal.flex * 0.36 +
          phalanges.intermediate.flex * 0.42 +
          phalanges.distal.flex * 0.22,
        0,
        1
      );
      const extended = 1 - curl;
      opennessSum += extended;

      fingers[spec.key] = {
        key: spec.key,
        label: spec.label,
        tipIndex: spec.tipIndex,
        curl,
        extended,
        phalanges,
        tipPosition: landmarks[spec.tipIndex],
      };
    }

    // Escala de palma para distancias normalizadas independientes de distancia a cámara
    const palmScale = Math.max(dist(worldLandmarks[5], worldLandmarks[17]), 0.035);
    const thumbTip = worldLandmarks[4];

    const pinches = {} as Record<PinchTarget, PinchState>;
    for (const pTarget of PINCH_TARGETS) {
      const d = dist(thumbTip, worldLandmarks[pTarget.tipIndex]);
      const distanceNorm = d / palmScale;
      // 0.35 palmScale o menos => contacto fuerte (closeness -> 1); > 1.35 => abierto (closeness -> 0)
      const closeness = clamp(1 - (distanceNorm - 0.32) / 1.15, 0, 1);
      pinches[pTarget.target] = {
        target: pTarget.target,
        label: pTarget.label,
        distanceNorm,
        closeness,
        active: distanceNorm < 0.52,
      };
    }

    const spread = {
      thumbIndex: clamp(angleBetweenDeg(sub(worldLandmarks[4], worldLandmarks[2]), sub(worldLandmarks[8], worldLandmarks[5])) / 65, 0, 1),
      indexMiddle: clamp(angleBetweenDeg(sub(worldLandmarks[8], worldLandmarks[5]), sub(worldLandmarks[12], worldLandmarks[9])) / 40, 0, 1),
      middleRing: clamp(angleBetweenDeg(sub(worldLandmarks[12], worldLandmarks[9]), sub(worldLandmarks[16], worldLandmarks[13])) / 35, 0, 1),
      ringPinky: clamp(angleBetweenDeg(sub(worldLandmarks[16], worldLandmarks[13]), sub(worldLandmarks[20], worldLandmarks[17])) / 40, 0, 1),
    };

    return {
      side,
      score,
      landmarks,
      worldLandmarks,
      palmCenter,
      palmOpenness: clamp(opennessSum / 5, 0, 1),
      palmOrientation: computePalmOrientation(worldLandmarks),
      palmVelocity,
      spread,
      fingers,
      pinches,
    };
  }
}

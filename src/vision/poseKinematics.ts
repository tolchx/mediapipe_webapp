import type {
  HandKinematics,
  PoseJointAngles,
  PoseKinematics,
  PoseLandmark,
  PoseTorsoMetrics,
  Vec3,
} from '../types/hand';

export const POSE_LANDMARK_NAMES: string[] = [
  'nose',
  'left_eye_inner',
  'left_eye',
  'left_eye_outer',
  'right_eye_inner',
  'right_eye',
  'right_eye_outer',
  'left_ear',
  'right_ear',
  'mouth_left',
  'mouth_right',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_pinky',
  'right_pinky',
  'left_index',
  'right_index',
  'left_thumb',
  'right_thumb',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
  'left_heel',
  'right_heel',
  'left_foot_index',
  'right_foot_index',
];

export const KEY_POSE_JOINTS: Array<{ index: number; name: string; label: string }> = [
  { index: 0, name: 'nose', label: 'Nariz / Cabeza' },
  { index: 11, name: 'left_shoulder', label: 'Hombro Izq' },
  { index: 12, name: 'right_shoulder', label: 'Hombro Der' },
  { index: 13, name: 'left_elbow', label: 'Codo Izq' },
  { index: 14, name: 'right_elbow', label: 'Codo Der' },
  { index: 15, name: 'left_wrist', label: 'Muñeca Izq' },
  { index: 16, name: 'right_wrist', label: 'Muñeca Der' },
  { index: 23, name: 'left_hip', label: 'Cadera Izq' },
  { index: 24, name: 'right_hip', label: 'Cadera Der' },
  { index: 25, name: 'left_knee', label: 'Rodilla Izq' },
  { index: 26, name: 'right_knee', label: 'Rodilla Der' },
  { index: 27, name: 'left_ankle', label: 'Tobillo Izq' },
  { index: 28, name: 'right_ankle', label: 'Tobillo Der' },
];

export interface PoseSegmentGroup {
  group: 'torso' | 'left' | 'right' | 'head';
  pairs: Array<[number, number]>;
}

export const POSE_SKELETON_GROUPS: PoseSegmentGroup[] = [
  {
    group: 'torso',
    pairs: [
      [11, 12],
      [23, 24],
      [11, 23],
      [12, 24],
    ],
  },
  {
    group: 'left',
    pairs: [
      [11, 13],
      [13, 15],
      [15, 17],
      [15, 19],
      [15, 21],
      [17, 19],
      [23, 25],
      [25, 27],
      [27, 29],
      [27, 31],
      [29, 31],
    ],
  },
  {
    group: 'right',
    pairs: [
      [12, 14],
      [14, 16],
      [16, 18],
      [16, 20],
      [16, 22],
      [18, 20],
      [24, 26],
      [26, 28],
      [28, 30],
      [28, 32],
      [30, 32],
    ],
  },
  {
    group: 'head',
    pairs: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 7],
      [0, 4],
      [4, 5],
      [5, 6],
      [6, 8],
      [9, 10],
    ],
  },
];

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, z: (a.z + b.z) * 0.5 };
}

function jointAngleDeg(a: Vec3, b: Vec3, c: Vec3): number {
  const v1 = sub(a, b);
  const v2 = sub(c, b);
  const n1 = Math.hypot(v1.x, v1.y, v1.z);
  const n2 = Math.hypot(v2.x, v2.y, v2.z);
  if (n1 < 1e-6 || n2 < 1e-6) return 180;
  const dot = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (n1 * n2);
  return (Math.acos(clamp(dot, -1, 1)) * 180) / Math.PI;
}

function lerpPoseArray(
  prev: PoseLandmark[],
  next: PoseLandmark[],
  alpha: number
): PoseLandmark[] {
  return next.map((p, i) => {
    const q = prev[i] ?? p;
    return {
      x: q.x + (p.x - q.x) * alpha,
      y: q.y + (p.y - q.y) * alpha,
      z: q.z + (p.z - q.z) * alpha,
      visibility: p.visibility ?? q.visibility ?? 1,
    };
  });
}

function computeTorsoLean(world: PoseLandmark[]): PoseTorsoMetrics {
  const hipCenter = midpoint(world[23], world[24]);
  const shoulderCenter = midpoint(world[11], world[12]);
  // En worldLandmarks de MediaPipe Pose, Y negativo apunta hacia arriba
  const spine = sub(shoulderCenter, hipCenter);
  const spineLen = Math.hypot(spine.x, spine.y, spine.z) || 1;
  const upY = -spine.y;

  const forwardDeg = (Math.atan2(-spine.z, Math.max(upY, 1e-4)) * 180) / Math.PI;
  const lateralDeg = (Math.atan2(spine.x, Math.max(upY, 1e-4)) * 180) / Math.PI;

  const shoulderVec = sub(world[12], world[11]);
  const twistDeg =
    (Math.atan2(shoulderVec.z, Math.max(Math.abs(shoulderVec.x), spineLen * 0.15)) * 180) /
    Math.PI;

  return { forwardDeg, lateralDeg, twistDeg };
}

interface PoseSmoothingCache {
  landmarks: PoseLandmark[];
  worldLandmarks: PoseLandmark[];
  timestamp: number;
}

export class PoseKinematicsProcessor {
  private cache = new Map<number, PoseSmoothingCache>();
  private smoothingAlpha = 0.5;

  setSmoothing(alpha: number): void {
    this.smoothingAlpha = clamp(alpha, 0.1, 1.0);
  }

  reset(): void {
    this.cache.clear();
  }

  processPose(
    id: number,
    rawLandmarks: PoseLandmark[],
    rawWorldLandmarks: PoseLandmark[],
    timestamp: number
  ): PoseKinematics {
    const prev = this.cache.get(id);
    const stale = !prev || timestamp - prev.timestamp > 350;
    const alpha = stale ? 1.0 : this.smoothingAlpha;

    const landmarks = stale ? rawLandmarks : lerpPoseArray(prev.landmarks, rawLandmarks, alpha);
    const worldSource = rawWorldLandmarks.length === 33 ? rawWorldLandmarks : rawLandmarks;
    const worldLandmarks = stale
      ? worldSource
      : lerpPoseArray(prev.worldLandmarks, worldSource, alpha);

    this.cache.set(id, { landmarks, worldLandmarks, timestamp });

    const centerOfMass = midpoint(landmarks[23], landmarks[24]);
    const shoulderCenter = midpoint(landmarks[11], landmarks[12]);
    const torsoLean = computeTorsoLean(worldLandmarks);

    const angles: PoseJointAngles = {
      leftElbow: jointAngleDeg(worldLandmarks[11], worldLandmarks[13], worldLandmarks[15]),
      rightElbow: jointAngleDeg(worldLandmarks[12], worldLandmarks[14], worldLandmarks[16]),
      leftShoulder: jointAngleDeg(worldLandmarks[23], worldLandmarks[11], worldLandmarks[13]),
      rightShoulder: jointAngleDeg(worldLandmarks[24], worldLandmarks[12], worldLandmarks[14]),
      leftHip: jointAngleDeg(worldLandmarks[11], worldLandmarks[23], worldLandmarks[25]),
      rightHip: jointAngleDeg(worldLandmarks[12], worldLandmarks[24], worldLandmarks[26]),
      leftKnee: jointAngleDeg(worldLandmarks[23], worldLandmarks[25], worldLandmarks[27]),
      rightKnee: jointAngleDeg(worldLandmarks[24], worldLandmarks[26], worldLandmarks[28]),
    };

    let visSum = 0;
    for (const lm of landmarks) {
      visSum += lm.visibility ?? 1;
    }

    return {
      id,
      landmarks,
      worldLandmarks,
      centerOfMass,
      shoulderCenter,
      torsoLean,
      angles,
      visibilityMean: visSum / Math.max(landmarks.length, 1),
    };
  }
}

export function buildVirtualPose(
  nowMs: number,
  hands: HandKinematics[]
): { landmarks: PoseLandmark[]; worldLandmarks: PoseLandmark[] } {
  const t = nowMs / 1000;
  const swayX = Math.sin(t * 0.8) * 0.012;
  const breathY = Math.sin(t * 1.9) * 0.006;

  const cx = 0.5 + swayX;
  const headY = 0.16 + breathY;
  const shoulderY = 0.31 + breathY;
  const hipY = 0.58;
  const kneeY = 0.78;
  const ankleY = 0.94;

  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: cx,
    y: 0.5,
    z: 0,
    visibility: 0.98,
  }));

  // Cabeza
  landmarks[0] = { x: cx, y: headY, z: -0.05, visibility: 0.99 };
  landmarks[1] = { x: cx - 0.01, y: headY - 0.015, z: -0.04, visibility: 0.99 };
  landmarks[2] = { x: cx - 0.018, y: headY - 0.015, z: -0.04, visibility: 0.99 };
  landmarks[3] = { x: cx - 0.024, y: headY - 0.015, z: -0.03, visibility: 0.99 };
  landmarks[4] = { x: cx + 0.01, y: headY - 0.015, z: -0.04, visibility: 0.99 };
  landmarks[5] = { x: cx + 0.018, y: headY - 0.015, z: -0.04, visibility: 0.99 };
  landmarks[6] = { x: cx + 0.024, y: headY - 0.015, z: -0.03, visibility: 0.99 };
  landmarks[7] = { x: cx - 0.036, y: headY - 0.005, z: 0.0, visibility: 0.98 };
  landmarks[8] = { x: cx + 0.036, y: headY - 0.005, z: 0.0, visibility: 0.98 };
  landmarks[9] = { x: cx - 0.012, y: headY + 0.02, z: -0.04, visibility: 0.98 };
  landmarks[10] = { x: cx + 0.012, y: headY + 0.02, z: -0.04, visibility: 0.98 };

  // Hombros y caderas
  const lShoulder = { x: cx - 0.11, y: shoulderY, z: 0, visibility: 0.99 };
  const rShoulder = { x: cx + 0.11, y: shoulderY, z: 0, visibility: 0.99 };
  landmarks[11] = lShoulder;
  landmarks[12] = rShoulder;
  landmarks[23] = { x: cx - 0.075, y: hipY, z: 0, visibility: 0.99 };
  landmarks[24] = { x: cx + 0.075, y: hipY, z: 0, visibility: 0.99 };

  // Piernas
  landmarks[25] = { x: cx - 0.08, y: kneeY, z: -0.02, visibility: 0.97 };
  landmarks[26] = { x: cx + 0.08, y: kneeY, z: -0.02, visibility: 0.97 };
  landmarks[27] = { x: cx - 0.085, y: ankleY, z: 0.02, visibility: 0.96 };
  landmarks[28] = { x: cx + 0.085, y: ankleY, z: 0.02, visibility: 0.96 };
  landmarks[29] = { x: cx - 0.085, y: ankleY + 0.02, z: 0.04, visibility: 0.94 };
  landmarks[30] = { x: cx + 0.085, y: ankleY + 0.02, z: 0.04, visibility: 0.94 };
  landmarks[31] = { x: cx - 0.095, y: ankleY + 0.03, z: -0.03, visibility: 0.94 };
  landmarks[32] = { x: cx + 0.095, y: ankleY + 0.03, z: -0.03, visibility: 0.94 };

  // Conectar muñecas con las manos simuladas si existen
  const leftHand = hands.find((h) => h.side === 'left');
  const rightHand = hands.find((h) => h.side === 'right');

  const lWrist = leftHand
    ? { ...leftHand.landmarks[0], visibility: 0.99 }
    : { x: cx - 0.17, y: 0.56 + Math.sin(t * 1.1) * 0.06, z: -0.08, visibility: 0.98 };
  const rWrist = rightHand
    ? { ...rightHand.landmarks[0], visibility: 0.99 }
    : { x: cx + 0.17, y: 0.52 + Math.cos(t * 1.1) * 0.06, z: -0.08, visibility: 0.98 };

  landmarks[15] = lWrist;
  landmarks[16] = rWrist;
  landmarks[13] = {
    x: (lShoulder.x + lWrist.x) * 0.5 - 0.045,
    y: Math.max(lShoulder.y, lWrist.y) * 0.5 + 0.14,
    z: -0.04,
    visibility: 0.98,
  };
  landmarks[14] = {
    x: (rShoulder.x + rWrist.x) * 0.5 + 0.045,
    y: Math.max(rShoulder.y, rWrist.y) * 0.5 + 0.14,
    z: -0.04,
    visibility: 0.98,
  };

  // Puntas de mano aproximadas en pose
  landmarks[17] = { x: lWrist.x - 0.015, y: lWrist.y - 0.03, z: lWrist.z, visibility: 0.95 };
  landmarks[19] = { x: lWrist.x, y: lWrist.y - 0.04, z: lWrist.z, visibility: 0.95 };
  landmarks[21] = { x: lWrist.x + 0.015, y: lWrist.y - 0.02, z: lWrist.z, visibility: 0.95 };

  landmarks[18] = { x: rWrist.x + 0.015, y: rWrist.y - 0.03, z: rWrist.z, visibility: 0.95 };
  landmarks[20] = { x: rWrist.x, y: rWrist.y - 0.04, z: rWrist.z, visibility: 0.95 };
  landmarks[22] = { x: rWrist.x - 0.015, y: rWrist.y - 0.02, z: rWrist.z, visibility: 0.95 };

  // Convertir a worldLandmarks aproximados en metros alrededor de la cadera
  const hipMid = midpoint(landmarks[23], landmarks[24]);
  const worldLandmarks: PoseLandmark[] = landmarks.map((lm) => ({
    x: (lm.x - hipMid.x) * 1.4,
    y: (lm.y - hipMid.y) * 1.65,
    z: lm.z * 1.2,
    visibility: lm.visibility,
  }));

  return { landmarks, worldLandmarks };
}

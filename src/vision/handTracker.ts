import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type {
  FingerKey,
  HandKinematics,
  HandSide,
  PhalanxKey,
  SimulatorControls,
  TrackingFrame,
  TrackingSourceMode,
  Vec3,
} from '../types/hand';
import { HandKinematicsProcessor } from './handKinematics';

function resolvePublicAssetUrl(relativePath: string): string {
  const baseUrl = new URL(import.meta.env.BASE_URL || './', window.location.href);
  return new URL(relativePath.replace(/^\/+/, ''), baseUrl).href;
}

export interface TrackerInitStatus {
  ready: boolean;
  delegate: 'GPU' | 'CPU' | null;
  error: string | null;
}

export interface TrackerOptions {
  numHands: number;
  minDetectionConfidence: number;
  minTrackingConfidence: number;
  swapHandedness: boolean;
}

const DEFAULT_FINGER_ANATOMY: Array<{
  key: FingerKey;
  mcpOffset: [number, number, number];
  spreadRad: number;
  lengths: [number, number, number];
}> = [
  { key: 'thumb', mcpOffset: [-0.032, -0.025, -0.012], spreadRad: -0.68, lengths: [0.028, 0.026, 0.022] },
  { key: 'index', mcpOffset: [-0.028, -0.085, 0], spreadRad: -0.14, lengths: [0.036, 0.024, 0.018] },
  { key: 'middle', mcpOffset: [-0.008, -0.09, 0], spreadRad: 0.0, lengths: [0.04, 0.027, 0.019] },
  { key: 'ring', mcpOffset: [0.013, -0.085, 0], spreadRad: 0.12, lengths: [0.037, 0.025, 0.018] },
  { key: 'pinky', mcpOffset: [0.032, -0.074, 0], spreadRad: 0.25, lengths: [0.03, 0.02, 0.016] },
];

function buildVirtualHand(
  side: HandSide,
  palmCenterX: number,
  palmCenterY: number,
  pinchAperture: number,
  fingerCurls: Record<FingerKey, number>,
  phalanxBias: Record<PhalanxKey, number>,
  tiltDeg: number
): { landmarks: Vec3[]; worldLandmarks: Vec3[] } {
  const mirrorSign = side === 'right' ? 1 : -1;
  const worldLandmarks: Vec3[] = new Array(21);

  // Muñeca en base inferior de la palma
  worldLandmarks[0] = { x: 0, y: 0.06, z: 0 };

  const rollRad = (tiltDeg * Math.PI) / 180;
  const cosR = Math.cos(rollRad);
  const sinR = Math.sin(rollRad);

  const rotateRoll = (v: Vec3): Vec3 => ({
    x: v.x * cosR - v.y * sinR,
    y: v.x * sinR + v.y * cosR,
    z: v.z,
  });

  let idx = 1;
  for (const spec of DEFAULT_FINGER_ANATOMY) {
    const baseCurl = fingerCurls[spec.key];
    // Para el pulgar, también reflejar la apertura de pinch si aplica
    const effectiveCurl =
      spec.key === 'thumb'
        ? Math.min(1, Math.max(0, baseCurl * 0.65 + (1 - pinchAperture) * 0.45))
        : baseCurl;

    const aProx =
      ((spec.key === 'thumb' ? 22 : 12) +
        effectiveCurl * (spec.key === 'thumb' ? 35 : 78) +
        phalanxBias.proximal * 25) *
      (Math.PI / 180);
    const aInter =
      (8 + effectiveCurl * (spec.key === 'thumb' ? 48 : 88) + phalanxBias.intermediate * 28) *
      (Math.PI / 180);
    const aDist =
      (6 + effectiveCurl * 68 + phalanxBias.distal * 24) * (Math.PI / 180);

    const mcp: Vec3 = {
      x: spec.mcpOffset[0] * mirrorSign,
      y: spec.mcpOffset[1] + 0.06,
      z: spec.mcpOffset[2],
    };

    const mcpFromWrist = {
      x: mcp.x - worldLandmarks[0].x,
      y: mcp.y - worldLandmarks[0].y,
      z: mcp.z - worldLandmarks[0].z,
    };
    const baseLen = Math.hypot(mcpFromWrist.x, mcpFromWrist.y, mcpFromWrist.z) || 0.08;
    const baseDir: Vec3 = {
      x: mcpFromWrist.x / baseLen + Math.sin(spec.spreadRad) * 0.28 * mirrorSign,
      y: mcpFromWrist.y / baseLen,
      z: mcpFromWrist.z / baseLen,
    };
    const bNorm = Math.hypot(baseDir.x, baseDir.y, baseDir.z) || 1;
    let dir: Vec3 = { x: baseDir.x / bNorm, y: baseDir.y / bNorm, z: baseDir.z / bNorm };

    const rotateForward = (d: Vec3, theta: number): Vec3 => {
      // Curl hacia cámara (-z) y hacia abajo (+y) manteniendo componente X lateral
      const planar = Math.hypot(d.y, d.z) || 1;
      const curAngle = Math.atan2(-d.z, -d.y);
      const nextAngle = curAngle + theta;
      return {
        x: d.x * Math.cos(theta * 0.35),
        y: -Math.cos(nextAngle) * planar,
        z: -Math.sin(nextAngle) * planar,
      };
    };

    worldLandmarks[idx] = rotateRoll(mcp);
    let current = mcp;

    const angles = [aProx, aInter, aDist];
    for (let seg = 0; seg < 3; seg++) {
      dir = rotateForward(dir, angles[seg]);
      const dLen = Math.hypot(dir.x, dir.y, dir.z) || 1;
      dir = { x: dir.x / dLen, y: dir.y / dLen, z: dir.z / dLen };
      current = {
        x: current.x + dir.x * spec.lengths[seg],
        y: current.y + dir.y * spec.lengths[seg],
        z: current.z + dir.z * spec.lengths[seg],
      };
      worldLandmarks[idx + seg + 1] = rotateRoll(current);
    }

    idx += 4;
  }

  // Acercar suavemente punta del pulgar (4) e índice (8) según pinchAperture (0=juntos, 1=abiertos)
  if (pinchAperture < 0.99) {
    const pull = 1 - pinchAperture;
    const pThumb = worldLandmarks[4];
    const pIndex = worldLandmarks[8];
    const mid: Vec3 = {
      x: (pThumb.x + pIndex.x) * 0.5,
      y: (pThumb.y + pIndex.y) * 0.5,
      z: (pThumb.z + pIndex.z) * 0.5,
    };
    worldLandmarks[4] = {
      x: pThumb.x + (mid.x - pThumb.x) * pull * 0.88,
      y: pThumb.y + (mid.y - pThumb.y) * pull * 0.88,
      z: pThumb.z + (mid.z - pThumb.z) * pull * 0.88,
    };
    worldLandmarks[8] = {
      x: pIndex.x + (mid.x - pIndex.x) * pull * 0.65,
      y: pIndex.y + (mid.y - pIndex.y) * pull * 0.65,
      z: pIndex.z + (mid.z - pIndex.z) * pull * 0.65,
    };
  }

  // Convertir worldLandmarks (metros) a normalized landmarks [0..1]
  const scale = 2.05;
  const landmarks: Vec3[] = worldLandmarks.map((w) => ({
    x: palmCenterX + w.x * scale,
    y: palmCenterY + w.y * scale,
    z: w.z * scale,
  }));

  return { landmarks, worldLandmarks };
}

export class HandTrackerService {
  private landmarker: HandLandmarker | null = null;
  private kinematics = new HandKinematicsProcessor();
  private lastVideoTimeMs = -1;
  private initStatus: TrackerInitStatus = { ready: false, delegate: null, error: null };
  private options: TrackerOptions = {
    numHands: 2,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
    swapHandedness: false,
  };

  async init(onStatus?: (status: TrackerInitStatus) => void): Promise<TrackerInitStatus> {
    if (this.landmarker) return this.initStatus;

    try {
      const vision = await FilesetResolver.forVisionTasks(resolvePublicAssetUrl('mediapipe/wasm'));
      const modelAssetPath = resolvePublicAssetUrl('models/hand_landmarker.task');
      for (const delegate of ['GPU', 'CPU'] as const) {
        try {
          this.landmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath,
              delegate,
            },
            runningMode: 'VIDEO',
            numHands: this.options.numHands,
            minHandDetectionConfidence: this.options.minDetectionConfidence,
            minHandPresenceConfidence: this.options.minDetectionConfidence,
            minTrackingConfidence: this.options.minTrackingConfidence,
          });
          this.initStatus = { ready: true, delegate, error: null };
          onStatus?.(this.initStatus);
          return this.initStatus;
        } catch (err) {
          if (delegate === 'CPU') throw err;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.initStatus = { ready: false, delegate: null, error: message };
      onStatus?.(this.initStatus);
    }
    return this.initStatus;
  }

  getStatus(): TrackerInitStatus {
    return this.initStatus;
  }

  setSmoothing(alpha: number): void {
    this.kinematics.setSmoothing(alpha);
  }

  setSwapHandedness(swap: boolean): void {
    this.options.swapHandedness = swap;
  }

  async setNumHands(numHands: 1 | 2): Promise<void> {
    this.options.numHands = numHands;
    if (this.landmarker) {
      await this.landmarker.setOptions({ numHands });
    }
  }

  resetKinematics(): void {
    this.kinematics.reset();
  }

  detectVideoFrame(video: HTMLVideoElement, nowMs: number): TrackingFrame {
    const empty: TrackingFrame = {
      timestamp: nowMs,
      source: 'camera',
      hands: [],
      left: null,
      right: null,
    };

    if (!this.landmarker || video.readyState < 2 || video.videoWidth === 0) {
      return empty;
    }

    const safeTimestamp = Math.max(nowMs, this.lastVideoTimeMs + 1);
    this.lastVideoTimeMs = safeTimestamp;

    const result: HandLandmarkerResult = this.landmarker.detectForVideo(video, safeTimestamp);
    return this.buildFrameFromResult(result, safeTimestamp, 'camera');
  }

  simulateFrame(controls: SimulatorControls, nowMs: number): TrackingFrame {
    const t = nowMs / 1000;
    const hands: HandKinematics[] = [];

    const buildSimulatedSide = (side: HandSide): HandKinematics => {
      let palmY = controls.palmY;
      let palmX = controls.palmX;
      let pinch = controls.pinchAperture;
      const curls: Record<FingerKey, number> = { ...controls.fingersCurl };
      const bias: Record<PhalanxKey, number> = { ...controls.phalanxBias };
      let tilt = 0;

      if (controls.preset === 'theremin_wave') {
        const phase = side === 'right' ? 0 : Math.PI * 0.6;
        palmY = 0.5 + Math.sin(t * 1.15 + phase) * 0.28;
        palmX = side === 'right' ? 0.66 + Math.cos(t * 0.7) * 0.05 : 0.34 - Math.cos(t * 0.7) * 0.05;
        pinch = 0.55 + Math.sin(t * 1.8 + phase) * 0.35;
        curls.thumb = 0.25 + 0.2 * Math.sin(t * 1.6);
        curls.index = 0.3 + 0.3 * Math.sin(t * 2.1);
        curls.middle = 0.35 + 0.35 * Math.sin(t * 1.4 + 0.8);
        curls.ring = 0.4 + 0.4 * Math.sin(t * 2.4 + 1.5);
        curls.pinky = 0.35 + 0.35 * Math.cos(t * 1.9);
        tilt = Math.sin(t * 0.9 + phase) * 14;
      } else if (controls.preset === 'pinch_sweep') {
        const phase = side === 'right' ? 0 : Math.PI;
        palmY = 0.52;
        palmX = side === 'right' ? 0.64 : 0.36;
        pinch = 0.5 + 0.46 * Math.sin(t * 1.6 + phase);
        curls.index = (1 - pinch) * 0.45;
        curls.middle = 0.45 + 0.4 * Math.sin(t * 1.2 + 1);
        curls.ring = 0.5 + 0.45 * Math.sin(t * 2.0 + 2);
        curls.pinky = 0.3 + 0.35 * Math.cos(t * 1.5);
        tilt = Math.sin(t * 1.1) * 8;
      } else {
        palmX =
          controls.handsCount === 2
            ? side === 'right'
              ? Math.max(0.56, controls.palmX)
              : Math.min(0.44, 1 - controls.palmX)
            : controls.palmX;
      }

      const { landmarks, worldLandmarks } = buildVirtualHand(
        side,
        palmX,
        palmY,
        pinch,
        curls,
        bias,
        tilt
      );
      return this.kinematics.processHand(side, 0.99, landmarks, worldLandmarks, nowMs);
    };

    const right = buildSimulatedSide('right');
    hands.push(right);

    let left: HandKinematics | null = null;
    if (controls.handsCount === 2) {
      left = buildSimulatedSide('left');
      hands.unshift(left);
    }

    return {
      timestamp: nowMs,
      source: 'simulator',
      hands,
      left,
      right,
    };
  }

  private buildFrameFromResult(
    result: HandLandmarkerResult,
    timestamp: number,
    source: TrackingSourceMode
  ): TrackingFrame {
    const hands: HandKinematics[] = [];
    let left: HandKinematics | null = null;
    let right: HandKinematics | null = null;

    const count = result.landmarks?.length ?? 0;
    for (let i = 0; i < count; i++) {
      const landmarks = result.landmarks[i];
      const worldLandmarks = result.worldLandmarks?.[i] ?? [];
      const cat = result.handedness?.[i]?.[0];
      const rawSide = (cat?.categoryName || '').toLowerCase();
      let side: HandSide = rawSide === 'left' ? 'left' : 'right';
      if (this.options.swapHandedness) {
        side = side === 'left' ? 'right' : 'left';
      }

      // Evitar colisión si MediaPipe etiqueta 2 manos iguales momentáneamente
      if (side === 'left' && left) side = 'right';
      else if (side === 'right' && right) side = 'left';

      const score = cat?.score ?? 0.9;
      const processed = this.kinematics.processHand(side, score, landmarks, worldLandmarks, timestamp);
      hands.push(processed);
      if (side === 'left') left = processed;
      else right = processed;
    }

    return {
      timestamp,
      source,
      hands,
      left,
      right,
    };
  }

  dispose(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

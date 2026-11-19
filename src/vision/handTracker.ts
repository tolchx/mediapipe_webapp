import {
  FilesetResolver,
  GestureRecognizer,
  HandLandmarker,
  PoseLandmarker,
  type GestureRecognizerResult,
  type HandLandmarkerResult,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type {
  FingerKey,
  HandKinematics,
  HandSide,
  PhalanxKey,
  PoseKinematics,
  RawRecognizedGesture,
  SimulatorControls,
  TrackingFrame,
  TrackingPipelineMode,
  TrackingSourceMode,
  Vec3,
} from '../types/hand';
import { HandKinematicsProcessor } from './handKinematics';
import { PoseKinematicsProcessor, buildVirtualPose } from './poseKinematics';

function resolvePublicAssetUrl(relativePath: string): string {
  const baseUrl = new URL(import.meta.env.BASE_URL || './', window.location.href);
  return new URL(relativePath.replace(/^\/+/, ''), baseUrl).href;
}

export interface TrackerInitStatus {
  ready: boolean;
  delegate: 'GPU' | 'CPU' | null;
  handsReady: boolean;
  gesturesReady: boolean;
  poseReady: boolean;
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
  private gestureRecognizer: GestureRecognizer | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private poseLandmarker: PoseLandmarker | null = null;
  private kinematics = new HandKinematicsProcessor();
  private poseKinematics = new PoseKinematicsProcessor();
  private lastVideoTimeMs = -1;
  private pipelineMode: TrackingPipelineMode = 'both';
  private initStatus: TrackerInitStatus = {
    ready: false,
    delegate: null,
    handsReady: false,
    gesturesReady: false,
    poseReady: false,
    error: null,
  };
  private options: TrackerOptions = {
    numHands: 2,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
    swapHandedness: false,
  };

  async init(onStatus?: (status: TrackerInitStatus) => void): Promise<TrackerInitStatus> {
    if (this.initStatus.ready) return this.initStatus;

    try {
      const vision = await FilesetResolver.forVisionTasks(resolvePublicAssetUrl('mediapipe/wasm'));
      let chosenDelegate: 'GPU' | 'CPU' | null = null;

      // 1. Inicializar GestureRecognizer (incluye 21 landmarks de manos + gestos nativos)
      const gestureModelPath = resolvePublicAssetUrl('models/gesture_recognizer.task');
      for (const delegate of ['GPU', 'CPU'] as const) {
        try {
          this.gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: gestureModelPath,
              delegate,
            },
            runningMode: 'VIDEO',
            numHands: this.options.numHands,
            minHandDetectionConfidence: this.options.minDetectionConfidence,
            minHandPresenceConfidence: this.options.minDetectionConfidence,
            minTrackingConfidence: this.options.minTrackingConfidence,
          });
          chosenDelegate = delegate;
          this.initStatus.handsReady = true;
          this.initStatus.gesturesReady = true;
          break;
        } catch {
          this.gestureRecognizer = null;
        }
      }

      // Fallback a HandLandmarker si gesture_recognizer.task no estuviera disponible
      if (!this.gestureRecognizer) {
        const handModelPath = resolvePublicAssetUrl('models/hand_landmarker.task');
        for (const delegate of ['GPU', 'CPU'] as const) {
          try {
            this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
              baseOptions: {
                modelAssetPath: handModelPath,
                delegate,
              },
              runningMode: 'VIDEO',
              numHands: this.options.numHands,
              minHandDetectionConfidence: this.options.minDetectionConfidence,
              minHandPresenceConfidence: this.options.minDetectionConfidence,
              minTrackingConfidence: this.options.minTrackingConfidence,
            });
            chosenDelegate = chosenDelegate ?? delegate;
            this.initStatus.handsReady = true;
            break;
          } catch {
            this.handLandmarker = null;
          }
        }
      }

      // 2. Inicializar PoseLandmarker (33 puntos cuerpo completo)
      const poseModelPath = resolvePublicAssetUrl('models/pose_landmarker_lite.task');
      for (const delegate of ['GPU', 'CPU'] as const) {
        try {
          this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath: poseModelPath,
              delegate,
            },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          chosenDelegate = chosenDelegate ?? delegate;
          this.initStatus.poseReady = true;
          break;
        } catch {
          this.poseLandmarker = null;
        }
      }

      this.initStatus.delegate = chosenDelegate;
      this.initStatus.ready = this.initStatus.handsReady || this.initStatus.poseReady;
      if (!this.initStatus.ready) {
        this.initStatus.error = 'No se pudo inicializar GestureRecognizer/HandLandmarker ni PoseLandmarker';
      }
      onStatus?.({ ...this.initStatus });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.initStatus = {
        ready: false,
        delegate: null,
        handsReady: false,
        gesturesReady: false,
        poseReady: false,
        error: message,
      };
      onStatus?.({ ...this.initStatus });
    }
    return { ...this.initStatus };
  }

  getStatus(): TrackerInitStatus {
    return { ...this.initStatus };
  }

  setPipelineMode(mode: TrackingPipelineMode): void {
    this.pipelineMode = mode;
    this.resetKinematics();
  }

  getPipelineMode(): TrackingPipelineMode {
    return this.pipelineMode;
  }

  setSmoothing(alpha: number): void {
    this.kinematics.setSmoothing(alpha);
    this.poseKinematics.setSmoothing(alpha);
  }

  setSwapHandedness(swap: boolean): void {
    this.options.swapHandedness = swap;
  }

  async setNumHands(numHands: 1 | 2): Promise<void> {
    this.options.numHands = numHands;
    if (this.gestureRecognizer) {
      await this.gestureRecognizer.setOptions({ numHands });
    }
    if (this.handLandmarker) {
      await this.handLandmarker.setOptions({ numHands });
    }
  }

  resetKinematics(): void {
    this.kinematics.reset();
    this.poseKinematics.reset();
  }

  detectVideoFrame(video: HTMLVideoElement, nowMs: number): TrackingFrame {
    const empty: TrackingFrame = {
      timestamp: nowMs,
      source: 'camera',
      hands: [],
      left: null,
      right: null,
      poses: [],
      rawGestures: [],
    };

    if (!this.initStatus.ready || video.readyState < 2 || video.videoWidth === 0) {
      return empty;
    }

    const safeTimestamp = Math.max(nowMs, this.lastVideoTimeMs + 1);
    this.lastVideoTimeMs = safeTimestamp;

    const runHands = this.pipelineMode !== 'pose';
    const runPose = this.pipelineMode !== 'hands';

    let gestureResult: GestureRecognizerResult | null = null;
    let handResult: HandLandmarkerResult | null = null;
    let poseResult: PoseLandmarkerResult | null = null;

    if (runHands) {
      if (this.gestureRecognizer) {
        gestureResult = this.gestureRecognizer.recognizeForVideo(video, safeTimestamp);
      } else if (this.handLandmarker) {
        handResult = this.handLandmarker.detectForVideo(video, safeTimestamp);
      }
    }

    if (runPose && this.poseLandmarker) {
      poseResult = this.poseLandmarker.detectForVideo(video, safeTimestamp);
    }

    return this.buildFrameFromResults(
      gestureResult ?? handResult,
      gestureResult,
      poseResult,
      safeTimestamp,
      'camera'
    );
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

    let left: HandKinematics | null = null;
    let right: HandKinematics | null = null;

    if (this.pipelineMode !== 'pose') {
      right = buildSimulatedSide('right');
      hands.push(right);

      if (controls.handsCount === 2) {
        left = buildSimulatedSide('left');
        hands.unshift(left);
      }
    }

    const poses: PoseKinematics[] = [];
    if (this.pipelineMode !== 'hands') {
      const { landmarks, worldLandmarks } = buildVirtualPose(nowMs, hands);
      poses.push(this.poseKinematics.processPose(0, landmarks, worldLandmarks, nowMs));
    }

    return {
      timestamp: nowMs,
      source: 'simulator',
      hands,
      left,
      right,
      poses,
      rawGestures: [],
    };
  }

  private buildFrameFromResults(
    handResult: HandLandmarkerResult | GestureRecognizerResult | null,
    gestureResult: GestureRecognizerResult | null,
    poseResult: PoseLandmarkerResult | null,
    timestamp: number,
    source: TrackingSourceMode
  ): TrackingFrame {
    const hands: HandKinematics[] = [];
    const rawGestures: RawRecognizedGesture[] = [];
    let left: HandKinematics | null = null;
    let right: HandKinematics | null = null;

    const count = handResult?.landmarks?.length ?? 0;
    for (let i = 0; i < count; i++) {
      const landmarks = handResult!.landmarks[i];
      const worldLandmarks = handResult!.worldLandmarks?.[i] ?? [];
      const cat = handResult!.handedness?.[i]?.[0];
      const rawSide = (cat?.categoryName || '').toLowerCase();
      let side: HandSide = rawSide === 'left' ? 'left' : 'right';
      if (this.options.swapHandedness) {
        side = side === 'left' ? 'right' : 'left';
      }

      if (side === 'left' && left) side = 'right';
      else if (side === 'right' && right) side = 'left';

      const score = cat?.score ?? 0.9;
      const processed = this.kinematics.processHand(side, score, landmarks, worldLandmarks, timestamp);
      hands.push(processed);
      if (side === 'left') left = processed;
      else right = processed;

      const topGesture = gestureResult?.gestures?.[i]?.[0];
      if (topGesture && topGesture.categoryName && topGesture.categoryName !== 'None') {
        rawGestures.push({
          side,
          categoryName: topGesture.categoryName,
          score: topGesture.score ?? 0,
        });
      }
    }

    const poses: PoseKinematics[] = [];
    const poseCount = poseResult?.landmarks?.length ?? 0;
    for (let i = 0; i < poseCount; i++) {
      const pLm = poseResult!.landmarks[i];
      const pWorld = poseResult!.worldLandmarks?.[i] ?? [];
      if (pLm && pLm.length === 33) {
        poses.push(this.poseKinematics.processPose(i, pLm, pWorld, timestamp));
      }
    }

    return {
      timestamp,
      source,
      hands,
      left,
      right,
      poses,
      rawGestures,
    };
  }

  dispose(): void {
    this.gestureRecognizer?.close();
    this.gestureRecognizer = null;
    this.handLandmarker?.close();
    this.handLandmarker = null;
    this.poseLandmarker?.close();
    this.poseLandmarker = null;
  }
}

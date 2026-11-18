export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type HandSide = 'left' | 'right';

export type FingerKey = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

export type PhalanxKey = 'proximal' | 'intermediate' | 'distal';

export type PinchTarget = 'index' | 'middle' | 'ring' | 'pinky';

export interface PhalanxState {
  key: PhalanxKey;
  label: string;
  joint: string;
  indices: [number, number, number];
  boneIndices: [number, number];
  angleDeg: number;
  flex: number; // 0 = recta / extendida, 1 = flexionada
  extended: number; // 1 - flex
  lengthWorld: number;
}

export interface FingerState {
  key: FingerKey;
  label: string;
  tipIndex: number;
  curl: number; // 0..1
  extended: number; // 0..1
  phalanges: Record<PhalanxKey, PhalanxState>;
  tipPosition: Vec3;
}

export interface PinchState {
  target: PinchTarget;
  label: string;
  distanceNorm: number;
  closeness: number; // 0..1 (1 = contacto)
  active: boolean;
}

export interface PalmOrientation {
  pitch: number; // grados (-90..90)
  yaw: number; // grados (-90..90)
  roll: number; // grados (-180..180)
}

export interface FingerSpread {
  thumbIndex: number;
  indexMiddle: number;
  middleRing: number;
  ringPinky: number;
}

export interface HandKinematics {
  side: HandSide;
  score: number;
  landmarks: Vec3[]; // 21 puntos normalizados [0..1]
  worldLandmarks: Vec3[]; // 21 puntos 3D en metros
  palmCenter: Vec3;
  palmOpenness: number; // 0..1
  palmOrientation: PalmOrientation;
  palmVelocity: number;
  spread: FingerSpread;
  fingers: Record<FingerKey, FingerState>;
  pinches: Record<PinchTarget, PinchState>;
}

export type TrackingSourceMode = 'camera' | 'simulator';

export interface TrackingFrame {
  timestamp: number;
  source: TrackingSourceMode;
  hands: HandKinematics[];
  left: HandKinematics | null;
  right: HandKinematics | null;
}

export type SynthMappingMode = 'theremin' | 'pinch-pitch' | 'dual-hand';

export type ScaleType =
  | 'free'
  | 'pentatonic_minor'
  | 'major'
  | 'minor'
  | 'dorian'
  | 'chromatic';

export type WaveformType = 'sine' | 'triangle' | 'sawtooth' | 'square';

export interface SynthConfig {
  enabled: boolean;
  mappingMode: SynthMappingMode;
  minFreqHz: number;
  maxFreqHz: number;
  scale: ScaleType;
  rootNote: number; // 0 = C .. 11 = B
  waveform: WaveformType;
  glideMs: number;
  masterVolume: number; // 0..1
  pinchGate: boolean;
  baseResonance: number; // 0.5..14
}

export interface SynthTelemetry {
  active: boolean;
  handDetected: boolean;
  primarySide: HandSide | null;
  rawFreqHz: number;
  quantizedFreqHz: number;
  midiNote: number;
  noteName: string;
  centsOff: number;
  cutoffHz: number;
  resonanceQ: number;
  fmDepthHz: number;
  lfoRateHz: number;
  lfoDepthHz: number;
  subMix: number;
  gain: number;
  pitchBendCents: number;
  driverValues: {
    pitchDriverLabel: string;
    pitchDriverNorm: number;
    cutoffDriverLabel: string;
    cutoffDriverNorm: number;
    fmDriverLabel: string;
    fmDriverNorm: number;
    lfoDriverLabel: string;
    lfoDriverNorm: number;
    subDriverLabel: string;
    subDriverNorm: number;
  };
}

export interface OscChannelGroups {
  palm: boolean;
  fingers: boolean;
  phalanges: boolean;
  landmarks: boolean;
  synth: boolean;
  triggers: boolean;
  triggerSubchannels: boolean;
}

export type TriggerShape = 'rect' | 'circle';

export type TriggerMode = 'momentary' | 'pulse' | 'toggle';

export type TriggerTarget =
  | 'any_hand'
  | 'palm'
  | 'any_tip'
  | 'index_tip'
  | 'thumb_tip'
  | 'middle_tip'
  | 'ring_tip'
  | 'pinky_tip'
  | 'pinch';

export type TriggerHandFilter = 'any' | 'left' | 'right';

export interface TriggerZone {
  id: string;
  name: string;
  enabled: boolean;
  shape: TriggerShape;
  x: number; // 0..1 centro X en viewport visual
  y: number; // 0..1 centro Y en viewport visual
  width: number; // 0.04..0.90 ancho normalizado (diámetro en círculo)
  height: number; // 0.04..0.90 alto normalizado (ignorado/igualado en círculo)
  mode: TriggerMode;
  pulseDurationMs: number;
  cooldownMs: number;
  target: TriggerTarget;
  handFilter: TriggerHandFilter;
  oscAddress: string;
  color: string;
}

export interface TriggerEvaluation {
  zone: TriggerZone;
  inside: boolean;
  active: boolean;
  value: 0 | 1;
  justTriggered: boolean;
  hitCount: number;
  hitHand: HandSide | null;
  localX: number; // 0..1 dentro del área
  localY: number; // 0..1 dentro del área
  hitPoints: Array<{ x: number; y: number }>; // puntos visuales en viewport [0..1]
}

export type OscSendMode = 'bundle' | 'individual';

export interface OscConfig {
  enabled: boolean;
  host: string;
  port: number;
  sendMode: OscSendMode;
  rateHz: number; // 0 = sin límite (cada frame)
  channels: OscChannelGroups;
}

export interface OscMessageItem {
  address: string;
  args: Array<{ type: 'f' | 'i' | 's'; value: number | string }>;
}

export interface OscStats {
  bridgeMode: 'connecting' | 'connected' | 'standalone' | 'disconnected';
  wsConnected: boolean;
  udpReady: boolean;
  targetHost: string;
  targetPort: number;
  sendMode: OscSendMode;
  packetsSent: number;
  messagesSent: number;
  bytesSent: number;
  packetsPerSec: number;
  messagesPerSec: number;
  lastError: string | null;
}

export interface SimulatorControls {
  preset: 'theremin_wave' | 'pinch_sweep' | 'manual';
  handsCount: 1 | 2;
  palmY: number; // 0..1 (0 = arriba, 1 = abajo)
  palmX: number; // 0..1
  pinchAperture: number; // 0..1 (0 = cerrado, 1 = abierto)
  fingersCurl: Record<FingerKey, number>;
  phalanxBias: Record<PhalanxKey, number>;
}

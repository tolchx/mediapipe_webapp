import type { FingerKey, HandKinematics, HandSide, TrackingFrame } from '../types/hand';

export type BlobEmitterMode =
  | 'palms'
  | 'fingertips'
  | 'palms_and_index'
  | 'index_only'
  | 'pinch';

export type BlobColorMode = 'rainbow' | 'by_hand' | 'by_velocity';

export interface BlobSystemConfig {
  enabled: boolean;
  emitterMode: BlobEmitterMode;
  colorMode: BlobColorMode;
  forceMultiplier: number; // 0.2 .. 4.0
  radiusScale: number; // 0.3 .. 2.5
  minSpeedThreshold: number; // 0 .. 0.02 (normalized coords/frame)
  emitWhenIdle: boolean;
  pinchBoost: boolean;
}

export interface FluidRgbColor {
  r: number;
  g: number;
  b: number;
}

export interface HandBlob {
  id: string;
  label: string;
  side: HandSide;
  source: 'palm' | 'thumb_tip' | 'index_tip' | 'middle_tip' | 'ring_tip' | 'pinky_tip' | 'pinch';
  /** Normalized X in [0..1], 0 = left, 1 = right (already mirror-adjusted) */
  x: number;
  /** Normalized Y in [0..1], 0 = top, 1 = bottom */
  y: number;
  /** Velocity delta in normalized space (positive X = right, positive Y = down) */
  dx: number;
  dy: number;
  speed: number;
  /** Relative radius multiplier around config.SPLAT_RADIUS */
  radiusScale: number;
  /** Force multiplier for this blob */
  force: number;
  /** Linear-ish HDR dye color for PavelDoGreat fluid shader (~0..0.25 range) */
  color: FluidRgbColor;
  active: boolean;
}

interface PrevBlobSample {
  x: number;
  y: number;
  hue: number;
  timestamp: number;
}

const FINGER_ORDER: FingerKey[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const FINGER_LABELS: Record<FingerKey, string> = {
  thumb: 'Pulgar',
  index: 'Índice',
  middle: 'Medio',
  ring: 'Anular',
  pinky: 'Meñique',
};

function hsvToFluidRgb(h: number, s: number, v: number, intensity = 0.16): FluidRgbColor {
  const hue = ((h % 1) + 1) % 1;
  const i = Math.floor(hue * 6);
  const f = hue * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0:
      r = v; g = t; b = p;
      break;
    case 1:
      r = q; g = v; b = p;
      break;
    case 2:
      r = p; g = v; b = t;
      break;
    case 3:
      r = p; g = q; b = v;
      break;
    case 4:
      r = t; g = p; b = v;
      break;
    case 5:
      r = v; g = p; b = q;
      break;
  }

  return {
    r: r * intensity,
    g: g * intensity,
    b: b * intensity,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export const DEFAULT_BLOB_SYSTEM_CONFIG: BlobSystemConfig = {
  enabled: true,
  emitterMode: 'palms_and_index',
  colorMode: 'by_hand',
  forceMultiplier: 1.35,
  radiusScale: 1.0,
  minSpeedThreshold: 0.0018,
  emitWhenIdle: false,
  pinchBoost: true,
};

/**
 * Convierte los landmarks de manos detectados por MediaPipe en "Blobs" dinámicos
 * (posición normalizada, velocidad dx/dy, radio, fuerza y color) listos para
 * inyectarse en el shader de fluidos WebGL.
 */
export class HandBlobSystem {
  private config: BlobSystemConfig;
  private prevSamples = new Map<string, PrevBlobSample>();
  private lastBlobs: HandBlob[] = [];

  constructor(initialConfig?: Partial<BlobSystemConfig>) {
    this.config = { ...DEFAULT_BLOB_SYSTEM_CONFIG, ...initialConfig };
  }

  public getConfig(): BlobSystemConfig {
    return { ...this.config };
  }

  public updateConfig(partial: Partial<BlobSystemConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  public reset(): void {
    this.prevSamples.clear();
    this.lastBlobs = [];
  }

  public getLastBlobs(): HandBlob[] {
    return this.lastBlobs;
  }

  public processFrame(frame: TrackingFrame, mirrored: boolean): HandBlob[] {
    if (!this.config.enabled || frame.hands.length === 0) {
      this.prevSamples.clear();
      this.lastBlobs = [];
      return [];
    }

    const activeIds = new Set<string>();
    const blobs: HandBlob[] = [];

    for (const hand of frame.hands) {
      const emitters = this.collectHandEmitters(hand);
      for (const emitter of emitters) {
        const id = `${hand.side}-${emitter.source}`;
        activeIds.add(id);

        const rawX = mirrored ? 1 - emitter.x : emitter.x;
        const rawY = emitter.y;
        const x = clamp(rawX, 0.001, 0.999);
        const y = clamp(rawY, 0.001, 0.999);

        const prev = this.prevSamples.get(id);
        const dtMs = prev ? Math.max(1, frame.timestamp - prev.timestamp) : 16.67;
        // Normalizamos el delta a ~60Hz para que la velocidad sea estable
        const dtScale = clamp(16.67 / dtMs, 0.25, 2.5);

        const dx = prev ? (x - prev.x) * dtScale : 0;
        const dy = prev ? (y - prev.y) * dtScale : 0;
        const speed = Math.hypot(dx, dy);

        const baseHue = prev
          ? (prev.hue + 0.0025 + speed * 0.65) % 1
          : hand.side === 'right'
            ? 0.52
            : 0.92;

        this.prevSamples.set(id, {
          x,
          y,
          hue: baseHue,
          timestamp: frame.timestamp,
        });

        const pinchActive = hand.pinches.index.active;
        const pinchCloseness = hand.pinches.index.closeness;

        let active = speed >= this.config.minSpeedThreshold || this.config.emitWhenIdle;
        if (this.config.emitterMode === 'pinch') {
          active = pinchActive || (pinchCloseness > 0.72 && speed >= this.config.minSpeedThreshold * 0.5);
        }

        const boost = this.config.pinchBoost && pinchActive ? 1.55 : 1.0;
        const radiusScale =
          this.config.radiusScale *
          emitter.radiusFactor *
          (0.8 + hand.palmOpenness * 0.45) *
          (pinchActive ? 0.78 : 1.0);

        const force = this.config.forceMultiplier * boost * emitter.forceFactor;
        const color = this.resolveColor(hand.side, speed, baseHue, pinchActive);

        blobs.push({
          id,
          label: `${hand.side === 'right' ? 'Der' : 'Izq'} · ${emitter.label}`,
          side: hand.side,
          source: emitter.source,
          x,
          y,
          dx,
          dy,
          speed,
          radiusScale,
          force,
          color,
          active,
        });
      }
    }

    // Limpiar muestras de blobs que ya no están presentes
    for (const key of this.prevSamples.keys()) {
      if (!activeIds.has(key)) {
        this.prevSamples.delete(key);
      }
    }

    this.lastBlobs = blobs;
    return blobs;
  }

  private collectHandEmitters(hand: HandKinematics): Array<{
    source: HandBlob['source'];
    label: string;
    x: number;
    y: number;
    radiusFactor: number;
    forceFactor: number;
  }> {
    const mode = this.config.emitterMode;

    if (mode === 'palms') {
      return [
        {
          source: 'palm',
          label: 'Palma',
          x: hand.palmCenter.x,
          y: hand.palmCenter.y,
          radiusFactor: 1.35,
          forceFactor: 1.15,
        },
      ];
    }

    if (mode === 'index_only') {
      const idx = hand.fingers.index.tipPosition;
      return [
        {
          source: 'index_tip',
          label: 'Índice',
          x: idx.x,
          y: idx.y,
          radiusFactor: 0.85,
          forceFactor: 1.0,
        },
      ];
    }

    if (mode === 'pinch') {
      const thumb = hand.fingers.thumb.tipPosition;
      const index = hand.fingers.index.tipPosition;
      return [
        {
          source: 'pinch',
          label: 'Pinch',
          x: (thumb.x + index.x) * 0.5,
          y: (thumb.y + index.y) * 0.5,
          radiusFactor: 0.95,
          forceFactor: 1.45,
        },
      ];
    }

    if (mode === 'palms_and_index') {
      const idx = hand.fingers.index.tipPosition;
      return [
        {
          source: 'palm',
          label: 'Palma',
          x: hand.palmCenter.x,
          y: hand.palmCenter.y,
          radiusFactor: 1.25,
          forceFactor: 1.1,
        },
        {
          source: 'index_tip',
          label: 'Índice',
          x: idx.x,
          y: idx.y,
          radiusFactor: 0.72,
          forceFactor: 0.95,
        },
      ];
    }

    // 'fingertips'
    return FINGER_ORDER.map((fingerKey) => {
      const tip = hand.fingers[fingerKey].tipPosition;
      return {
        source: `${fingerKey}_tip` as HandBlob['source'],
        label: FINGER_LABELS[fingerKey],
        x: tip.x,
        y: tip.y,
        radiusFactor: 0.65,
        forceFactor: 0.85,
      };
    });
  }

  private resolveColor(
    side: HandSide,
    speed: number,
    rollingHue: number,
    pinchActive: boolean
  ): FluidRgbColor {
    if (this.config.colorMode === 'rainbow') {
      return hsvToFluidRgb(rollingHue, 0.95, 1.0, pinchActive ? 0.22 : 0.16);
    }

    if (this.config.colorMode === 'by_velocity') {
      // Lento = azul/cian profundo; rápido = naranja/magenta intenso
      const normSpeed = clamp(speed / 0.035, 0, 1);
      const hue = 0.62 - normSpeed * 0.56;
      return hsvToFluidRgb(hue, 0.95, 1.0, 0.12 + normSpeed * 0.14);
    }

    // 'by_hand': Derecha = Cian (#22d3ee), Izquierda = Rosa/Coral (#fb7185)
    if (side === 'right') {
      return pinchActive
        ? { r: 0.05, g: 0.22, b: 0.24 }
        : { r: 0.025, g: 0.16, b: 0.2 };
    }
    return pinchActive
      ? { r: 0.24, g: 0.06, b: 0.12 }
      : { r: 0.2, g: 0.04, b: 0.09 };
  }
}

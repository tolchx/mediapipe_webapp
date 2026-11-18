import type {
  HandKinematics,
  HandSide,
  TrackingFrame,
  TriggerEvaluation,
  TriggerTarget,
  TriggerZone,
  Vec3,
} from '../types/hand';

export interface ViewportBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ZonePixelGeometry {
  cx: number;
  cy: number;
  left: number;
  top: number;
  w: number;
  h: number;
  radius: number;
}

const STORAGE_KEY = 'hand_osc_trigger_zones_v1';

export const TRIGGER_COLORS = [
  '#22d3ee', // cyan
  '#fb923c', // coral/amber
  '#34d399', // emerald
  '#a78bfa', // violet
  '#f43f5e', // rose
  '#fbbf24', // yellow
];

export const TRIGGER_TARGET_LABELS: Record<TriggerTarget, string> = {
  any_hand: 'Cualquier punto de la mano',
  palm: 'Centro de palma',
  any_tip: 'Cualquier punta de dedo',
  index_tip: 'Punta del Índice (8)',
  thumb_tip: 'Punta del Pulgar (4)',
  middle_tip: 'Punta del Medio (12)',
  ring_tip: 'Punta del Anular (16)',
  pinky_tip: 'Punta del Meñique (20)',
  pinch: 'Pinch Pulgar-Índice activo',
};

export function computeContainBox(canvasW: number, canvasH: number, aspect: number): ViewportBox {
  const safeAspect = aspect > 0.1 ? aspect : 16 / 9;
  const canvasAspect = canvasW / Math.max(canvasH, 1);
  if (canvasAspect > safeAspect) {
    const h = canvasH;
    const w = h * safeAspect;
    return { x: (canvasW - w) / 2, y: 0, w, h };
  }
  const w = canvasW;
  const h = w / safeAspect;
  return { x: 0, y: (canvasH - h) / 2, w, h };
}

export function getZonePixelGeometry(zone: TriggerZone, box: ViewportBox): ZonePixelGeometry {
  const cx = box.x + zone.x * box.w;
  const cy = box.y + zone.y * box.h;
  if (zone.shape === 'circle') {
    const minDim = Math.min(box.w, box.h);
    const d = Math.max(24, zone.width * minDim);
    const r = d * 0.5;
    return {
      cx,
      cy,
      left: cx - r,
      top: cy - r,
      w: d,
      h: d,
      radius: r,
    };
  }
  const w = Math.max(24, zone.width * box.w);
  const h = Math.max(24, zone.height * box.h);
  return {
    cx,
    cy,
    left: cx - w * 0.5,
    top: cy - h * 0.5,
    w,
    h,
    radius: Math.min(w, h) * 0.5,
  };
}

export function hitTestZoneNormalized(
  zone: TriggerZone,
  vx: number,
  vy: number,
  aspect: number
): { inside: boolean; localX: number; localY: number } {
  if (zone.shape === 'circle') {
    const safeAspect = aspect > 0.1 ? aspect : 16 / 9;
    // Radio en unidades normalizadas de min(w, h)
    const rx = safeAspect >= 1 ? (zone.width * 0.5) / safeAspect : zone.width * 0.5;
    const ry = safeAspect >= 1 ? zone.width * 0.5 : (zone.width * 0.5) * safeAspect;
    const dx = (vx - zone.x) / Math.max(rx, 1e-4);
    const dy = (vy - zone.y) / Math.max(ry, 1e-4);
    const inside = dx * dx + dy * dy <= 1;
    return {
      inside,
      localX: Math.max(0, Math.min(1, 0.5 + dx * 0.5)),
      localY: Math.max(0, Math.min(1, 0.5 + dy * 0.5)),
    };
  }

  const halfW = zone.width * 0.5;
  const halfH = zone.height * 0.5;
  const minX = zone.x - halfW;
  const maxX = zone.x + halfW;
  const minY = zone.y - halfH;
  const maxY = zone.y + halfH;
  const inside = vx >= minX && vx <= maxX && vy >= minY && vy <= maxY;
  return {
    inside,
    localX: Math.max(0, Math.min(1, (vx - minX) / Math.max(zone.width, 1e-4))),
    localY: Math.max(0, Math.min(1, (vy - minY) / Math.max(zone.height, 1e-4))),
  };
}

export function createZone(index: number, overrides: Partial<TriggerZone> = {}): TriggerZone {
  const num = index + 1;
  const color = TRIGGER_COLORS[index % TRIGGER_COLORS.length];
  return {
    id: `pad_${Date.now().toString(36)}_${num}_${Math.floor(Math.random() * 1000)}`,
    name: `Pulsador ${num}`,
    enabled: true,
    shape: 'rect',
    x: 0.25 + (index % 3) * 0.25,
    y: 0.3 + Math.floor(index / 3) * 0.32,
    width: 0.18,
    height: 0.24,
    mode: 'pulse',
    pulseDurationMs: 140,
    cooldownMs: 220,
    target: 'index_tip',
    handFilter: 'any',
    oscAddress: `/td/pad/${num}`,
    color,
    ...overrides,
  };
}

export function getPresetZones(preset: 'default_2' | 'grid_4' | 'columns_3'): TriggerZone[] {
  if (preset === 'grid_4') {
    return [
      createZone(0, { id: 'pad_1', name: 'Pad 1 (Pulso)', x: 0.2, y: 0.28, width: 0.2, height: 0.26, mode: 'pulse', target: 'any_hand', oscAddress: '/td/pad/1' }),
      createZone(1, { id: 'pad_2', name: 'Pad 2 (Pulso)', x: 0.8, y: 0.28, width: 0.2, height: 0.26, mode: 'pulse', target: 'any_hand', oscAddress: '/td/pad/2' }),
      createZone(2, { id: 'pad_3', name: 'Pad 3 (Mantener)', x: 0.2, y: 0.72, width: 0.2, height: 0.26, mode: 'momentary', target: 'any_hand', oscAddress: '/td/pad/3' }),
      createZone(3, { id: 'pad_4', name: 'Pad 4 (Toggle)', x: 0.8, y: 0.72, width: 0.2, height: 0.26, mode: 'toggle', target: 'any_hand', oscAddress: '/td/pad/4' }),
    ];
  }
  if (preset === 'columns_3') {
    return [
      createZone(0, { id: 'pad_1', name: 'Zona Izq', x: 0.18, y: 0.5, width: 0.22, height: 0.72, mode: 'momentary', target: 'palm', oscAddress: '/td/zone/left' }),
      createZone(1, { id: 'pad_2', name: 'Zona Centro', x: 0.5, y: 0.5, width: 0.22, height: 0.72, mode: 'momentary', target: 'palm', oscAddress: '/td/zone/center' }),
      createZone(2, { id: 'pad_3', name: 'Zona Der', x: 0.82, y: 0.5, width: 0.22, height: 0.72, mode: 'momentary', target: 'palm', oscAddress: '/td/zone/right' }),
    ];
  }
  // default_2
  return [
    createZone(0, {
      id: 'pad_1',
      name: 'Pulsador 1 (Pulso)',
      x: 0.18,
      y: 0.28,
      width: 0.18,
      height: 0.25,
      mode: 'pulse',
      target: 'any_hand',
      oscAddress: '/td/pad/1',
    }),
    createZone(1, {
      id: 'pad_2',
      name: 'Pulsador 2 (Mantener)',
      x: 0.82,
      y: 0.28,
      width: 0.18,
      height: 0.25,
      mode: 'momentary',
      target: 'index_tip',
      oscAddress: '/td/pad/2',
    }),
  ];
}

interface ZoneRuntimeState {
  wasInside: boolean;
  pulseUntil: number;
  toggled: boolean;
  hitCount: number;
  lastTriggeredAt: number;
}

function getCandidatePoints(hand: HandKinematics, target: TriggerTarget): Vec3[] {
  switch (target) {
    case 'palm':
      return [hand.palmCenter];
    case 'thumb_tip':
      return [hand.landmarks[4]];
    case 'index_tip':
      return [hand.landmarks[8]];
    case 'middle_tip':
      return [hand.landmarks[12]];
    case 'ring_tip':
      return [hand.landmarks[16]];
    case 'pinky_tip':
      return [hand.landmarks[20]];
    case 'any_tip':
      return [
        hand.landmarks[4],
        hand.landmarks[8],
        hand.landmarks[12],
        hand.landmarks[16],
        hand.landmarks[20],
      ];
    case 'pinch':
      if (!hand.pinches.index.active) return [];
      return [
        {
          x: (hand.landmarks[4].x + hand.landmarks[8].x) * 0.5,
          y: (hand.landmarks[4].y + hand.landmarks[8].y) * 0.5,
          z: (hand.landmarks[4].z + hand.landmarks[8].z) * 0.5,
        },
      ];
    case 'any_hand':
    default:
      return [hand.palmCenter, ...hand.landmarks];
  }
}

export class TriggerZoneEngine {
  private zones: TriggerZone[] = [];
  private states = new Map<string, ZoneRuntimeState>();

  constructor() {
    this.zones = this.loadFromStorage();
  }

  private loadFromStorage(): TriggerZone[] {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // ignore storage errors
    }
    return getPresetZones('default_2');
  }

  private saveToStorage(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.zones));
    } catch {
      // ignore storage errors
    }
  }

  getZones(): TriggerZone[] {
    return this.zones;
  }

  getZone(id: string): TriggerZone | undefined {
    return this.zones.find((z) => z.id === id);
  }

  addZone(overrides: Partial<TriggerZone> = {}): TriggerZone {
    const zone = createZone(this.zones.length, overrides);
    this.zones.push(zone);
    this.saveToStorage();
    return zone;
  }

  updateZone(id: string, partial: Partial<TriggerZone>): TriggerZone | undefined {
    const idx = this.zones.findIndex((z) => z.id === id);
    if (idx === -1) return undefined;
    const prev = this.zones[idx];
    const next: TriggerZone = {
      ...prev,
      ...partial,
      x: Math.max(0.03, Math.min(0.97, partial.x ?? prev.x)),
      y: Math.max(0.03, Math.min(0.97, partial.y ?? prev.y)),
      width: Math.max(0.05, Math.min(0.92, partial.width ?? prev.width)),
      height: Math.max(0.05, Math.min(0.92, partial.height ?? prev.height)),
      pulseDurationMs: Math.max(40, Math.min(2000, partial.pulseDurationMs ?? prev.pulseDurationMs)),
      cooldownMs: Math.max(0, Math.min(2000, partial.cooldownMs ?? prev.cooldownMs)),
    };
    if (next.oscAddress && !next.oscAddress.startsWith('/')) {
      next.oscAddress = `/${next.oscAddress}`;
    }
    this.zones[idx] = next;
    if (partial.mode && partial.mode !== prev.mode) {
      const st = this.states.get(id);
      if (st) {
        st.toggled = false;
        st.pulseUntil = 0;
      }
    }
    this.saveToStorage();
    return next;
  }

  removeZone(id: string): void {
    this.zones = this.zones.filter((z) => z.id !== id);
    this.states.delete(id);
    this.saveToStorage();
  }

  applyPreset(preset: 'default_2' | 'grid_4' | 'columns_3' | 'clear'): void {
    this.states.clear();
    if (preset === 'clear') {
      this.zones = [];
    } else {
      this.zones = getPresetZones(preset);
    }
    this.saveToStorage();
  }

  manualTestTrigger(id: string, nowMs = performance.now()): void {
    const zone = this.getZone(id);
    if (!zone) return;
    const state = this.getOrCreateState(id);
    state.hitCount += 1;
    state.lastTriggeredAt = nowMs;
    if (zone.mode === 'toggle') {
      state.toggled = !state.toggled;
    } else {
      state.pulseUntil = nowMs + Math.max(zone.pulseDurationMs, 200);
    }
  }

  private getOrCreateState(id: string): ZoneRuntimeState {
    let st = this.states.get(id);
    if (!st) {
      st = {
        wasInside: false,
        pulseUntil: 0,
        toggled: false,
        hitCount: 0,
        lastTriggeredAt: -10000,
      };
      this.states.set(id, st);
    }
    return st;
  }

  evaluate(
    frame: TrackingFrame,
    mirrored: boolean,
    viewportAspect: number
  ): TriggerEvaluation[] {
    const nowMs = frame.timestamp;
    const results: TriggerEvaluation[] = [];

    for (const zone of this.zones) {
      const state = this.getOrCreateState(zone.id);

      if (!zone.enabled) {
        state.wasInside = false;
        results.push({
          zone,
          inside: false,
          active: false,
          value: 0,
          justTriggered: false,
          hitCount: state.hitCount,
          hitHand: null,
          localX: 0,
          localY: 0,
          hitPoints: [],
        });
        continue;
      }

      let inside = false;
      let hitHand: HandSide | null = null;
      let localX = 0;
      let localY = 0;
      const hitPoints: Array<{ x: number; y: number }> = [];

      for (const hand of frame.hands) {
        if (zone.handFilter !== 'any' && hand.side !== zone.handFilter) continue;
        const pts = getCandidatePoints(hand, zone.target);
        for (const p of pts) {
          const vx = mirrored ? 1 - p.x : p.x;
          const vy = p.y;
          const hit = hitTestZoneNormalized(zone, vx, vy, viewportAspect);
          if (hit.inside) {
            if (!inside) {
              inside = true;
              hitHand = hand.side;
              localX = hit.localX;
              localY = hit.localY;
            }
            hitPoints.push({ x: vx, y: vy });
          }
        }
      }

      let justTriggered = false;
      if (inside && !state.wasInside && nowMs - state.lastTriggeredAt >= zone.cooldownMs) {
        justTriggered = true;
        state.hitCount += 1;
        state.lastTriggeredAt = nowMs;
        if (zone.mode === 'pulse') {
          state.pulseUntil = nowMs + zone.pulseDurationMs;
        } else if (zone.mode === 'toggle') {
          state.toggled = !state.toggled;
        }
      }

      state.wasInside = inside;

      let active = false;
      if (zone.mode === 'momentary') {
        active = inside || nowMs < state.pulseUntil;
      } else if (zone.mode === 'pulse') {
        active = nowMs < state.pulseUntil;
      } else {
        active = state.toggled;
      }

      results.push({
        zone,
        inside,
        active,
        value: active ? 1 : 0,
        justTriggered,
        hitCount: state.hitCount,
        hitHand,
        localX: inside ? localX : 0,
        localY: inside ? localY : 0,
        hitPoints,
      });
    }

    return results;
  }
}

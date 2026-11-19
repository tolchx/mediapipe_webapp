import type {
  GestureDefinition,
  GestureDetectionFrame,
  GestureEventLogItem,
  GestureItem,
  GestureSummary,
  HandKinematics,
  HandSide,
  PoseKinematics,
  TrackingFrame,
} from '../types/hand';

const STORAGE_KEY = 'hand_osc_gesture_enabled_v1';

const NATIVE_GESTURE_CATALOG: Array<{
  categoryName: string;
  slug: string;
  label: string;
  description: string;
}> = [
  {
    categoryName: 'Open_Palm',
    slug: 'open_palm',
    label: 'Palma Abierta',
    description: 'Todos los dedos extendidos',
  },
  {
    categoryName: 'Closed_Fist',
    slug: 'closed_fist',
    label: 'Puño Cerrado',
    description: 'Todos los dedos flexionados',
  },
  {
    categoryName: 'Pointing_Up',
    slug: 'pointing_up',
    label: 'Índice Arriba',
    description: 'Solo el dedo índice extendido',
  },
  {
    categoryName: 'Victory',
    slug: 'victory',
    label: 'Victoria / Paz',
    description: 'Índice y medio extendidos',
  },
  {
    categoryName: 'Thumb_Up',
    slug: 'thumb_up',
    label: 'Pulgar Arriba',
    description: 'Pulgar hacia arriba, puño cerrado',
  },
  {
    categoryName: 'Thumb_Down',
    slug: 'thumb_down',
    label: 'Pulgar Abajo',
    description: 'Pulgar hacia abajo, puño cerrado',
  },
  {
    categoryName: 'ILoveYou',
    slug: 'i_love_you',
    label: 'Te Amo (ILY)',
    description: 'Pulgar, índice y meñique extendidos',
  },
];

const KINEMATIC_HAND_GESTURES: Array<{
  slug: string;
  label: string;
  description: string;
}> = [
  {
    slug: 'pinch_index',
    label: 'Pinch Índice',
    description: 'Contacto entre punta del pulgar e índice',
  },
  {
    slug: 'pinch_middle',
    label: 'Pinch Medio',
    description: 'Contacto entre punta del pulgar y dedo medio',
  },
  {
    slug: 'rock_horns',
    label: 'Cuernos / Rock',
    description: 'Índice y meñique extendidos, medio y anular cerrados',
  },
];

const POSE_GESTURES: Array<{
  slug: string;
  label: string;
  description: string;
}> = [
  {
    slug: 'arms_up',
    label: 'Brazos Arriba',
    description: 'Ambas muñecas por encima de los hombros',
  },
  {
    slug: 't_pose',
    label: 'Pose en T',
    description: 'Brazos extendidos horizontalmente a la altura de los hombros',
  },
  {
    slug: 'hands_together',
    label: 'Manos Juntas',
    description: 'Ambas muñecas juntas frente al torso',
  },
  {
    slug: 'squat_crouch',
    label: 'Sentadilla / Flexión',
    description: 'Flexión pronunciada en ambas rodillas (< 130°)',
  },
];

function buildDefinitions(): GestureDefinition[] {
  const defs: GestureDefinition[] = [];
  for (const side of ['right', 'left'] as const) {
    const sideLabel = side === 'right' ? 'Der' : 'Izq';
    for (const g of NATIVE_GESTURE_CATALOG) {
      defs.push({
        id: `${side}:${g.slug}`,
        slug: g.slug,
        label: `${g.label} (${sideLabel})`,
        description: g.description,
        side,
        source: 'mediapipe',
        oscAddress: `/gestures/${side}/active/${g.slug}`,
      });
    }
    for (const g of KINEMATIC_HAND_GESTURES) {
      defs.push({
        id: `${side}:${g.slug}`,
        slug: g.slug,
        label: `${g.label} (${sideLabel})`,
        description: g.description,
        side,
        source: 'hand_kinematic',
        oscAddress: `/gestures/${side}/active/${g.slug}`,
      });
    }
  }

  for (const g of POSE_GESTURES) {
    defs.push({
      id: `body:${g.slug}`,
      slug: g.slug,
      label: `${g.label} (Cuerpo)`,
      description: g.description,
      side: 'body',
      source: 'pose',
      oscAddress: `/gestures/body/active/${g.slug}`,
    });
  }
  return defs;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function evaluateKinematicNativeFallback(
  hand: HandKinematics,
  slug: string
): { active: boolean; confidence: number } {
  const f = hand.fingers;
  switch (slug) {
    case 'open_palm': {
      const score = hand.palmOpenness;
      return { active: score > 0.72, confidence: clamp(score, 0, 1) };
    }
    case 'closed_fist': {
      const closed = 1 - hand.palmOpenness;
      return { active: closed > 0.72, confidence: clamp(closed, 0, 1) };
    }
    case 'pointing_up': {
      const score =
        (f.index.extended + f.middle.curl + f.ring.curl + f.pinky.curl) / 4;
      const cond = f.index.extended > 0.7 && f.middle.curl > 0.65 && f.ring.curl > 0.65;
      return { active: cond, confidence: cond ? score : score * 0.45 };
    }
    case 'victory': {
      const score =
        (f.index.extended + f.middle.extended + f.ring.curl + f.pinky.curl) / 4;
      const cond =
        f.index.extended > 0.7 &&
        f.middle.extended > 0.7 &&
        f.ring.curl > 0.6 &&
        f.pinky.curl > 0.6;
      return { active: cond, confidence: cond ? score : score * 0.4 };
    }
    case 'thumb_up': {
      const thumbUp = hand.landmarks[4].y < hand.landmarks[2].y - 0.04;
      const fist = (f.index.curl + f.middle.curl + f.ring.curl + f.pinky.curl) / 4;
      const active = thumbUp && f.thumb.extended > 0.6 && fist > 0.68;
      return { active, confidence: active ? clamp((f.thumb.extended + fist) * 0.5, 0, 1) : 0.1 };
    }
    case 'thumb_down': {
      const thumbDown = hand.landmarks[4].y > hand.landmarks[2].y + 0.04;
      const fist = (f.index.curl + f.middle.curl + f.ring.curl + f.pinky.curl) / 4;
      const active = thumbDown && f.thumb.extended > 0.6 && fist > 0.68;
      return { active, confidence: active ? clamp((f.thumb.extended + fist) * 0.5, 0, 1) : 0.1 };
    }
    case 'i_love_you': {
      const score =
        (f.thumb.extended + f.index.extended + f.middle.curl + f.ring.curl + f.pinky.extended) / 5;
      const active =
        f.thumb.extended > 0.6 &&
        f.index.extended > 0.68 &&
        f.middle.curl > 0.6 &&
        f.ring.curl > 0.6 &&
        f.pinky.extended > 0.65;
      return { active, confidence: active ? score : score * 0.35 };
    }
    default:
      return { active: false, confidence: 0 };
  }
}

function evaluateKinematicCustom(
  hand: HandKinematics,
  slug: string
): { active: boolean; confidence: number } {
  const f = hand.fingers;
  switch (slug) {
    case 'pinch_index':
      return { active: hand.pinches.index.active, confidence: hand.pinches.index.closeness };
    case 'pinch_middle':
      return { active: hand.pinches.middle.active, confidence: hand.pinches.middle.closeness };
    case 'rock_horns': {
      const score =
        (f.index.extended + f.middle.curl + f.ring.curl + f.pinky.extended) / 4;
      const active =
        f.index.extended > 0.68 &&
        f.pinky.extended > 0.65 &&
        f.middle.curl > 0.62 &&
        f.ring.curl > 0.62;
      return { active, confidence: active ? score : score * 0.35 };
    }
    default:
      return { active: false, confidence: 0 };
  }
}

function evaluatePoseGesture(
  pose: PoseKinematics | undefined,
  slug: string
): { active: boolean; confidence: number } {
  if (!pose) return { active: false, confidence: 0 };
  const lm = pose.landmarks;
  const lShoulder = lm[11];
  const rShoulder = lm[12];
  const lElbow = lm[13];
  const rElbow = lm[14];
  const lWrist = lm[15];
  const rWrist = lm[16];

  const shoulderWidth = Math.max(Math.hypot(rShoulder.x - lShoulder.x, rShoulder.y - lShoulder.y), 0.08);

  switch (slug) {
    case 'arms_up': {
      const lAbove = lWrist.y < lShoulder.y - 0.05;
      const rAbove = rWrist.y < rShoulder.y - 0.05;
      const heightScore = clamp(
        ((lShoulder.y - lWrist.y) + (rShoulder.y - rWrist.y)) / (shoulderWidth * 1.4),
        0,
        1
      );
      return { active: lAbove && rAbove, confidence: lAbove && rAbove ? Math.max(0.7, heightScore) : heightScore * 0.45 };
    }
    case 't_pose': {
      const lLevel = Math.abs(lWrist.y - lShoulder.y) < 0.09 && Math.abs(lElbow.y - lShoulder.y) < 0.08;
      const rLevel = Math.abs(rWrist.y - rShoulder.y) < 0.09 && Math.abs(rElbow.y - rShoulder.y) < 0.08;
      const span = Math.abs(lWrist.x - rWrist.x) / shoulderWidth;
      const straightArms = pose.angles.leftElbow > 135 && pose.angles.rightElbow > 135;
      const active = lLevel && rLevel && span > 2.3 && straightArms;
      const conf = clamp((span / 2.8) * (active ? 0.95 : 0.45), 0, 1);
      return { active, confidence: conf };
    }
    case 'hands_together': {
      const dist = Math.hypot(lWrist.x - rWrist.x, lWrist.y - rWrist.y) / shoulderWidth;
      const conf = clamp(1 - (dist - 0.25) / 1.1, 0, 1);
      return { active: dist < 0.55, confidence: conf };
    }
    case 'squat_crouch': {
      const kneeAvg = (pose.angles.leftKnee + pose.angles.rightKnee) * 0.5;
      const active = kneeAvg < 130;
      const conf = clamp((165 - kneeAvg) / 65, 0, 1);
      return { active, confidence: conf };
    }
    default:
      return { active: false, confidence: 0 };
  }
}

export class GestureDetectorEngine {
  private definitions = buildDefinitions();
  private enabledMap = new Map<string, boolean>();
  private runtimeMap = new Map<
    string,
    { active: boolean; hitCount: number; lastTriggeredAt: number }
  >();
  private recentEvents: GestureEventLogItem[] = [];

  constructor() {
    this.loadEnabledFromStorage();
  }

  private loadEnabledFromStorage(): void {
    for (const def of this.definitions) {
      this.enabledMap.set(def.id, true);
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, boolean>;
        for (const [id, val] of Object.entries(parsed)) {
          if (this.enabledMap.has(id)) {
            this.enabledMap.set(id, Boolean(val));
          }
        }
      }
    } catch {
      // ignore storage errors
    }
  }

  private saveEnabledToStorage(): void {
    try {
      const obj: Record<string, boolean> = {};
      for (const [k, v] of this.enabledMap.entries()) obj[k] = v;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // ignore storage errors
    }
  }

  setGestureEnabled(id: string, enabled: boolean): void {
    if (!this.enabledMap.has(id)) return;
    this.enabledMap.set(id, enabled);
    this.saveEnabledToStorage();
  }

  setAllEnabled(enabled: boolean): void {
    for (const def of this.definitions) {
      this.enabledMap.set(def.id, enabled);
    }
    this.saveEnabledToStorage();
  }

  clearEvents(): void {
    this.recentEvents = [];
  }

  evaluate(frame: TrackingFrame): GestureDetectionFrame {
    const items: GestureItem[] = [];
    const nativeLookup = new Map<string, number>();

    for (const rg of frame.rawGestures) {
      const cat = NATIVE_GESTURE_CATALOG.find(
        (c) => c.categoryName.toLowerCase() === rg.categoryName.toLowerCase()
      );
      if (cat) {
        nativeLookup.set(`${rg.side}:${cat.slug}`, rg.score);
      }
    }

    const handMap: Record<HandSide, HandKinematics | null> = {
      left: frame.left,
      right: frame.right,
    };
    const primaryPose = frame.poses[0];

    let topLeft: GestureSummary | null = null;
    let topRight: GestureSummary | null = null;
    let activeCount = 0;

    for (const def of this.definitions) {
      const enabled = this.enabledMap.get(def.id) ?? true;
      let active = false;
      let confidence = 0;

      if (enabled) {
        if (def.side === 'body') {
          const res = evaluatePoseGesture(primaryPose, def.slug);
          active = res.active;
          confidence = res.confidence;
        } else {
          const hand = handMap[def.side];
          if (hand) {
            if (def.source === 'mediapipe') {
              const rawScore = nativeLookup.get(def.id);
              if (rawScore !== undefined) {
                active = rawScore >= 0.5;
                confidence = rawScore;
              } else if (frame.source === 'simulator' || frame.rawGestures.length === 0) {
                const fb = evaluateKinematicNativeFallback(hand, def.slug);
                active = fb.active;
                confidence = fb.confidence;
              }
            } else {
              const res = evaluateKinematicCustom(hand, def.slug);
              active = res.active;
              confidence = res.confidence;
            }
          }
        }
      }

      let rt = this.runtimeMap.get(def.id);
      if (!rt) {
        rt = { active: false, hitCount: 0, lastTriggeredAt: 0 };
        this.runtimeMap.set(def.id, rt);
      }

      if (active && !rt.active) {
        rt.hitCount += 1;
        rt.lastTriggeredAt = frame.timestamp;
        this.recentEvents.unshift({
          timestamp: frame.timestamp,
          gestureId: def.id,
          label: def.label,
          side: def.side,
          confidence,
          oscAddress: def.oscAddress,
        });
        if (this.recentEvents.length > 18) {
          this.recentEvents.length = 18;
        }
      }
      rt.active = active;

      if (active) {
        activeCount += 1;
        if (def.side === 'left' && (!topLeft || confidence > topLeft.confidence)) {
          topLeft = { slug: def.slug, label: def.label, confidence };
        }
        if (def.side === 'right' && (!topRight || confidence > topRight.confidence)) {
          topRight = { slug: def.slug, label: def.label, confidence };
        }
      }

      items.push({
        ...def,
        enabled,
        active,
        confidence,
        hitCount: rt.hitCount,
        lastTriggeredAt: rt.lastTriggeredAt,
      });
    }

    return {
      items,
      topLeft,
      topRight,
      activeCount,
      recentEvents: this.recentEvents,
    };
  }
}

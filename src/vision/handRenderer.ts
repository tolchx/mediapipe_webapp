import type { FingerKey, HandKinematics, PhalanxKey, SynthTelemetry, TrackingFrame, Vec3 } from '../types/hand';
import { FINGER_SPECS } from './handKinematics';

export interface RenderOverlayOptions {
  mirrored: boolean;
  showLandmarkIds: boolean;
  showPhalanxAngles: boolean;
  showPitchGuides: boolean;
  videoAspect: number;
}

const PALM_CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [0, 5],
  [5, 9],
  [9, 13],
  [13, 17],
  [17, 0],
];

const FINGER_ORDER: FingerKey[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const PHALANX_ORDER: PhalanxKey[] = ['proximal', 'intermediate', 'distal'];

function lerpColor(t: number, isLeft: boolean): string {
  const clamped = Math.max(0, Math.min(1, t));
  // Extendido: cyan (#22d3ee) o amber (#fb923c) -> Flexionado: rose/magenta (#f43f5e)
  const r0 = isLeft ? 34 : 251;
  const g0 = isLeft ? 211 : 146;
  const b0 = isLeft ? 238 : 60;

  const r1 = 244;
  const g1 = 63;
  const b1 = 94;

  const r = Math.round(r0 + (r1 - r0) * clamped);
  const g = Math.round(g0 + (g1 - g0) * clamped);
  const b = Math.round(b0 + (b1 - b0) * clamped);
  return `rgb(${r}, ${g}, ${b})`;
}

interface ViewportBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function computeContainBox(canvasW: number, canvasH: number, aspect: number): ViewportBox {
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

function projectPoint(p: Vec3, box: ViewportBox, mirrored: boolean): { x: number; y: number } {
  const nx = mirrored ? 1 - p.x : p.x;
  return {
    x: box.x + nx * box.w,
    y: box.y + p.y * box.h,
  };
}

export function renderHandOverlay(
  canvas: HTMLCanvasElement,
  frame: TrackingFrame,
  synth: SynthTelemetry,
  options: RenderOverlayOptions
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;

  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const box = computeContainBox(cssW, cssH, options.videoAspect);

  if (options.showPitchGuides) {
    drawPitchGuideRuler(ctx, box, synth);
  }

  if (frame.hands.length === 0) {
    ctx.restore();
    return;
  }

  for (const hand of frame.hands) {
    drawHand(ctx, hand, box, options);
  }

  ctx.restore();
}

function drawPitchGuideRuler(
  ctx: CanvasRenderingContext2D,
  box: ViewportBox,
  synth: SynthTelemetry
): void {
  const topY = box.y + box.h * 0.12;
  const bottomY = box.y + box.h * 0.88;
  const span = bottomY - topY;
  const rulerX = box.x + 14;

  ctx.save();
  ctx.strokeStyle = 'rgba(167, 139, 250, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rulerX, topY);
  ctx.lineTo(rulerX, bottomY);
  ctx.stroke();

  const ticks = 6;
  ctx.fillStyle = 'rgba(196, 181, 253, 0.55)';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  for (let i = 0; i <= ticks; i++) {
    const ratio = i / ticks;
    const y = bottomY - ratio * span;
    ctx.beginPath();
    ctx.moveTo(rulerX - 4, y);
    ctx.lineTo(rulerX + 5, y);
    ctx.stroke();
  }

  if (synth.handDetected) {
    const norm = Math.max(0, Math.min(1, synth.driverValues.pitchDriverNorm));
    const markerY = bottomY - norm * span;
    ctx.fillStyle = '#a78bfa';
    ctx.beginPath();
    ctx.arc(rulerX, markerY, 4.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(167, 139, 250, 0.22)';
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(rulerX + 8, markerY);
    ctx.lineTo(box.x + box.w - 16, markerY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#ede9fe';
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`${synth.quantizedFreqHz.toFixed(1)} Hz (${synth.noteName})`, rulerX + 10, markerY - 6);
  }
  ctx.restore();
}

function drawHand(
  ctx: CanvasRenderingContext2D,
  hand: HandKinematics,
  box: ViewportBox,
  options: RenderOverlayOptions
): void {
  const isLeft = hand.side === 'left';
  const baseAccent = isLeft ? '#22d3ee' : '#fb923c';
  const pts = hand.landmarks.map((p) => projectPoint(p, box, options.mirrored));

  // 1. Palma semitransparente
  ctx.save();
  ctx.fillStyle = isLeft ? 'rgba(34, 211, 238, 0.08)' : 'rgba(251, 146, 60, 0.08)';
  ctx.beginPath();
  const palmLoop = [0, 1, 5, 9, 13, 17];
  palmLoop.forEach((idx, i) => {
    const pt = pts[idx];
    if (i === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.closePath();
  ctx.fill();

  // 2. Conexiones metacarpianas de la palma
  ctx.strokeStyle = isLeft ? 'rgba(34, 211, 238, 0.55)' : 'rgba(251, 146, 60, 0.55)';
  ctx.lineWidth = 2;
  for (const [a, b] of PALM_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();
  }

  // 3. Cada dedo y cada falange coloreada según flexión
  const widths: Record<PhalanxKey, number> = {
    proximal: 5.5,
    intermediate: 4.2,
    distal: 3.0,
  };

  for (const fKey of FINGER_ORDER) {
    const finger = hand.fingers[fKey];
    for (const pKey of PHALANX_ORDER) {
      const phalanx = finger.phalanges[pKey];
      const [a, b] = phalanx.boneIndices;
      const pA = pts[a];
      const pB = pts[b];
      ctx.strokeStyle = lerpColor(phalanx.flex, isLeft);
      ctx.lineWidth = widths[pKey];
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.stroke();

      if (options.showPhalanxAngles && pKey !== 'distal') {
        const labelPt = pts[phalanx.indices[1]];
        ctx.fillStyle = 'rgba(11, 14, 19, 0.78)';
        ctx.fillRect(labelPt.x + 6, labelPt.y - 9, 30, 14);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(`${Math.round(phalanx.angleDeg)}°`, labelPt.x + 8, labelPt.y + 1);
      }
    }
  }

  // 4. Indicador visual de Pinch Pulgar-Índice
  const thumbTip = pts[4];
  const indexTip = pts[8];
  const pinch = hand.pinches.index;
  ctx.strokeStyle = pinch.active ? '#34d399' : 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = pinch.active ? 2.5 : 1.3;
  ctx.setLineDash(pinch.active ? [] : [4, 4]);
  ctx.beginPath();
  ctx.moveTo(thumbTip.x, thumbTip.y);
  ctx.lineTo(indexTip.x, indexTip.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const midPinchX = (thumbTip.x + indexTip.x) / 2;
  const midPinchY = (thumbTip.y + indexTip.y) / 2;
  if (pinch.closeness > 0.2) {
    ctx.fillStyle = pinch.active ? 'rgba(16, 185, 129, 0.85)' : 'rgba(17, 22, 31, 0.78)';
    ctx.fillRect(midPinchX - 20, midPinchY - 9, 40, 16);
    ctx.fillStyle = pinch.active ? '#04120c' : '#cbd5e1';
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(pinch.closeness * 100)}%`, midPinchX, midPinchY + 3);
    ctx.textAlign = 'left';
  }

  // 5. Puntos articulares (21 landmarks)
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
    const radius = i === 0 ? 5.5 : isTip ? 5 : 3.6;

    ctx.fillStyle = '#0b0e13';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius + 1.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = isTip ? '#f8fafc' : baseAccent;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (options.showLandmarkIds) {
      ctx.fillStyle = '#f8fafc';
      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(String(i), pt.x + 6, pt.y - 5);
    }
  }

  // 6. Etiquetas en puntas de dedo y centro de palma
  const palmPt = projectPoint(hand.palmCenter, box, options.mirrored);
  ctx.strokeStyle = baseAccent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(palmPt.x, palmPt.y, 7, 0, Math.PI * 2);
  ctx.stroke();

  const badgeLabel = `${isLeft ? 'IZQ' : 'DER'} · ${Math.round(hand.palmOpenness * 100)}%`;
  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  const textW = ctx.measureText(badgeLabel).width + 14;
  ctx.fillStyle = 'rgba(11, 14, 19, 0.85)';
  ctx.strokeStyle = baseAccent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(palmPt.x - textW / 2, palmPt.y + 12, textW, 20, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = baseAccent;
  ctx.textAlign = 'center';
  ctx.fillText(badgeLabel, palmPt.x, palmPt.y + 26);
  ctx.textAlign = 'left';

  // Nombre corto en puntas cuando está extendido
  for (const spec of FINGER_SPECS) {
    const tip = pts[spec.tipIndex];
    const finger = hand.fingers[spec.key];
    if (finger.extended > 0.35 && options.showPhalanxAngles) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(spec.label.slice(0, 3).toUpperCase(), tip.x - 10, tip.y - 10);
    }
  }

  ctx.restore();
}

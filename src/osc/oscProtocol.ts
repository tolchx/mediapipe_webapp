import type {
  FingerKey,
  HandKinematics,
  OscChannelGroups,
  OscMessageItem,
  PhalanxKey,
  PinchTarget,
  SynthTelemetry,
  TrackingFrame,
  TriggerEvaluation,
} from '../types/hand';

const FINGERS: FingerKey[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const PHALANGES: PhalanxKey[] = ['proximal', 'intermediate', 'distal'];
const PINCHES: PinchTarget[] = ['index', 'middle', 'ring', 'pinky'];

function fArg(value: number): { type: 'f'; value: number } {
  return { type: 'f', value: Number.isFinite(value) ? Number(value.toFixed(5)) : 0 };
}

function iArg(value: number): { type: 'i'; value: number } {
  return { type: 'i', value: Math.trunc(value) };
}

function appendHandMessages(
  out: OscMessageItem[],
  hand: HandKinematics,
  channels: OscChannelGroups
): void {
  const base = `/hand/${hand.side}`;

  if (channels.palm) {
    out.push({
      address: `${base}/palm/xyz`,
      args: [fArg(hand.palmCenter.x), fArg(hand.palmCenter.y), fArg(hand.palmCenter.z)],
    });
    out.push({
      address: `${base}/palm/openness`,
      args: [fArg(hand.palmOpenness)],
    });
    out.push({
      address: `${base}/palm/orientation`,
      args: [
        fArg(hand.palmOrientation.pitch),
        fArg(hand.palmOrientation.yaw),
        fArg(hand.palmOrientation.roll),
      ],
    });
    out.push({
      address: `${base}/palm/velocity`,
      args: [fArg(hand.palmVelocity)],
    });
  }

  if (channels.fingers) {
    for (const fKey of FINGERS) {
      const f = hand.fingers[fKey];
      out.push({
        address: `${base}/finger/${fKey}/curl`,
        args: [fArg(f.curl)],
      });
      out.push({
        address: `${base}/finger/${fKey}/extended`,
        args: [fArg(f.extended)],
      });
    }

    out.push({
      address: `${base}/finger/spread`,
      args: [
        fArg(hand.spread.thumbIndex),
        fArg(hand.spread.indexMiddle),
        fArg(hand.spread.middleRing),
        fArg(hand.spread.ringPinky),
      ],
    });

    for (const pTarget of PINCHES) {
      const p = hand.pinches[pTarget];
      out.push({
        address: `${base}/pinch/${pTarget}`,
        args: [fArg(p.closeness), fArg(p.distanceNorm), iArg(p.active ? 1 : 0)],
      });
    }
  }

  if (channels.phalanges) {
    for (const fKey of FINGERS) {
      const finger = hand.fingers[fKey];
      for (const pKey of PHALANGES) {
        const phalanx = finger.phalanges[pKey];
        out.push({
          address: `${base}/phalanx/${fKey}/${pKey}/angle`,
          args: [fArg(phalanx.angleDeg)],
        });
        out.push({
          address: `${base}/phalanx/${fKey}/${pKey}/flex`,
          args: [fArg(phalanx.flex)],
        });
      }
    }
  }

  if (channels.landmarks) {
    for (let i = 0; i < hand.landmarks.length; i++) {
      const lm = hand.landmarks[i];
      out.push({
        address: `${base}/landmark/${i}`,
        args: [fArg(lm.x), fArg(lm.y), fArg(lm.z)],
      });
    }
    for (let i = 0; i < hand.worldLandmarks.length; i++) {
      const w = hand.worldLandmarks[i];
      out.push({
        address: `${base}/world_landmark/${i}`,
        args: [fArg(w.x), fArg(w.y), fArg(w.z)],
      });
    }
  }
}

export function buildOscMessages(
  frame: TrackingFrame,
  synth: SynthTelemetry,
  channels: OscChannelGroups,
  triggers: TriggerEvaluation[] = []
): OscMessageItem[] {
  const messages: OscMessageItem[] = [];

  if (channels.triggers) {
    for (const ev of triggers) {
      if (!ev.zone.enabled) continue;
      const rawAddr = ev.zone.oscAddress.trim() || `/td/pad/${ev.zone.id}`;
      const baseAddr = rawAddr.startsWith('/') ? rawAddr : `/${rawAddr}`;
      messages.push({
        address: baseAddr,
        args: [iArg(ev.value)],
      });
      if (channels.triggerSubchannels) {
        messages.push(
          { address: `${baseAddr}/inside`, args: [iArg(ev.inside ? 1 : 0)] },
          { address: `${baseAddr}/xy`, args: [fArg(ev.localX), fArg(ev.localY)] },
          { address: `${baseAddr}/count`, args: [iArg(ev.hitCount)] }
        );
      }
    }
  }

  if (channels.palm) {
    messages.push({
      address: '/hand/left/detected',
      args: [iArg(frame.left ? 1 : 0)],
    });
    messages.push({
      address: '/hand/right/detected',
      args: [iArg(frame.right ? 1 : 0)],
    });
  }

  for (const hand of frame.hands) {
    appendHandMessages(messages, hand, channels);
  }

  if (channels.synth) {
    messages.push(
      { address: '/synth/active', args: [iArg(synth.active ? 1 : 0)] },
      { address: '/synth/frequency', args: [fArg(synth.quantizedFreqHz)] },
      { address: '/synth/raw_frequency', args: [fArg(synth.rawFreqHz)] },
      { address: '/synth/midi', args: [fArg(synth.midiNote)] },
      { address: '/synth/cutoff', args: [fArg(synth.cutoffHz)] },
      { address: '/synth/resonance', args: [fArg(synth.resonanceQ)] },
      { address: '/synth/fm_depth', args: [fArg(synth.fmDepthHz)] },
      { address: '/synth/lfo_rate', args: [fArg(synth.lfoRateHz)] },
      { address: '/synth/lfo_depth', args: [fArg(synth.lfoDepthHz)] },
      { address: '/synth/gain', args: [fArg(synth.gain)] }
    );
  }

  return messages;
}

export function formatOscMessagePreview(msg: OscMessageItem): {
  address: string;
  types: string;
  values: string;
} {
  const types = msg.args.map((a) => a.type).join('');
  const values = msg.args
    .map((a) => (typeof a.value === 'number' ? (a.type === 'i' ? String(a.value) : a.value.toFixed(3)) : a.value))
    .join('  ');
  return { address: msg.address, types, values };
}

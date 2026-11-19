import type {
  FingerKey,
  GestureDetectionFrame,
  HandKinematics,
  OscChannelGroups,
  OscGesturesChannels,
  OscMessageItem,
  OscSkeletonChannels,
  PhalanxKey,
  PinchTarget,
  SynthTelemetry,
  TrackingFrame,
  TriggerEvaluation,
} from '../types/hand';
import { KEY_POSE_JOINTS } from '../vision/poseKinematics.ts';

const FINGERS: FingerKey[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const PHALANGES: PhalanxKey[] = ['proximal', 'intermediate', 'distal'];
const PINCHES: PinchTarget[] = ['index', 'middle', 'ring', 'pinky'];

function fArg(value: number): { type: 'f'; value: number } {
  return { type: 'f', value: Number.isFinite(value) ? Number(value.toFixed(5)) : 0 };
}

function iArg(value: number): { type: 'i'; value: number } {
  return { type: 'i', value: Math.trunc(value) };
}

function sArg(value: string): { type: 's'; value: string } {
  return { type: 's', value: String(value ?? '') };
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

export function buildGestureOscMessages(
  gestures: GestureDetectionFrame,
  channels: OscGesturesChannels
): OscMessageItem[] {
  const messages: OscMessageItem[] = [];

  messages.push({
    address: '/gestures/active_count',
    args: [iArg(gestures.activeCount)],
  });

  if (channels.sendTopGesture) {
    messages.push({
      address: '/gestures/left/top',
      args: [
        sArg(gestures.topLeft?.slug ?? 'none'),
        fArg(gestures.topLeft?.confidence ?? 0),
      ],
    });
    messages.push({
      address: '/gestures/right/top',
      args: [
        sArg(gestures.topRight?.slug ?? 'none'),
        fArg(gestures.topRight?.confidence ?? 0),
      ],
    });
  }

  for (const g of gestures.items) {
    if (!g.enabled) continue;
    if (channels.onlyActiveOrChanged && !g.active) continue;

    messages.push({
      address: g.oscAddress,
      args: [iArg(g.active ? 1 : 0)],
    });

    if (channels.sendScores) {
      messages.push({
        address: `/gestures/${g.side}/score/${g.slug}`,
        args: [fArg(g.confidence)],
      });
    }
  }

  return messages;
}

export function buildSkeletonOscMessages(
  frame: TrackingFrame,
  channels: OscSkeletonChannels
): OscMessageItem[] {
  const messages: OscMessageItem[] = [];
  const detected = frame.poses.length > 0 ? 1 : 0;

  messages.push(
    { address: '/pose/detected', args: [iArg(detected)] },
    { address: '/pose/count', args: [iArg(frame.poses.length)] }
  );

  for (const pose of frame.poses) {
    const base = `/pose/${pose.id}`;

    if (channels.torsoMetrics) {
      messages.push(
        {
          address: `${base}/center`,
          args: [fArg(pose.centerOfMass.x), fArg(pose.centerOfMass.y), fArg(pose.centerOfMass.z)],
        },
        {
          address: `${base}/shoulder_center`,
          args: [
            fArg(pose.shoulderCenter.x),
            fArg(pose.shoulderCenter.y),
            fArg(pose.shoulderCenter.z),
          ],
        },
        {
          address: `${base}/lean`,
          args: [
            fArg(pose.torsoLean.forwardDeg),
            fArg(pose.torsoLean.lateralDeg),
            fArg(pose.torsoLean.twistDeg),
          ],
        },
        {
          address: `${base}/visibility`,
          args: [fArg(pose.visibilityMean)],
        }
      );
    }

    if (channels.angles) {
      const a = pose.angles;
      messages.push(
        {
          address: `${base}/angles`,
          args: [
            fArg(a.leftElbow),
            fArg(a.rightElbow),
            fArg(a.leftShoulder),
            fArg(a.rightShoulder),
            fArg(a.leftHip),
            fArg(a.rightHip),
            fArg(a.leftKnee),
            fArg(a.rightKnee),
          ],
        },
        { address: `${base}/angle/left_elbow`, args: [fArg(a.leftElbow)] },
        { address: `${base}/angle/right_elbow`, args: [fArg(a.rightElbow)] },
        { address: `${base}/angle/left_shoulder`, args: [fArg(a.leftShoulder)] },
        { address: `${base}/angle/right_shoulder`, args: [fArg(a.rightShoulder)] },
        { address: `${base}/angle/left_hip`, args: [fArg(a.leftHip)] },
        { address: `${base}/angle/right_hip`, args: [fArg(a.rightHip)] },
        { address: `${base}/angle/left_knee`, args: [fArg(a.leftKnee)] },
        { address: `${base}/angle/right_knee`, args: [fArg(a.rightKnee)] }
      );
    }

    if (channels.namedJoints) {
      for (const j of KEY_POSE_JOINTS) {
        const lm = pose.landmarks[j.index];
        if (!lm) continue;
        messages.push({
          address: `${base}/joint/${j.name}`,
          args: [fArg(lm.x), fArg(lm.y), fArg(lm.z), fArg(lm.visibility ?? 1)],
        });
      }
    }

    if (channels.landmarks) {
      for (let i = 0; i < pose.landmarks.length; i++) {
        const lm = pose.landmarks[i];
        messages.push({
          address: `${base}/landmark/${i}`,
          args: [fArg(lm.x), fArg(lm.y), fArg(lm.z), fArg(lm.visibility ?? 1)],
        });
      }
    }

    if (channels.worldLandmarks) {
      for (let i = 0; i < pose.worldLandmarks.length; i++) {
        const lm = pose.worldLandmarks[i];
        messages.push({
          address: `${base}/world_landmark/${i}`,
          args: [fArg(lm.x), fArg(lm.y), fArg(lm.z), fArg(lm.visibility ?? 1)],
        });
      }
    }
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

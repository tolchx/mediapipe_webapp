import type {
  HandKinematics,
  ScaleType,
  SynthConfig,
  SynthTelemetry,
  TrackingFrame,
} from '../types/hand';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const SCALE_INTERVALS: Record<Exclude<ScaleType, 'free'>, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  pentatonic_minor: [0, 3, 5, 7, 10],
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(Math.max(freq, 20) / 440);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function formatMidiNote(midiFloat: number): { name: string; cents: number } {
  const nearest = Math.round(midiFloat);
  const cents = Math.round((midiFloat - nearest) * 100);
  const noteIdx = ((nearest % 12) + 12) % 12;
  const octave = Math.floor(nearest / 12) - 1;
  return { name: `${NOTE_NAMES[noteIdx]}${octave}`, cents };
}

function quantizeToScale(freq: number, scale: ScaleType, rootNote: number): number {
  if (scale === 'free') return freq;
  const intervals = SCALE_INTERVALS[scale];
  const midiFloat = freqToMidi(freq);
  const baseMidi = Math.floor(midiFloat);

  let bestMidi = Math.round(midiFloat);
  let bestDist = Infinity;

  for (let m = baseMidi - 12; m <= baseMidi + 12; m++) {
    const pc = (((m - rootNote) % 12) + 12) % 12;
    if (!intervals.includes(pc)) continue;
    const d = Math.abs(m - midiFloat);
    if (d < bestDist) {
      bestDist = d;
      bestMidi = m;
    }
  }
  return midiToFreq(bestMidi);
}

export class GestureSynthEngine {
  private ctx: AudioContext | null = null;
  private mainOsc: OscillatorNode | null = null;
  private subOsc: OscillatorNode | null = null;
  private fmOsc: OscillatorNode | null = null;
  private lfoOsc: OscillatorNode | null = null;

  private subGain: GainNode | null = null;
  private fmGain: GainNode | null = null;
  private lfoGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private voiceGain: GainNode | null = null;
  private delayMix: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;

  private config: SynthConfig = {
    enabled: false,
    mappingMode: 'theremin',
    minFreqHz: 82.41, // E2
    maxFreqHz: 987.77, // B5
    scale: 'pentatonic_minor',
    rootNote: 9, // A
    waveform: 'sawtooth',
    glideMs: 32,
    masterVolume: 0.65,
    pinchGate: false,
    baseResonance: 3.2,
  };

  private lastTelemetry: SynthTelemetry = this.createEmptyTelemetry();

  getConfig(): SynthConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<SynthConfig>): void {
    this.config = { ...this.config, ...partial };
    if (this.config.minFreqHz >= this.config.maxFreqHz - 20) {
      this.config.maxFreqHz = this.config.minFreqHz + 40;
    }
    if (this.mainOsc) {
      this.mainOsc.type = this.config.waveform;
    }
    if (this.masterGain && this.ctx) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.setTargetAtTime(
        this.config.enabled ? this.config.masterVolume * 0.55 : 0,
        now,
        0.025
      );
    }
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    this.config.enabled = enabled;
    if (enabled) {
      await this.ensureAudioGraph();
      if (this.ctx && this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setTargetAtTime(
          this.config.masterVolume * 0.55,
          this.ctx.currentTime,
          0.03
        );
      }
    } else if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    }
    return this.config.enabled;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  getSampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  getLastTelemetry(): SynthTelemetry {
    return this.lastTelemetry;
  }

  private async ensureAudioGraph(): Promise<void> {
    if (this.ctx) return;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    this.ctx = ctx;

    const mainOsc = ctx.createOscillator();
    mainOsc.type = this.config.waveform;
    mainOsc.frequency.value = 220;

    const subOsc = ctx.createOscillator();
    subOsc.type = 'triangle';
    subOsc.frequency.value = 110;

    const fmOsc = ctx.createOscillator();
    fmOsc.type = 'sine';
    fmOsc.frequency.value = 440;

    const lfoOsc = ctx.createOscillator();
    lfoOsc.type = 'sine';
    lfoOsc.frequency.value = 4.5;

    const subGain = ctx.createGain();
    subGain.gain.value = 0.15;

    const fmGain = ctx.createGain();
    fmGain.gain.value = 0;

    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2600;
    filter.Q.value = this.config.baseResonance;

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = 0;

    const delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = 0.24;

    const delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0.28;

    const delayMix = ctx.createGain();
    delayMix.gain.value = 0.14;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.12;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.78;

    // Routing
    fmOsc.connect(fmGain);
    fmGain.connect(mainOsc.frequency);

    lfoOsc.connect(lfoGain);
    lfoGain.connect(mainOsc.frequency);

    mainOsc.connect(filter);
    subOsc.connect(subGain);
    subGain.connect(filter);

    filter.connect(voiceGain);

    // Dry + Delay Send
    voiceGain.connect(masterGain);
    voiceGain.connect(delayNode);
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);
    delayNode.connect(delayMix);
    delayMix.connect(masterGain);

    masterGain.connect(compressor);
    compressor.connect(analyser);
    analyser.connect(ctx.destination);

    mainOsc.start();
    subOsc.start();
    fmOsc.start();
    lfoOsc.start();

    this.mainOsc = mainOsc;
    this.subOsc = subOsc;
    this.fmOsc = fmOsc;
    this.lfoOsc = lfoOsc;
    this.subGain = subGain;
    this.fmGain = fmGain;
    this.lfoGain = lfoGain;
    this.filter = filter;
    this.voiceGain = voiceGain;
    this.delayMix = delayMix;
    this.masterGain = masterGain;
    this.analyser = analyser;
  }

  updateFromTracking(frame: TrackingFrame): SynthTelemetry {
    const telemetry = this.computeTelemetry(frame);
    this.lastTelemetry = telemetry;

    if (!this.ctx || !this.mainOsc || !this.subOsc || !this.fmOsc || !this.lfoOsc || !this.filter || !this.voiceGain) {
      return telemetry;
    }

    const now = this.ctx.currentTime;
    const glideTau = Math.max(0.006, this.config.glideMs / 1000);
    const modTau = 0.025;

    const bentFreq = telemetry.quantizedFreqHz * Math.pow(2, telemetry.pitchBendCents / 1200);
    this.mainOsc.frequency.setTargetAtTime(bentFreq, now, glideTau);
    this.subOsc.frequency.setTargetAtTime(bentFreq * 0.5, now, glideTau);

    const fmRatio = this.config.mappingMode === 'dual-hand' && frame.left
      ? 1 + Math.round(frame.left.pinches.index.closeness * 3)
      : 2;
    this.fmOsc.frequency.setTargetAtTime(bentFreq * fmRatio, now, glideTau);

    this.fmGain?.gain.setTargetAtTime(telemetry.fmDepthHz, now, modTau);
    this.lfoOsc.frequency.setTargetAtTime(telemetry.lfoRateHz, now, modTau);
    this.lfoGain?.gain.setTargetAtTime(telemetry.lfoDepthHz, now, modTau);
    this.subGain?.gain.setTargetAtTime(telemetry.subMix, now, modTau);

    this.filter.frequency.setTargetAtTime(telemetry.cutoffHz, now, modTau);
    this.filter.Q.setTargetAtTime(telemetry.resonanceQ, now, modTau);
    this.delayMix?.gain.setTargetAtTime(0.06 + telemetry.subMix * 0.25, now, 0.05);

    const targetAmp = this.config.enabled && telemetry.handDetected ? telemetry.gain : 0;
    this.voiceGain.gain.setTargetAtTime(targetAmp, now, telemetry.handDetected ? 0.02 : 0.08);

    return telemetry;
  }

  private computeTelemetry(frame: TrackingFrame): SynthTelemetry {
    const primary: HandKinematics | null = frame.right ?? frame.left;
    if (!primary) {
      return {
        ...this.createEmptyTelemetry(),
        active: this.config.enabled,
      };
    }

    const secondary: HandKinematics | null =
      primary.side === 'right' ? frame.left : frame.right;

    let pitchNorm = 0.5;
    let cutoffNorm = 0.5;
    let fmNorm = 0;
    let lfoNorm = 0;
    let subNorm = 0.2;
    let resonanceNorm = 0.25;
    let pitchBendCents = 0;
    let gain = 0.65;

    let pitchDriverLabel = 'Palma Y';
    let cutoffDriverLabel = 'Índice (Falanges)';
    let fmDriverLabel = 'Dedo Medio';
    let lfoDriverLabel = 'Dedo Anular';
    let subDriverLabel = 'Dedo Meñique';

    if (this.config.mappingMode === 'theremin') {
      pitchNorm = clamp(1 - (primary.palmCenter.y - 0.12) / 0.76, 0, 1);
      cutoffNorm = clamp(primary.fingers.index.extended, 0, 1);
      fmNorm = clamp(primary.fingers.middle.curl, 0, 1);
      lfoNorm = clamp(primary.fingers.ring.curl, 0, 1);
      subNorm = clamp(primary.fingers.pinky.curl, 0, 1);
      resonanceNorm = clamp(primary.pinches.index.closeness, 0, 1);

      // Falange distal del índice produce micro pitch-bend expresivo en modo libre
      if (this.config.scale === 'free') {
        pitchBendCents = -primary.fingers.index.phalanges.distal.flex * 65;
      }

      gain = this.config.pinchGate
        ? primary.pinches.index.active
          ? 0.78
          : 0
        : 0.28 + primary.palmOpenness * 0.65;
    } else if (this.config.mappingMode === 'pinch-pitch') {
      pitchDriverLabel = 'Pinch Pulgar-Índice';
      cutoffDriverLabel = 'Índice F. Media';
      pitchNorm = clamp(1 - primary.pinches.index.closeness, 0, 1);
      cutoffNorm = clamp(primary.fingers.index.phalanges.intermediate.extended, 0, 1);
      fmNorm = clamp(primary.fingers.middle.curl, 0, 1);
      lfoNorm = clamp(primary.fingers.ring.curl, 0, 1);
      subNorm = clamp(primary.fingers.pinky.curl, 0, 1);
      resonanceNorm = clamp(1 - primary.palmCenter.y, 0, 1);

      gain = this.config.pinchGate
        ? primary.pinches.middle.active
          ? 0.8
          : 0
        : 0.35 + primary.fingers.thumb.extended * 0.55;
    } else {
      // dual-hand
      pitchDriverLabel = secondary ? 'Mano Der · Altura Y' : 'Altura Palma Y';
      cutoffDriverLabel = 'Der · Índice';
      fmDriverLabel = secondary ? 'Mano Izq · Altura Y' : 'Dedo Medio';
      lfoDriverLabel = 'Der · Anular';
      subDriverLabel = secondary ? 'Mano Izq · Meñique' : 'Dedo Meñique';

      pitchNorm = clamp(1 - (primary.palmCenter.y - 0.12) / 0.76, 0, 1);
      cutoffNorm = clamp(primary.fingers.index.extended, 0, 1);
      lfoNorm = clamp(primary.fingers.ring.curl, 0, 1);
      resonanceNorm = clamp(primary.pinches.index.closeness, 0, 1);

      if (secondary) {
        fmNorm = clamp(1 - (secondary.palmCenter.y - 0.12) / 0.76, 0, 1);
        subNorm = clamp(secondary.fingers.pinky.curl, 0, 1);
        gain = this.config.pinchGate
          ? primary.pinches.index.active || secondary.pinches.index.active
            ? 0.85
            : 0
          : 0.18 + secondary.palmOpenness * 0.78;
      } else {
        fmNorm = clamp(primary.fingers.middle.curl, 0, 1);
        subNorm = clamp(primary.fingers.pinky.curl, 0, 1);
        gain = this.config.pinchGate
          ? primary.pinches.index.active
            ? 0.8
            : 0
          : 0.3 + primary.palmOpenness * 0.6;
      }
    }

    const ratio = this.config.maxFreqHz / Math.max(this.config.minFreqHz, 20);
    const rawFreqHz = this.config.minFreqHz * Math.pow(ratio, pitchNorm);
    const quantizedFreqHz = quantizeToScale(rawFreqHz, this.config.scale, this.config.rootNote);

    const midiNote = freqToMidi(quantizedFreqHz);
    const noteInfo = formatMidiNote(midiNote);

    const cutoffHz = 220 * Math.pow(9500 / 220, cutoffNorm);
    const resonanceQ = clamp(this.config.baseResonance + resonanceNorm * 8.5, 0.5, 14);
    const fmDepthHz = fmNorm * 260;
    const lfoRateHz = 1.5 + lfoNorm * 10.5;
    const lfoDepthHz = lfoNorm > 0.1 ? lfoNorm * 28 : 0;
    const subMix = subNorm * 0.55;

    return {
      active: this.config.enabled,
      handDetected: true,
      primarySide: primary.side,
      rawFreqHz,
      quantizedFreqHz,
      midiNote,
      noteName: noteInfo.name,
      centsOff: noteInfo.cents,
      cutoffHz,
      resonanceQ,
      fmDepthHz,
      lfoRateHz,
      lfoDepthHz,
      subMix,
      gain: clamp(gain, 0, 1),
      pitchBendCents,
      driverValues: {
        pitchDriverLabel,
        pitchDriverNorm: pitchNorm,
        cutoffDriverLabel,
        cutoffDriverNorm: cutoffNorm,
        fmDriverLabel,
        fmDriverNorm: fmNorm,
        lfoDriverLabel,
        lfoDriverNorm: lfoNorm,
        subDriverLabel,
        subDriverNorm: subNorm,
      },
    };
  }

  private createEmptyTelemetry(): SynthTelemetry {
    return {
      active: false,
      handDetected: false,
      primarySide: null,
      rawFreqHz: 220,
      quantizedFreqHz: 220,
      midiNote: 57,
      noteName: 'A3',
      centsOff: 0,
      cutoffHz: 2200,
      resonanceQ: this.config.baseResonance,
      fmDepthHz: 0,
      lfoRateHz: 4.5,
      lfoDepthHz: 0,
      subMix: 0,
      gain: 0,
      pitchBendCents: 0,
      driverValues: {
        pitchDriverLabel: 'Palma Y',
        pitchDriverNorm: 0,
        cutoffDriverLabel: 'Índice',
        cutoffDriverNorm: 0,
        fmDriverLabel: 'Medio',
        fmDriverNorm: 0,
        lfoDriverLabel: 'Anular',
        lfoDriverNorm: 0,
        subDriverLabel: 'Meñique',
        subDriverNorm: 0,
      },
    };
  }

  dispose(): void {
    try {
      this.mainOsc?.stop();
      this.subOsc?.stop();
      this.fmOsc?.stop();
      this.lfoOsc?.stop();
      this.ctx?.close();
    } catch {
      // ignore cleanup errors
    }
    this.ctx = null;
  }
}

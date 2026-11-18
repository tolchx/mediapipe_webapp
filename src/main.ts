import './styles.css';
import type {
  FingerKey,
  HandKinematics,
  OscMessageItem,
  OscStats,
  PhalanxKey,
  PinchTarget,
  ScaleType,
  SimulatorControls,
  SynthMappingMode,
  SynthTelemetry,
  TrackingFrame,
  TrackingSourceMode,
  TriggerEvaluation,
  TriggerHandFilter,
  TriggerMode,
  TriggerShape,
  TriggerTarget,
  WaveformType,
} from './types/hand';
import { FINGER_SPECS } from './vision/handKinematics';
import { HandTrackerService } from './vision/handTracker';
import { renderHandOverlay } from './vision/handRenderer';
import {
  TRIGGER_TARGET_LABELS,
  TriggerZoneEngine,
  computeContainBox,
  getZonePixelGeometry,
  hitTestZoneNormalized,
} from './vision/triggerZones';
import { GestureSynthEngine } from './audio/synthEngine';
import { AudioVisualizer } from './audio/audioVisualizer';
import { OscBridgeClient } from './osc/oscClient';
import { buildOscMessages, formatOscMessagePreview } from './osc/oscProtocol';

const FINGER_KEYS: FingerKey[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const PHALANX_KEYS: PhalanxKey[] = ['proximal', 'intermediate', 'distal'];
const PINCH_KEYS: PinchTarget[] = ['index', 'middle', 'ring', 'pinky'];

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element #${id}`);
  return el as T;
}

class HandOscApp {
  private tracker = new HandTrackerService();
  private synth = new GestureSynthEngine();
  private visualizer = new AudioVisualizer();
  private oscClient = new OscBridgeClient();
  private triggerEngine = new TriggerZoneEngine();

  private sourceMode: TrackingSourceMode = 'camera';
  private cameraActive = false;
  private cameraStream: MediaStream | null = null;
  private mirrored = true;
  private showVideo = true;
  private showAngles = true;
  private showIds = false;
  private showTriggers = true;
  private editTriggers = false;
  private selectedTriggerId: string | null = null;
  private lastVideoAspect = 16 / 9;
  private lastTriggerValues = new Map<string, number>();
  private inspectPreference: 'auto' | 'left' | 'right' = 'auto';

  private simControls: SimulatorControls = {
    preset: 'theremin_wave',
    handsCount: 1,
    palmY: 0.45,
    palmX: 0.52,
    pinchAperture: 0.65,
    fingersCurl: {
      thumb: 0.2,
      index: 0.15,
      middle: 0.25,
      ring: 0.3,
      pinky: 0.2,
    },
    phalanxBias: {
      proximal: 0,
      intermediate: 0,
      distal: 0,
    },
  };

  private rafId: number | null = null;
  private fpsFrames = 0;
  private fpsLastTime = performance.now();
  private currentFps = 0;
  private lastUiTelemetryTime = 0;
  private lastOscMonitorTime = 0;

  // DOM refs
  private videoEl = byId<HTMLVideoElement>('webcamVideo');
  private handCanvas = byId<HTMLCanvasElement>('handCanvas');
  private audioCanvas = byId<HTMLCanvasElement>('audioCanvas');

  private mpStatusDot = byId<HTMLElement>('mpStatusDot');
  private mpStatusText = byId<HTMLElement>('mpStatusText');
  private oscStatusDot = byId<HTMLElement>('oscStatusDot');
  private oscStatusText = byId<HTMLElement>('oscStatusText');
  private freqHeaderText = byId<HTMLElement>('freqHeaderText');
  private fpsText = byId<HTMLElement>('fpsText');

  private btnSourceCamera = byId<HTMLButtonElement>('btnSourceCamera');
  private btnSourceSim = byId<HTMLButtonElement>('btnSourceSim');
  private cameraSelect = byId<HTMLSelectElement>('cameraSelect');
  private btnToggleCamera = byId<HTMLButtonElement>('btnToggleCamera');
  private btnToggleAudio = byId<HTMLButtonElement>('btnToggleAudio');

  private cameraPrompt = byId<HTMLElement>('cameraPrompt');
  private cameraErrorMsg = byId<HTMLElement>('cameraErrorMsg');
  private stageSourceBadge = byId<HTMLElement>('stageSourceBadge');
  private handsDetectedBadge = byId<HTMLElement>('handsDetectedBadge');
  private simulatorPanel = byId<HTMLElement>('simulatorPanel');
  private simManualGrid = byId<HTMLElement>('simManualGrid');

  private readoutFreqHz = byId<HTMLElement>('readoutFreqHz');
  private readoutNote = byId<HTMLElement>('readoutNote');
  private readoutCutoff = byId<HTMLElement>('readoutCutoff');
  private readoutFm = byId<HTMLElement>('readoutFm');
  private readoutLfo = byId<HTMLElement>('readoutLfo');
  private readoutGain = byId<HTMLElement>('readoutGain');

  private inspectedHandBadge = byId<HTMLElement>('inspectedHandBadge');
  private palmXyzText = byId<HTMLElement>('palmXyzText');
  private palmOpenText = byId<HTMLElement>('palmOpenText');
  private palmOrientText = byId<HTMLElement>('palmOrientText');
  private palmVelText = byId<HTMLElement>('palmVelText');

  private oscBridgeState = byId<HTMLElement>('oscBridgeState');
  private oscMsgRate = byId<HTMLElement>('oscMsgRate');
  private oscPacketsTotal = byId<HTMLElement>('oscPacketsTotal');
  private oscBytesTotal = byId<HTMLElement>('oscBytesTotal');
  private oscTestResult = byId<HTMLElement>('oscTestResult');
  private oscMonitorList = byId<HTMLElement>('oscMonitorList');

  // Pre-built fast meter refs
  private pinchRefs = new Map<
    PinchTarget,
    { card: HTMLElement; val: HTMLElement; bar: HTMLElement }
  >();
  private fingerCurlRefs = new Map<FingerKey, HTMLElement>();
  private phalanxRefs = new Map<
    string,
    { val: HTMLElement; bar: HTMLElement }
  >();
  private driverRefs: Array<{
    key: 'pitch' | 'cutoff' | 'fm' | 'lfo' | 'sub';
    label: HTMLElement;
    val: HTMLElement;
    bar: HTMLElement;
  }> = [];
  private triggerRowRefs = new Map<string, { item: HTMLElement; pill: HTMLElement }>();

  async boot(): Promise<void> {
    this.buildKinematicsDom();
    this.buildSynthDriverDom();
    this.selectedTriggerId = this.triggerEngine.getZones()[0]?.id ?? null;
    this.renderTriggerZonesList();
    this.syncSelectedTriggerEditor();
    this.bindEvents();
    this.bindTriggerEvents();
    this.bindTriggerCanvasInteractions();
    this.syncSynthControlsToDom();

    this.oscClient.onStats((stats) => this.updateOscStatsUi(stats));
    this.oscClient.onLoopback((res) => {
      this.oscTestResult.classList.remove('hidden');
      if (res.ok) {
        this.oscTestResult.textContent =
          `[Loopback UDP OK] ${res.bytes} bytes recibidos en ${res.latencyMs} ms\n` +
          JSON.stringify(res.decoded, null, 2);
      } else {
        this.oscTestResult.textContent = `[Loopback Error] ${res.error}`;
      }
    });
    this.oscClient.onTestPacketSent((info) => {
      this.oscTestResult.classList.remove('hidden');
      this.oscTestResult.textContent = `[TX Test OK] Enviados ${info.count} mensajes OSC a ${info.host}:${info.port}`;
    });
    this.oscClient.connect();

    this.startMainLoop();

    // Inicializar MediaPipe HandLandmarker en segundo plano
    const status = await this.tracker.init((s) => this.updateMpStatus(s));
    this.updateMpStatus(status);
    await this.refreshCameraDevices();
  }

  private updateMpStatus(status: { ready: boolean; delegate: 'GPU' | 'CPU' | null; error: string | null }): void {
    if (status.ready) {
      this.mpStatusDot.className = 'dot dot-ok';
      this.mpStatusText.textContent = `MediaPipe: Listo (${status.delegate})`;
    } else if (status.error) {
      this.mpStatusDot.className = 'dot dot-err';
      this.mpStatusText.textContent = `MediaPipe Error`;
      this.cameraErrorMsg.textContent = `Error cargando MediaPipe: ${status.error}`;
      this.cameraErrorMsg.classList.remove('hidden');
    } else {
      this.mpStatusDot.className = 'dot dot-warn';
      this.mpStatusText.textContent = 'MediaPipe: Cargando...';
    }
  }

  private buildKinematicsDom(): void {
    const pinchContainer = byId<HTMLElement>('pinchListContainer');
    const pinchLabels: Record<PinchTarget, string> = {
      index: 'Pulgar · Índice',
      middle: 'Pulgar · Medio',
      ring: 'Pulgar · Anular',
      pinky: 'Pulgar · Meñique',
    };

    for (const target of PINCH_KEYS) {
      const card = document.createElement('div');
      card.className = 'pinch-card';
      const top = document.createElement('div');
      top.className = 'pinch-top';
      const name = document.createElement('span');
      name.textContent = pinchLabels[target];
      const val = document.createElement('strong');
      val.textContent = '0%';
      top.append(name, val);

      const track = document.createElement('div');
      track.className = 'meter-track';
      const bar = document.createElement('div');
      bar.className = 'meter-fill fill-pinch';
      track.appendChild(bar);

      card.append(top, track);
      pinchContainer.appendChild(card);
      this.pinchRefs.set(target, { card, val, bar });
    }

    const fingersContainer = byId<HTMLElement>('fingersListContainer');
    for (const fSpec of FINGER_SPECS) {
      const card = document.createElement('div');
      card.className = 'finger-card';

      const header = document.createElement('div');
      header.className = 'finger-header';
      const name = document.createElement('span');
      name.className = 'finger-name';
      name.textContent = fSpec.label;
      const curlVal = document.createElement('span');
      curlVal.className = 'finger-curl-val';
      curlVal.textContent = 'Curl 0%';
      header.append(name, curlVal);
      this.fingerCurlRefs.set(fSpec.key, curlVal);

      const rows = document.createElement('div');
      rows.className = 'phalanx-rows';

      for (const pSpec of fSpec.phalanges) {
        const row = document.createElement('div');
        row.className = 'phalanx-row';

        const pName = document.createElement('span');
        pName.className = 'phalanx-name';
        pName.textContent = `${pSpec.label} (${pSpec.joint})`;
        pName.title = `${pSpec.label} (${pSpec.joint})`;

        const track = document.createElement('div');
        track.className = 'meter-track';
        const bar = document.createElement('div');
        bar.className = 'meter-fill fill-phalanx';
        track.appendChild(bar);

        const pVal = document.createElement('span');
        pVal.className = 'phalanx-val';
        pVal.textContent = '0° · 0.00';

        row.append(pName, track, pVal);
        rows.appendChild(row);
        this.phalanxRefs.set(`${fSpec.key}.${pSpec.key}`, { val: pVal, bar });
      }

      card.append(header, rows);
      fingersContainer.appendChild(card);
    }
  }

  private buildSynthDriverDom(): void {
    const container = byId<HTMLElement>('synthDriversContainer');
    const items: Array<{ key: 'pitch' | 'cutoff' | 'fm' | 'lfo' | 'sub'; target: string }> = [
      { key: 'pitch', target: 'Frecuencia Fundamental (Hz)' },
      { key: 'cutoff', target: 'Filtro Cutoff (Hz)' },
      { key: 'fm', target: 'Modulación FM Armónica' },
      { key: 'lfo', target: 'Vibrato LFO (Hz)' },
      { key: 'sub', target: 'Sub-Octava y Eco' },
    ];

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'driver-row';

      const head = document.createElement('div');
      head.className = 'driver-head';
      const label = document.createElement('span');
      label.textContent = item.target;
      const val = document.createElement('strong');
      val.textContent = '0%';
      head.append(label, val);

      const track = document.createElement('div');
      track.className = 'meter-track';
      const bar = document.createElement('div');
      bar.className = 'meter-fill fill-driver';
      track.appendChild(bar);

      row.append(head, track);
      container.appendChild(row);
      this.driverRefs.push({ key: item.key, label, val, bar });
    }
  }

  private bindEvents(): void {
    // Tabs del inspector
    const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
    const tabPanels = document.querySelectorAll<HTMLElement>('.tab-panel');
    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
        tabPanels.forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
      });
    });

    // Fuente: Cámara vs Simulador
    this.btnSourceCamera.addEventListener('click', () => this.setSourceMode('camera'));
    this.btnSourceSim.addEventListener('click', () => this.setSourceMode('simulator'));
    byId<HTMLButtonElement>('btnPromptUseSim').addEventListener('click', () =>
      this.setSourceMode('simulator')
    );

    // Cámara
    this.btnToggleCamera.addEventListener('click', () => this.toggleCamera());
    byId<HTMLButtonElement>('btnPromptStartCam').addEventListener('click', () => this.startCamera());
    this.cameraSelect.addEventListener('change', () => {
      if (this.cameraActive) void this.startCamera();
    });

    // Audio Toggle
    this.btnToggleAudio.addEventListener('click', async () => {
      const next = !this.synth.getConfig().enabled;
      const active = await this.synth.setEnabled(next);
      this.btnToggleAudio.classList.toggle('is-active', active);
      this.btnToggleAudio.textContent = active ? 'Audio Activo (Silenciar)' : 'Activar Audio';
    });

    // Stage Toggles
    byId<HTMLInputElement>('chkMirror').addEventListener('change', (e) => {
      this.mirrored = (e.target as HTMLInputElement).checked;
      this.videoEl.classList.toggle('mirrored', this.mirrored);
    });
    byId<HTMLInputElement>('chkShowVideo').addEventListener('change', (e) => {
      this.showVideo = (e.target as HTMLInputElement).checked;
      this.videoEl.classList.toggle('video-hidden', !this.showVideo);
    });
    byId<HTMLInputElement>('chkShowAngles').addEventListener('change', (e) => {
      this.showAngles = (e.target as HTMLInputElement).checked;
    });
    byId<HTMLInputElement>('chkShowIds').addEventListener('change', (e) => {
      this.showIds = (e.target as HTMLInputElement).checked;
    });
    byId<HTMLInputElement>('chkSwapHands').addEventListener('change', (e) => {
      this.tracker.setSwapHandedness((e.target as HTMLInputElement).checked);
    });
    byId<HTMLInputElement>('rngSmoothing').addEventListener('input', (e) => {
      this.tracker.setSmoothing(Number((e.target as HTMLInputElement).value));
    });

    // Simulador controls
    const simPreset = byId<HTMLSelectElement>('simPreset');
    simPreset.addEventListener('change', () => {
      this.simControls.preset = simPreset.value as SimulatorControls['preset'];
      this.simManualGrid.classList.toggle('hidden', this.simControls.preset !== 'manual');
    });

    const simHandsCount = byId<HTMLSelectElement>('simHandsCount');
    simHandsCount.addEventListener('change', () => {
      this.simControls.handsCount = Number(simHandsCount.value) === 2 ? 2 : 1;
    });

    byId<HTMLInputElement>('simPalmY').addEventListener('input', (e) => {
      this.simControls.palmY = Number((e.target as HTMLInputElement).value);
    });
    byId<HTMLInputElement>('simPinch').addEventListener('input', (e) => {
      this.simControls.pinchAperture = Number((e.target as HTMLInputElement).value);
    });

    const curlInputs: Array<[string, FingerKey]> = [
      ['simCurlThumb', 'thumb'],
      ['simCurlIndex', 'index'],
      ['simCurlMiddle', 'middle'],
      ['simCurlRing', 'ring'],
      ['simCurlPinky', 'pinky'],
    ];
    for (const [id, key] of curlInputs) {
      byId<HTMLInputElement>(id).addEventListener('input', (e) => {
        this.simControls.fingersCurl[key] = Number((e.target as HTMLInputElement).value);
      });
    }

    // Inspector Hand selector
    const btnAuto = byId<HTMLButtonElement>('btnInspectAuto');
    const btnRight = byId<HTMLButtonElement>('btnInspectRight');
    const btnLeft = byId<HTMLButtonElement>('btnInspectLeft');
    const setInspectPref = (pref: 'auto' | 'left' | 'right') => {
      this.inspectPreference = pref;
      btnAuto.classList.toggle('active', pref === 'auto');
      btnRight.classList.toggle('active', pref === 'right');
      btnLeft.classList.toggle('active', pref === 'left');
    };
    btnAuto.addEventListener('click', () => setInspectPref('auto'));
    btnRight.addEventListener('click', () => setInspectPref('right'));
    btnLeft.addEventListener('click', () => setInspectPref('left'));

    // Synth bindings (sincronizando barra rápida + tab detalle)
    const quickMode = byId<HTMLSelectElement>('quickSynthMode');
    const tabMode = byId<HTMLSelectElement>('synthMode');
    const onModeChange = (val: SynthMappingMode) => {
      this.synth.updateConfig({ mappingMode: val });
      quickMode.value = val;
      tabMode.value = val;
    };
    quickMode.addEventListener('change', () => onModeChange(quickMode.value as SynthMappingMode));
    tabMode.addEventListener('change', () => onModeChange(tabMode.value as SynthMappingMode));

    const quickScale = byId<HTMLSelectElement>('quickSynthScale');
    const tabScale = byId<HTMLSelectElement>('synthScale');
    const onScaleChange = (val: ScaleType) => {
      this.synth.updateConfig({ scale: val });
      quickScale.value = val;
      tabScale.value = val;
    };
    quickScale.addEventListener('change', () => onScaleChange(quickScale.value as ScaleType));
    tabScale.addEventListener('change', () => onScaleChange(tabScale.value as ScaleType));

    const quickWave = byId<HTMLSelectElement>('quickSynthWave');
    const tabWave = byId<HTMLSelectElement>('synthWaveform');
    const onWaveChange = (val: WaveformType) => {
      this.synth.updateConfig({ waveform: val });
      quickWave.value = val;
      tabWave.value = val;
    };
    quickWave.addEventListener('change', () => onWaveChange(quickWave.value as WaveformType));
    tabWave.addEventListener('change', () => onWaveChange(tabWave.value as WaveformType));

    byId<HTMLSelectElement>('synthRootNote').addEventListener('change', (e) => {
      this.synth.updateConfig({ rootNote: Number((e.target as HTMLSelectElement).value) });
    });

    byId<HTMLInputElement>('rngMasterVolume').addEventListener('input', (e) => {
      this.synth.updateConfig({ masterVolume: Number((e.target as HTMLInputElement).value) });
    });

    const rngMin = byId<HTMLInputElement>('rngMinFreq');
    const rngMax = byId<HTMLInputElement>('rngMaxFreq');
    const lblMin = byId<HTMLElement>('lblMinFreq');
    const lblMax = byId<HTMLElement>('lblMaxFreq');
    rngMin.addEventListener('input', () => {
      const min = Number(rngMin.value);
      this.synth.updateConfig({ minFreqHz: min });
      const cfg = this.synth.getConfig();
      lblMin.textContent = `${Math.round(cfg.minFreqHz)} Hz`;
      lblMax.textContent = `${Math.round(cfg.maxFreqHz)} Hz`;
      rngMax.value = String(Math.round(cfg.maxFreqHz));
    });
    rngMax.addEventListener('input', () => {
      const max = Number(rngMax.value);
      this.synth.updateConfig({ maxFreqHz: max });
      const cfg = this.synth.getConfig();
      lblMax.textContent = `${Math.round(cfg.maxFreqHz)} Hz`;
    });

    const rngGlide = byId<HTMLInputElement>('rngGlide');
    const lblGlide = byId<HTMLElement>('lblGlide');
    rngGlide.addEventListener('input', () => {
      const val = Number(rngGlide.value);
      lblGlide.textContent = `${val} ms`;
      this.synth.updateConfig({ glideMs: val });
    });

    const rngRes = byId<HTMLInputElement>('rngResonance');
    const lblRes = byId<HTMLElement>('lblResonance');
    rngRes.addEventListener('input', () => {
      const val = Number(rngRes.value);
      lblRes.textContent = val.toFixed(1);
      this.synth.updateConfig({ baseResonance: val });
    });

    byId<HTMLInputElement>('chkPinchGate').addEventListener('change', (e) => {
      this.synth.updateConfig({ pinchGate: (e.target as HTMLInputElement).checked });
    });

    // OSC Config bindings
    const applyOscTarget = () => {
      const host = byId<HTMLInputElement>('oscHost').value.trim() || '127.0.0.1';
      const port = Math.max(1, Math.min(65535, Number(byId<HTMLInputElement>('oscPort').value) || 9000));
      byId<HTMLInputElement>('oscPort').value = String(port);
      this.oscClient.updateConfig({ host, port });
    };
    byId<HTMLButtonElement>('btnApplyOsc').addEventListener('click', applyOscTarget);

    byId<HTMLSelectElement>('oscSendMode').addEventListener('change', (e) => {
      this.oscClient.updateConfig({
        sendMode: (e.target as HTMLSelectElement).value as 'bundle' | 'individual',
      });
    });

    byId<HTMLSelectElement>('oscRateHz').addEventListener('change', (e) => {
      this.oscClient.updateConfig({
        rateHz: Number((e.target as HTMLSelectElement).value),
      });
    });

    byId<HTMLInputElement>('chkOscEnabled').addEventListener('change', (e) => {
      this.oscClient.updateConfig({
        enabled: (e.target as HTMLInputElement).checked,
      });
    });

    const channelBindings: Array<[string, keyof ReturnType<OscBridgeClient['getConfig']>['channels']]> = [
      ['chkChanTriggers', 'triggers'],
      ['chkChanTriggerSubchannels', 'triggerSubchannels'],
      ['chkChanPalm', 'palm'],
      ['chkChanFingers', 'fingers'],
      ['chkChanPhalanges', 'phalanges'],
      ['chkChanLandmarks', 'landmarks'],
      ['chkChanSynth', 'synth'],
    ];
    for (const [id, key] of channelBindings) {
      byId<HTMLInputElement>(id).addEventListener('change', (e) => {
        const current = this.oscClient.getConfig().channels;
        this.oscClient.updateConfig({
          channels: {
            ...current,
            [key]: (e.target as HTMLInputElement).checked,
          },
        });
      });
    }

    byId<HTMLButtonElement>('btnSendTestOsc').addEventListener('click', () => {
      applyOscTarget();
      this.oscClient.sendTestPacket();
    });
    byId<HTMLButtonElement>('btnLoopbackOsc').addEventListener('click', () => {
      this.oscClient.runLoopbackTest();
    });
  }

  private bindTriggerEvents(): void {
    const chkShowTriggers = byId<HTMLInputElement>('chkShowTriggers');
    chkShowTriggers.addEventListener('change', () => {
      this.showTriggers = chkShowTriggers.checked;
    });

    const btnEditTriggers = byId<HTMLButtonElement>('btnEditTriggers');
    btnEditTriggers.addEventListener('click', () => {
      this.editTriggers = !this.editTriggers;
      btnEditTriggers.classList.toggle('is-active', this.editTriggers);
      btnEditTriggers.textContent = this.editTriggers ? 'Terminar Edición' : 'Editar Áreas';
      this.handCanvas.classList.toggle('is-editing', this.editTriggers);
      if (!this.editTriggers) {
        this.handCanvas.style.cursor = '';
      }
    });

    byId<HTMLButtonElement>('btnAddTrigger').addEventListener('click', () => {
      const created = this.triggerEngine.addZone();
      this.selectedTriggerId = created.id;
      this.renderTriggerZonesList();
      this.syncSelectedTriggerEditor();
    });

    const presetSelect = byId<HTMLSelectElement>('triggerPresetSelect');
    presetSelect.addEventListener('change', () => {
      const val = presetSelect.value as '' | 'default_2' | 'grid_4' | 'columns_3' | 'clear';
      if (!val) return;
      this.triggerEngine.applyPreset(val);
      this.selectedTriggerId = this.triggerEngine.getZones()[0]?.id ?? null;
      presetSelect.value = '';
      this.renderTriggerZonesList();
      this.syncSelectedTriggerEditor();
    });

    byId<HTMLButtonElement>('btnTestTriggerNow').addEventListener('click', () => {
      if (!this.selectedTriggerId) return;
      this.triggerEngine.manualTestTrigger(this.selectedTriggerId);
    });

    const updateSelected = (
      fn: (zoneId: string) => void,
      refreshList = true,
      refreshEditor = false
    ) => {
      if (!this.selectedTriggerId) return;
      fn(this.selectedTriggerId);
      if (refreshList) this.renderTriggerZonesList();
      if (refreshEditor) this.syncSelectedTriggerEditor();
    };

    byId<HTMLInputElement>('trgName').addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value;
      updateSelected((id) => this.triggerEngine.updateZone(id, { name: val }));
    });
    byId<HTMLInputElement>('trgOscAddress').addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value;
      updateSelected((id) => this.triggerEngine.updateZone(id, { oscAddress: val }));
    });
    byId<HTMLSelectElement>('trgMode').addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as TriggerMode;
      updateSelected((id) => this.triggerEngine.updateZone(id, { mode }), true, true);
    });
    byId<HTMLSelectElement>('trgTarget').addEventListener('change', (e) => {
      const target = (e.target as HTMLSelectElement).value as TriggerTarget;
      updateSelected((id) => this.triggerEngine.updateZone(id, { target }));
    });
    byId<HTMLSelectElement>('trgHandFilter').addEventListener('change', (e) => {
      const handFilter = (e.target as HTMLSelectElement).value as TriggerHandFilter;
      updateSelected((id) => this.triggerEngine.updateZone(id, { handFilter }));
    });
    byId<HTMLSelectElement>('trgShape').addEventListener('change', (e) => {
      const shape = (e.target as HTMLSelectElement).value as TriggerShape;
      updateSelected((id) => this.triggerEngine.updateZone(id, { shape }), true, true);
    });
    byId<HTMLInputElement>('trgColor').addEventListener('input', (e) => {
      const color = (e.target as HTMLInputElement).value;
      updateSelected((id) => this.triggerEngine.updateZone(id, { color }));
    });
    byId<HTMLInputElement>('chkTrgEnabled').addEventListener('change', (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      updateSelected((id) => this.triggerEngine.updateZone(id, { enabled }));
    });

    const bindRange = (
      id: string,
      labelId: string,
      formatter: (v: number) => string,
      apply: (id: string, val: number) => void
    ) => {
      byId<HTMLInputElement>(id).addEventListener('input', (e) => {
        const val = Number((e.target as HTMLInputElement).value);
        byId<HTMLElement>(labelId).textContent = formatter(val);
        updateSelected((zoneId) => apply(zoneId, val), false, false);
      });
    };

    bindRange('trgX', 'lblTrgX', (v) => v.toFixed(2), (id, x) =>
      this.triggerEngine.updateZone(id, { x })
    );
    bindRange('trgY', 'lblTrgY', (v) => v.toFixed(2), (id, y) =>
      this.triggerEngine.updateZone(id, { y })
    );
    bindRange('trgWidth', 'lblTrgWidth', (v) => v.toFixed(2), (id, width) =>
      this.triggerEngine.updateZone(id, { width })
    );
    bindRange('trgHeight', 'lblTrgHeight', (v) => v.toFixed(2), (id, height) =>
      this.triggerEngine.updateZone(id, { height })
    );
    bindRange('trgPulseMs', 'lblTrgPulseMs', (v) => `${Math.round(v)} ms`, (id, pulseDurationMs) =>
      this.triggerEngine.updateZone(id, { pulseDurationMs })
    );
    bindRange('trgCooldownMs', 'lblTrgCooldownMs', (v) => `${Math.round(v)} ms`, (id, cooldownMs) =>
      this.triggerEngine.updateZone(id, { cooldownMs })
    );
  }

  private bindTriggerCanvasInteractions(): void {
    type DragState = {
      mode: 'move' | 'resize';
      zoneId: string;
      startX: number;
      startY: number;
      origX: number;
      origY: number;
      box: ReturnType<typeof computeContainBox>;
    };
    let drag: DragState | null = null;

    const getCanvasCoords = (ev: PointerEvent | MouseEvent) => {
      const rect = this.handCanvas.getBoundingClientRect();
      return {
        x: ev.clientX - rect.left,
        y: ev.clientY - rect.top,
        w: rect.width,
        h: rect.height,
      };
    };

    this.handCanvas.addEventListener('pointerdown', (ev) => {
      if (!this.editTriggers) return;
      const pt = getCanvasCoords(ev);
      const box = computeContainBox(pt.w, pt.h, this.lastVideoAspect);
      const zones = this.triggerEngine.getZones();

      // 1. Verificar manijas de tamaño primero
      for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i];
        const geom = getZonePixelGeometry(z, box);
        const hx = z.shape === 'circle' ? geom.cx + geom.radius : geom.left + geom.w;
        const hy = z.shape === 'circle' ? geom.cy : geom.top + geom.h;
        if (Math.hypot(pt.x - hx, pt.y - hy) <= 13) {
          this.selectedTriggerId = z.id;
          this.renderTriggerZonesList();
          this.syncSelectedTriggerEditor();
          drag = {
            mode: 'resize',
            zoneId: z.id,
            startX: pt.x,
            startY: pt.y,
            origX: z.x,
            origY: z.y,
            box,
          };
          this.handCanvas.setPointerCapture(ev.pointerId);
          return;
        }
      }

      // 2. Verificar cuerpo del pulsador
      const vx = (pt.x - box.x) / Math.max(box.w, 1);
      const vy = (pt.y - box.y) / Math.max(box.h, 1);
      for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i];
        if (hitTestZoneNormalized(z, vx, vy, this.lastVideoAspect).inside) {
          this.selectedTriggerId = z.id;
          this.renderTriggerZonesList();
          this.syncSelectedTriggerEditor();
          drag = {
            mode: 'move',
            zoneId: z.id,
            startX: pt.x,
            startY: pt.y,
            origX: z.x,
            origY: z.y,
            box,
          };
          this.handCanvas.setPointerCapture(ev.pointerId);
          return;
        }
      }
    });

    this.handCanvas.addEventListener('pointermove', (ev) => {
      if (!this.editTriggers) return;
      const pt = getCanvasCoords(ev);

      if (drag) {
        const z = this.triggerEngine.getZone(drag.zoneId);
        if (!z) return;

        if (drag.mode === 'move') {
          const dx = (pt.x - drag.startX) / Math.max(drag.box.w, 1);
          const dy = (pt.y - drag.startY) / Math.max(drag.box.h, 1);
          this.triggerEngine.updateZone(drag.zoneId, {
            x: drag.origX + dx,
            y: drag.origY + dy,
          });
        } else {
          const geom = getZonePixelGeometry(z, drag.box);
          if (z.shape === 'circle') {
            const minDim = Math.min(drag.box.w, drag.box.h);
            const r = Math.hypot(pt.x - geom.cx, pt.y - geom.cy);
            this.triggerEngine.updateZone(drag.zoneId, {
              width: (r * 2) / Math.max(minDim, 1),
            });
          } else {
            const halfW = Math.abs(pt.x - geom.cx);
            const halfH = Math.abs(pt.y - geom.cy);
            this.triggerEngine.updateZone(drag.zoneId, {
              width: (halfW * 2) / Math.max(drag.box.w, 1),
              height: (halfH * 2) / Math.max(drag.box.h, 1),
            });
          }
        }
        this.syncSelectedTriggerEditor();
        return;
      }

      // Actualizar cursor al pasar por encima
      const box = computeContainBox(pt.w, pt.h, this.lastVideoAspect);
      const zones = this.triggerEngine.getZones();
      let cursor = 'crosshair';
      const vx = (pt.x - box.x) / Math.max(box.w, 1);
      const vy = (pt.y - box.y) / Math.max(box.h, 1);

      for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i];
        const geom = getZonePixelGeometry(z, box);
        const hx = z.shape === 'circle' ? geom.cx + geom.radius : geom.left + geom.w;
        const hy = z.shape === 'circle' ? geom.cy : geom.top + geom.h;
        if (Math.hypot(pt.x - hx, pt.y - hy) <= 13) {
          cursor = 'nwse-resize';
          break;
        }
        if (hitTestZoneNormalized(z, vx, vy, this.lastVideoAspect).inside) {
          cursor = 'grab';
          break;
        }
      }
      this.handCanvas.style.cursor = cursor;
    });

    const endDrag = (ev: PointerEvent) => {
      if (!drag) return;
      drag = null;
      try {
        this.handCanvas.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore if not captured
      }
    };
    this.handCanvas.addEventListener('pointerup', endDrag);
    this.handCanvas.addEventListener('pointercancel', endDrag);

    this.handCanvas.addEventListener('dblclick', (ev) => {
      if (!this.editTriggers) return;
      const pt = getCanvasCoords(ev);
      const box = computeContainBox(pt.w, pt.h, this.lastVideoAspect);
      const vx = (pt.x - box.x) / Math.max(box.w, 1);
      const vy = (pt.y - box.y) / Math.max(box.h, 1);
      if (vx < 0 || vx > 1 || vy < 0 || vy > 1) return;
      const created = this.triggerEngine.addZone({ x: vx, y: vy });
      this.selectedTriggerId = created.id;
      this.renderTriggerZonesList();
      this.syncSelectedTriggerEditor();
    });
  }

  private renderTriggerZonesList(): void {
    const listEl = byId<HTMLElement>('triggerZonesList');
    const zones = this.triggerEngine.getZones();
    this.triggerRowRefs.clear();

    if (zones.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint-text';
      empty.textContent = 'No hay pulsadores configurados. Haz clic en "+ Nuevo Pulsador".';
      listEl.replaceChildren(empty);
      return;
    }

    const modeLabels: Record<TriggerMode, string> = {
      pulse: 'Pulso',
      momentary: 'Mantener',
      toggle: 'Toggle',
    };

    const frag = document.createDocumentFragment();
    for (const z of zones) {
      const item = document.createElement('div');
      item.className = 'trigger-item';
      if (z.id === this.selectedTriggerId) item.classList.add('is-selected');

      item.addEventListener('click', () => {
        this.selectedTriggerId = z.id;
        this.renderTriggerZonesList();
        this.syncSelectedTriggerEditor();
      });

      const main = document.createElement('div');
      main.className = 'trigger-item-main';

      const swatch = document.createElement('span');
      swatch.className = 'trigger-swatch';
      swatch.style.background = z.enabled ? z.color : '#475569';

      const meta = document.createElement('div');
      meta.className = 'trigger-item-meta';

      const name = document.createElement('span');
      name.className = 'trigger-item-name';
      name.textContent = z.enabled ? z.name : `${z.name} (desactivado)`;

      const sub = document.createElement('span');
      sub.className = 'trigger-item-sub';
      sub.textContent = `${z.oscAddress} · ${modeLabels[z.mode]} · ${TRIGGER_TARGET_LABELS[z.target]}`;

      meta.append(name, sub);
      main.append(swatch, meta);

      const right = document.createElement('div');
      right.className = 'trigger-item-right';

      const pill = document.createElement('span');
      pill.className = 'trigger-state-pill';
      pill.textContent = '0';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-icon-del';
      delBtn.title = 'Eliminar pulsador';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.triggerEngine.removeZone(z.id);
        if (this.selectedTriggerId === z.id) {
          this.selectedTriggerId = this.triggerEngine.getZones()[0]?.id ?? null;
        }
        this.renderTriggerZonesList();
        this.syncSelectedTriggerEditor();
      });

      right.append(pill, delBtn);
      item.append(main, right);
      frag.appendChild(item);
      this.triggerRowRefs.set(z.id, { item, pill });
    }

    listEl.replaceChildren(frag);
  }

  private syncSelectedTriggerEditor(): void {
    const editorCard = byId<HTMLElement>('triggerEditorCard');
    const zone = this.selectedTriggerId
      ? this.triggerEngine.getZone(this.selectedTriggerId)
      : undefined;

    if (!zone) {
      editorCard.classList.add('hidden');
      return;
    }

    editorCard.classList.remove('hidden');
    byId<HTMLInputElement>('trgName').value = zone.name;
    byId<HTMLInputElement>('trgOscAddress').value = zone.oscAddress;
    byId<HTMLSelectElement>('trgMode').value = zone.mode;
    byId<HTMLSelectElement>('trgTarget').value = zone.target;
    byId<HTMLSelectElement>('trgHandFilter').value = zone.handFilter;
    byId<HTMLSelectElement>('trgShape').value = zone.shape;
    byId<HTMLInputElement>('trgColor').value = zone.color;
    byId<HTMLInputElement>('chkTrgEnabled').checked = zone.enabled;

    byId<HTMLInputElement>('trgX').value = zone.x.toFixed(2);
    byId<HTMLElement>('lblTrgX').textContent = zone.x.toFixed(2);
    byId<HTMLInputElement>('trgY').value = zone.y.toFixed(2);
    byId<HTMLElement>('lblTrgY').textContent = zone.y.toFixed(2);

    byId<HTMLInputElement>('trgWidth').value = zone.width.toFixed(2);
    byId<HTMLElement>('lblTrgWidthTitle').innerHTML =
      zone.shape === 'circle'
        ? `Diámetro: <strong id="lblTrgWidth">${zone.width.toFixed(2)}</strong>`
        : `Ancho: <strong id="lblTrgWidth">${zone.width.toFixed(2)}</strong>`;

    byId<HTMLInputElement>('trgHeight').value = zone.height.toFixed(2);
    byId<HTMLElement>('lblTrgHeight').textContent = zone.height.toFixed(2);
    byId<HTMLElement>('fieldTrgHeight').classList.toggle('hidden', zone.shape === 'circle');

    byId<HTMLInputElement>('trgPulseMs').value = String(zone.pulseDurationMs);
    byId<HTMLElement>('lblTrgPulseMs').textContent = `${zone.pulseDurationMs} ms`;
    byId<HTMLElement>('fieldTrgPulseMs').classList.toggle('hidden', zone.mode !== 'pulse');

    byId<HTMLInputElement>('trgCooldownMs').value = String(zone.cooldownMs);
    byId<HTMLElement>('lblTrgCooldownMs').textContent = `${zone.cooldownMs} ms`;
  }

  private syncSynthControlsToDom(): void {
    const cfg = this.synth.getConfig();
    byId<HTMLSelectElement>('quickSynthMode').value = cfg.mappingMode;
    byId<HTMLSelectElement>('synthMode').value = cfg.mappingMode;
    byId<HTMLSelectElement>('quickSynthScale').value = cfg.scale;
    byId<HTMLSelectElement>('synthScale').value = cfg.scale;
    byId<HTMLSelectElement>('quickSynthWave').value = cfg.waveform;
    byId<HTMLSelectElement>('synthWaveform').value = cfg.waveform;
    byId<HTMLSelectElement>('synthRootNote').value = String(cfg.rootNote);
    byId<HTMLInputElement>('rngMasterVolume').value = String(cfg.masterVolume);
    byId<HTMLInputElement>('rngMinFreq').value = String(Math.round(cfg.minFreqHz));
    byId<HTMLInputElement>('rngMaxFreq').value = String(Math.round(cfg.maxFreqHz));
    byId<HTMLElement>('lblMinFreq').textContent = `${Math.round(cfg.minFreqHz)} Hz`;
    byId<HTMLElement>('lblMaxFreq').textContent = `${Math.round(cfg.maxFreqHz)} Hz`;
  }

  private setSourceMode(mode: TrackingSourceMode): void {
    this.sourceMode = mode;
    this.tracker.resetKinematics();

    this.btnSourceCamera.classList.toggle('active', mode === 'camera');
    this.btnSourceSim.classList.toggle('active', mode === 'simulator');

    if (mode === 'simulator') {
      this.stageSourceBadge.textContent = 'SIMULADOR VIRTUAL';
      this.simulatorPanel.classList.remove('hidden');
      this.cameraPrompt.classList.add('hidden');
    } else {
      this.stageSourceBadge.textContent = 'CÁMARA MEDIAPIPE';
      this.simulatorPanel.classList.add('hidden');
      this.cameraPrompt.classList.toggle('hidden', this.cameraActive);
    }
  }

  private async refreshCameraDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');
      this.cameraSelect.innerHTML = '';
      videoInputs.forEach((dev, i) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Cámara ${i + 1}`;
        this.cameraSelect.appendChild(opt);
      });
      this.cameraSelect.classList.toggle('hidden', videoInputs.length <= 1);
    } catch {
      // ignore device enumeration permissions
    }
  }

  private async toggleCamera(): Promise<void> {
    if (this.cameraActive) {
      this.stopCamera();
    } else {
      await this.startCamera();
    }
  }

  private async startCamera(): Promise<void> {
    this.setSourceMode('camera');
    this.cameraErrorMsg.classList.add('hidden');

    if (!navigator.mediaDevices?.getUserMedia) {
      this.showCameraError(
        'Tu navegador no permite acceso a cámara en este contexto. Usa localhost/HTTPS o el Simulador Virtual.'
      );
      return;
    }

    this.stopCameraStreamOnly();

    try {
      if (!this.tracker.getStatus().ready) {
        await this.tracker.init((s) => this.updateMpStatus(s));
      }

      const selectedId = this.cameraSelect.value;
      const videoConstraints: MediaTrackConstraints = selectedId
        ? { deviceId: { exact: selectedId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });

      this.cameraStream = stream;
      this.videoEl.srcObject = stream;
      await this.videoEl.play();

      this.cameraActive = true;
      this.cameraPrompt.classList.add('hidden');
      this.btnToggleCamera.classList.add('is-active');
      this.btnToggleCamera.textContent = 'Detener Cámara';
      await this.refreshCameraDevices();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.showCameraError(
        `No se pudo acceder a la webcam (${message}). Puedes probar igualmente con el Simulador Virtual.`
      );
    }
  }

  private stopCameraStreamOnly(): void {
    if (this.cameraStream) {
      for (const track of this.cameraStream.getTracks()) {
        track.stop();
      }
      this.cameraStream = null;
    }
    this.videoEl.srcObject = null;
  }

  private stopCamera(): void {
    this.stopCameraStreamOnly();
    this.cameraActive = false;
    this.tracker.resetKinematics();
    this.btnToggleCamera.classList.remove('is-active');
    this.btnToggleCamera.textContent = 'Iniciar Cámara';
    if (this.sourceMode === 'camera') {
      this.cameraPrompt.classList.remove('hidden');
    }
  }

  private showCameraError(msg: string): void {
    this.cameraErrorMsg.textContent = msg;
    this.cameraErrorMsg.classList.remove('hidden');
  }

  private startMainLoop(): void {
    const tick = (nowMs: number) => {
      this.rafId = requestAnimationFrame(tick);
      this.stepFrame(nowMs);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stepFrame(nowMs: number): void {
    // FPS counter
    this.fpsFrames += 1;
    if (nowMs - this.fpsLastTime >= 500) {
      this.currentFps = Math.round((this.fpsFrames * 1000) / (nowMs - this.fpsLastTime));
      this.fpsText.textContent = `${this.currentFps} FPS`;
      this.fpsFrames = 0;
      this.fpsLastTime = nowMs;
    }

    // 1. Tracking frame
    let frame: TrackingFrame;
    let videoAspect = 16 / 9;

    if (this.sourceMode === 'simulator') {
      frame = this.tracker.simulateFrame(this.simControls, nowMs);
    } else if (this.cameraActive && this.videoEl.readyState >= 2) {
      videoAspect = this.videoEl.videoWidth / Math.max(this.videoEl.videoHeight, 1);
      frame = this.tracker.detectVideoFrame(this.videoEl, nowMs);
    } else {
      frame = {
        timestamp: nowMs,
        source: 'camera',
        hands: [],
        left: null,
        right: null,
      };
    }

    this.lastVideoAspect = videoAspect;
    const effectiveMirrored = this.sourceMode === 'camera' ? this.mirrored : false;

    // 2. Evaluación espacial de Pulsadores + Audio synth update
    const triggers = this.triggerEngine.evaluate(frame, effectiveMirrored, videoAspect);
    const synthTelemetry = this.synth.updateFromTracking(frame);

    // 3. Render overlays (Vision + Pulsadores + Audio FFT/Oscilloscope)
    renderHandOverlay(this.handCanvas, frame, synthTelemetry, triggers, {
      mirrored: effectiveMirrored,
      showLandmarkIds: this.showIds,
      showPhalanxAngles: this.showAngles,
      showPitchGuides: true,
      showTriggers: this.showTriggers,
      editTriggers: this.editTriggers,
      selectedTriggerId: this.selectedTriggerId,
      videoAspect,
    });

    this.visualizer.render(
      this.audioCanvas,
      this.synth.getAnalyser(),
      this.synth.getSampleRate(),
      synthTelemetry
    );

    // 4. OSC TX (envío inmediato si algún pulsador cambió de estado)
    let triggerEdge = false;
    for (const ev of triggers) {
      const prev = this.lastTriggerValues.get(ev.zone.id);
      if (ev.justTriggered || (prev !== undefined && prev !== ev.value)) {
        triggerEdge = true;
      }
      this.lastTriggerValues.set(ev.zone.id, ev.value);
    }

    const oscCfg = this.oscClient.getConfig();
    const oscMessages = buildOscMessages(frame, synthTelemetry, oscCfg.channels, triggers);
    this.oscClient.sendBatch(oscMessages, nowMs, triggerEdge);

    // 5. UI telemetry (~30Hz max para DOM liviano, OSC Monitor ~10Hz)
    if (nowMs - this.lastUiTelemetryTime >= 32) {
      this.lastUiTelemetryTime = nowMs;
      this.updateTelemetryDom(frame, synthTelemetry, triggers);
    }

    if (nowMs - this.lastOscMonitorTime >= 110) {
      this.lastOscMonitorTime = nowMs;
      this.updateOscMonitorDom(oscMessages);
    }
  }

  private pickInspectedHand(frame: TrackingFrame): HandKinematics | null {
    if (this.inspectPreference === 'right') return frame.right;
    if (this.inspectPreference === 'left') return frame.left;
    return frame.right ?? frame.left ?? null;
  }

  private updateTelemetryDom(
    frame: TrackingFrame,
    synth: SynthTelemetry,
    triggers: TriggerEvaluation[]
  ): void {
    for (const ev of triggers) {
      const ref = this.triggerRowRefs.get(ev.zone.id);
      if (!ref) continue;
      ref.item.classList.toggle('is-active', ev.active);
      ref.pill.textContent = `${ev.value} · #${ev.hitCount}`;
    }

    const count = frame.hands.length;
    this.handsDetectedBadge.textContent =
      count === 1 ? '1 mano detectada' : `${count} manos detectadas`;

    // Synth readouts
    const freqText = `${synth.quantizedFreqHz.toFixed(1)} Hz`;
    this.readoutFreqHz.textContent = freqText;
    this.readoutNote.textContent = synth.noteName;
    this.freqHeaderText.textContent = `${freqText} · ${synth.noteName}`;

    this.readoutCutoff.textContent = `${Math.round(synth.cutoffHz)} Hz (Q ${synth.resonanceQ.toFixed(1)})`;
    this.readoutFm.textContent = `${Math.round(synth.fmDepthHz)} Hz`;
    this.readoutLfo.textContent = `${synth.lfoRateHz.toFixed(1)} Hz · ±${Math.round(synth.lfoDepthHz)} Hz`;
    this.readoutGain.textContent = synth.active
      ? `${Math.round(synth.gain * 100)}%`
      : 'Silenciado';

    // Synth driver meters
    const driverMap = {
      pitch: { text: `${synth.driverValues.pitchDriverLabel} → ${synth.quantizedFreqHz.toFixed(1)} Hz`, norm: synth.driverValues.pitchDriverNorm },
      cutoff: { text: `${synth.driverValues.cutoffDriverLabel} → ${Math.round(synth.cutoffHz)} Hz`, norm: synth.driverValues.cutoffDriverNorm },
      fm: { text: `${synth.driverValues.fmDriverLabel} → ${Math.round(synth.fmDepthHz)} Hz`, norm: synth.driverValues.fmDriverNorm },
      lfo: { text: `${synth.driverValues.lfoDriverLabel} → ${synth.lfoRateHz.toFixed(1)} Hz`, norm: synth.driverValues.lfoDriverNorm },
      sub: { text: `${synth.driverValues.subDriverLabel} → ${Math.round(synth.subMix * 100)}%`, norm: synth.driverValues.subDriverNorm },
    };

    for (const ref of this.driverRefs) {
      const d = driverMap[ref.key];
      ref.val.textContent = d.text;
      ref.bar.style.width = `${Math.round(d.norm * 100)}%`;
    }

    // Hand kinematics meters
    const hand = this.pickInspectedHand(frame);
    if (!hand) {
      this.inspectedHandBadge.textContent = 'Sin mano';
      this.palmXyzText.textContent = '—';
      this.palmOpenText.textContent = '0%';
      this.palmOrientText.textContent = '0° / 0° / 0°';
      this.palmVelText.textContent = '0.00';

      for (const target of PINCH_KEYS) {
        const ref = this.pinchRefs.get(target);
        if (!ref) continue;
        ref.card.classList.remove('is-pinched');
        ref.val.textContent = '0%';
        ref.bar.style.width = '0%';
      }

      for (const fKey of FINGER_KEYS) {
        const curlEl = this.fingerCurlRefs.get(fKey);
        if (curlEl) curlEl.textContent = 'Curl 0%';
        for (const pKey of PHALANX_KEYS) {
          const pRef = this.phalanxRefs.get(`${fKey}.${pKey}`);
          if (!pRef) continue;
          pRef.val.textContent = '0° · 0.00';
          pRef.bar.style.width = '0%';
        }
      }
      return;
    }

    this.inspectedHandBadge.textContent =
      hand.side === 'right'
        ? `Derecha (${Math.round(hand.score * 100)}%)`
        : `Izquierda (${Math.round(hand.score * 100)}%)`;

    this.palmXyzText.textContent = `${hand.palmCenter.x.toFixed(2)}, ${hand.palmCenter.y.toFixed(2)}, ${hand.palmCenter.z.toFixed(2)}`;
    this.palmOpenText.textContent = `${Math.round(hand.palmOpenness * 100)}%`;
    this.palmOrientText.textContent = `${Math.round(hand.palmOrientation.pitch)}° / ${Math.round(hand.palmOrientation.yaw)}° / ${Math.round(hand.palmOrientation.roll)}°`;
    this.palmVelText.textContent = hand.palmVelocity.toFixed(2);

    for (const target of PINCH_KEYS) {
      const pinch = hand.pinches[target];
      const ref = this.pinchRefs.get(target);
      if (!ref) continue;
      ref.card.classList.toggle('is-pinched', pinch.active);
      const pct = Math.round(pinch.closeness * 100);
      ref.val.textContent = pinch.active ? `${pct}% ACTIVO` : `${pct}%`;
      ref.bar.style.width = `${pct}%`;
    }

    for (const fKey of FINGER_KEYS) {
      const finger = hand.fingers[fKey];
      const curlEl = this.fingerCurlRefs.get(fKey);
      if (curlEl) curlEl.textContent = `Curl ${Math.round(finger.curl * 100)}%`;

      for (const pKey of PHALANX_KEYS) {
        const phalanx = finger.phalanges[pKey];
        const pRef = this.phalanxRefs.get(`${fKey}.${pKey}`);
        if (!pRef) continue;
        pRef.val.textContent = `${Math.round(phalanx.angleDeg)}° · ${phalanx.flex.toFixed(2)}`;
        pRef.bar.style.width = `${Math.round(phalanx.flex * 100)}%`;
      }
    }
  }

  private updateOscStatsUi(stats: OscStats): void {
    const oscEnabled = this.oscClient.getConfig().enabled;
    if (!stats.wsConnected) {
      this.oscStatusDot.className = 'dot dot-err';
      this.oscStatusText.textContent = 'OSC: Puente desconectado';
      this.oscBridgeState.textContent = 'Desconectado';
    } else if (stats.lastError) {
      this.oscStatusDot.className = 'dot dot-err';
      this.oscStatusText.textContent = `OSC Error: ${stats.lastError}`;
      this.oscBridgeState.textContent = `Error: ${stats.lastError}`;
    } else if (!oscEnabled) {
      this.oscStatusDot.className = 'dot dot-warn';
      this.oscStatusText.textContent = `OSC: Pausado (${stats.targetHost}:${stats.targetPort})`;
      this.oscBridgeState.textContent = 'Pausado';
    } else {
      this.oscStatusDot.className = 'dot dot-ok';
      this.oscStatusText.textContent = `OSC ${stats.targetHost}:${stats.targetPort} · ${stats.messagesPerSec} msg/s`;
      this.oscBridgeState.textContent = `UDP Activo (${stats.sendMode})`;
    }

    this.oscMsgRate.textContent = `${stats.messagesPerSec} msg/s`;
    this.oscPacketsTotal.textContent = stats.packetsSent.toLocaleString('es-ES');
    this.oscBytesTotal.textContent =
      stats.bytesSent > 1024 * 1024
        ? `${(stats.bytesSent / (1024 * 1024)).toFixed(2)} MB`
        : stats.bytesSent > 1024
          ? `${(stats.bytesSent / 1024).toFixed(1)} KB`
          : `${stats.bytesSent} B`;
  }

  private updateOscMonitorDom(messages: OscMessageItem[]): void {
    // Mostrar hasta 42 mensajes representativos en el monitor en vivo sin saturar el DOM
    const maxRows = 42;
    const slice = messages.slice(0, maxRows);
    const frag = document.createDocumentFragment();

    for (const msg of slice) {
      const preview = formatOscMessagePreview(msg);
      const row = document.createElement('div');
      row.className = 'osc-msg-row';

      const addr = document.createElement('span');
      addr.className = 'osc-addr';
      addr.textContent = preview.address;
      addr.title = preview.address;

      const type = document.createElement('span');
      type.className = 'osc-type';
      type.textContent = preview.types;

      const vals = document.createElement('span');
      vals.className = 'osc-vals';
      vals.textContent = preview.values;
      vals.title = preview.values;

      row.append(addr, type, vals);
      frag.appendChild(row);
    }

    if (messages.length > maxRows) {
      const more = document.createElement('div');
      more.className = 'hint-text';
      more.textContent = `+ ${messages.length - maxRows} mensajes OSC adicionales en este frame...`;
      frag.appendChild(more);
    }

    this.oscMonitorList.replaceChildren(frag);
  }

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.stopCamera();
    this.tracker.dispose();
    this.synth.dispose();
    this.oscClient.dispose();
  }
}

const app = new HandOscApp();
void app.boot();
window.addEventListener('beforeunload', () => app.dispose());

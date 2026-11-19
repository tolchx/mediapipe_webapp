import './styles.css';
import type {
  FingerKey,
  GestureDetectionFrame,
  HandKinematics,
  OscMessageItem,
  OscStats,
  PhalanxKey,
  PinchTarget,
  PoseJointAngles,
  ScaleType,
  SimulatorControls,
  SynthMappingMode,
  SynthTelemetry,
  TrackingFrame,
  TrackingPipelineMode,
  TrackingSourceMode,
  TriggerEvaluation,
  TriggerHandFilter,
  TriggerMode,
  TriggerShape,
  TriggerTarget,
  WaveformType,
} from './types/hand';
import { FINGER_SPECS } from './vision/handKinematics';
import { HandTrackerService, type TrackerInitStatus } from './vision/handTracker';
import { GestureDetectorEngine } from './vision/gestureEngine';
import { renderHandOverlay, type DraftZoneBox } from './vision/handRenderer';
import {
  TRIGGER_TARGET_LABELS,
  TriggerZoneEngine,
  computeContainBox,
  getZoneHandles,
  getZonePixelGeometry,
  hitTestZoneNormalized,
  type ZoneHandleId,
} from './vision/triggerZones';
import { GestureSynthEngine } from './audio/synthEngine';
import { AudioVisualizer } from './audio/audioVisualizer';
import { OscBridgeClient } from './osc/oscClient';
import {
  buildGestureOscMessages,
  buildOscMessages,
  buildSkeletonOscMessages,
  formatOscMessagePreview,
} from './osc/oscProtocol';

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
  private gestureEngine = new GestureDetectorEngine();
  private synth = new GestureSynthEngine();
  private visualizer = new AudioVisualizer();
  private oscClient = new OscBridgeClient();
  private triggerEngine = new TriggerZoneEngine();

  private sourceMode: TrackingSourceMode = 'camera';
  private cameraActive = false;
  private cameraStream: MediaStream | null = null;
  private mirrored = true;
  private showVideo = true;
  private showPoseSkeleton = true;
  private showAngles = true;
  private showIds = false;
  private showTriggers = true;
  private editTriggers = true;
  private selectedTriggerId: string | null = null;
  private hoveredTriggerId: string | null = null;
  private draftZone: DraftZoneBox | null = null;
  private isDraggingZone = false;
  private lastVideoAspect = 16 / 9;
  private lastTriggerValues = new Map<string, number>();
  private lastGestureActiveMap = new Map<string, boolean>();
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

  private oscBridgeRow = byId<HTMLElement>('oscBridgeRow');
  private oscBridgeUrl = byId<HTMLInputElement>('oscBridgeUrl');
  private oscBridgeState = byId<HTMLElement>('oscBridgeState');
  private oscMsgRate = byId<HTMLElement>('oscMsgRate');
  private oscPacketsTotal = byId<HTMLElement>('oscPacketsTotal');
  private oscBytesTotal = byId<HTMLElement>('oscBytesTotal');
  private oscTestResult = byId<HTMLElement>('oscTestResult');
  private oscMonitorList = byId<HTMLElement>('oscMonitorList');
  private mainOscStatusPill = byId<HTMLElement>('mainOscStatusPill');

  private poseStatusBadge = byId<HTMLElement>('poseStatusBadge');
  private poseVisBadge = byId<HTMLElement>('poseVisBadge');
  private poseCenterText = byId<HTMLElement>('poseCenterText');
  private poseLeanText = byId<HTMLElement>('poseLeanText');
  private skelOscStatusPill = byId<HTMLElement>('skelOscStatusPill');
  private skelOscMsgRate = byId<HTMLElement>('skelOscMsgRate');
  private skelOscPacketsTotal = byId<HTMLElement>('skelOscPacketsTotal');
  private skelOscTestResult = byId<HTMLElement>('skelOscTestResult');
  private skelOscMonitorList = byId<HTMLElement>('skelOscMonitorList');

  private gesturesActiveBadge = byId<HTMLElement>('gesturesActiveBadge');
  private topGestureLeftText = byId<HTMLElement>('topGestureLeftText');
  private topGestureRightText = byId<HTMLElement>('topGestureRightText');
  private gestureEventLog = byId<HTMLElement>('gestureEventLog');
  private gestOscStatusPill = byId<HTMLElement>('gestOscStatusPill');
  private gestOscMsgRate = byId<HTMLElement>('gestOscMsgRate');
  private gestOscPacketsTotal = byId<HTMLElement>('gestOscPacketsTotal');
  private gestOscTestResult = byId<HTMLElement>('gestOscTestResult');
  private gestOscMonitorList = byId<HTMLElement>('gestOscMonitorList');

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
  private poseAngleRefs = new Map<keyof PoseJointAngles, { val: HTMLElement; bar: HTMLElement }>();
  private gestureRowRefs = new Map<
    string,
    {
      row: HTMLElement;
      side: string;
      chk: HTMLInputElement;
      scoreVal: HTMLElement;
      bar: HTMLElement;
    }
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
    this.buildPoseAnglesDom();
    this.buildGesturesDom();
    this.buildSynthDriverDom();
    this.selectedTriggerId = this.triggerEngine.getZones()[0]?.id ?? null;
    this.renderTriggerZonesList();
    this.syncSelectedTriggerEditor();
    this.bindEvents();
    this.bindTriggerEvents();
    this.bindTriggerCanvasInteractions();
    this.bindSkeletonModuleEvents();
    this.bindGesturesModuleEvents();
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
      const targetEl =
        info.module === 'gestures'
          ? this.gestOscTestResult
          : info.module === 'skeleton'
            ? this.skelOscTestResult
            : this.oscTestResult;
      targetEl.classList.remove('hidden');
      targetEl.textContent = `[TX Test OK] Enviados ${info.count} mensajes OSC a ${info.host}:${info.port}`;
    });
    this.oscClient.connect();

    this.startMainLoop();

    // Inicializar MediaPipe (GestureRecognizer + PoseLandmarker) en segundo plano
    const status = await this.tracker.init((s) => this.updateMpStatus(s));
    this.updateMpStatus(status);
    await this.refreshCameraDevices();
  }

  private updateMpStatus(status: TrackerInitStatus): void {
    if (status.ready) {
      this.mpStatusDot.className = 'dot dot-ok';
      const parts: string[] = [];
      if (status.gesturesReady) parts.push('Gestos');
      else if (status.handsReady) parts.push('Manos');
      if (status.poseReady) parts.push('Pose');
      this.mpStatusText.textContent = `MediaPipe: Listo (${status.delegate} · ${parts.join(' + ')})`;
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

  private buildPoseAnglesDom(): void {
    const grid = byId<HTMLElement>('poseAnglesGrid');
    const joints: Array<{ key: keyof PoseJointAngles; label: string }> = [
      { key: 'leftElbow', label: 'Codo Izquierdo' },
      { key: 'rightElbow', label: 'Codo Derecho' },
      { key: 'leftShoulder', label: 'Hombro Izquierdo' },
      { key: 'rightShoulder', label: 'Hombro Derecho' },
      { key: 'leftHip', label: 'Cadera Izquierda' },
      { key: 'rightHip', label: 'Cadera Derecha' },
      { key: 'leftKnee', label: 'Rodilla Izquierda' },
      { key: 'rightKnee', label: 'Rodilla Derecha' },
    ];

    for (const j of joints) {
      const card = document.createElement('div');
      card.className = 'pose-angle-card';
      const head = document.createElement('div');
      head.className = 'pose-angle-head';
      const lbl = document.createElement('span');
      lbl.textContent = j.label;
      const val = document.createElement('strong');
      val.textContent = '180°';
      head.append(lbl, val);

      const track = document.createElement('div');
      track.className = 'meter-track';
      const bar = document.createElement('div');
      bar.className = 'meter-fill fill-driver';
      track.appendChild(bar);

      card.append(head, track);
      grid.appendChild(card);
      this.poseAngleRefs.set(j.key, { val, bar });
    }
  }

  private buildGesturesDom(): void {
    const container = byId<HTMLElement>('gestureListContainer');
    const initial = this.gestureEngine.evaluate({
      timestamp: 0,
      source: 'camera',
      hands: [],
      left: null,
      right: null,
      poses: [],
      rawGestures: [],
    });

    const sourceNames: Record<string, string> = {
      mediapipe: 'MediaPipe',
      hand_kinematic: 'Mano 3D',
      pose: 'Pose',
    };

    const frag = document.createDocumentFragment();
    for (const item of initial.items) {
      const row = document.createElement('div');
      row.className = 'gesture-row';
      if (!item.enabled) row.classList.add('is-disabled');

      const top = document.createElement('div');
      top.className = 'gesture-row-top';

      const left = document.createElement('div');
      left.className = 'gesture-row-left';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = item.enabled;
      chk.title = 'Incluir gesto en salida OSC';
      chk.addEventListener('change', () => {
        this.gestureEngine.setGestureEnabled(item.id, chk.checked);
        row.classList.toggle('is-disabled', !chk.checked);
      });

      const title = document.createElement('span');
      title.className = 'gesture-title';
      title.textContent = item.label;
      title.title = item.description;

      const srcPill = document.createElement('span');
      srcPill.className = 'gesture-source-pill';
      srcPill.textContent = sourceNames[item.source] ?? item.source;

      left.append(chk, title, srcPill);

      const right = document.createElement('div');
      right.className = 'gesture-row-right';
      const scoreVal = document.createElement('span');
      scoreVal.className = 'gesture-score-val';
      scoreVal.textContent = '0% · #0';
      right.appendChild(scoreVal);

      top.append(left, right);

      const track = document.createElement('div');
      track.className = 'meter-track';
      const bar = document.createElement('div');
      bar.className = 'meter-fill fill-pinch';
      track.appendChild(bar);

      const addr = document.createElement('span');
      addr.className = 'gesture-osc-addr';
      addr.textContent = item.oscAddress;

      row.append(top, track, addr);
      frag.appendChild(row);
      this.gestureRowRefs.set(item.id, { row, side: item.side, chk, scoreVal, bar });
    }

    container.replaceChildren(frag);
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
    byId<HTMLSelectElement>('pipelineModeSelect').addEventListener('change', (e) => {
      const mode = (e.target as HTMLSelectElement).value as TrackingPipelineMode;
      this.tracker.setPipelineMode(mode);
    });
    byId<HTMLInputElement>('chkMirror').addEventListener('change', (e) => {
      this.mirrored = (e.target as HTMLInputElement).checked;
      this.videoEl.classList.toggle('mirrored', this.mirrored);
    });
    byId<HTMLInputElement>('chkShowVideo').addEventListener('change', (e) => {
      this.showVideo = (e.target as HTMLInputElement).checked;
      this.videoEl.classList.toggle('video-hidden', !this.showVideo);
    });
    byId<HTMLInputElement>('chkShowPose').addEventListener('change', (e) => {
      this.showPoseSkeleton = (e.target as HTMLInputElement).checked;
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

    byId<HTMLButtonElement>('btnConnectBridge').addEventListener('click', () => {
      const wsUrl = this.oscBridgeUrl.value.trim();
      if (!wsUrl) return;
      this.oscTestResult.classList.add('hidden');
      this.oscClient.connect(wsUrl);
    });

    byId<HTMLButtonElement>('btnSendTestOsc').addEventListener('click', () => {
      applyOscTarget();
      if (!this.oscClient.sendTestPacket('main')) {
        this.oscTestResult.classList.remove('hidden');
        this.oscTestResult.textContent =
          '[Modo Web] No hay puente UDP conectado. Para enviar datagramas OSC reales a TouchDesigner, ejecuta el servidor local (npm start) o conecta un puente WebSocket local.';
      }
    });
    byId<HTMLButtonElement>('btnLoopbackOsc').addEventListener('click', () => {
      if (!this.oscClient.runLoopbackTest()) {
        this.oscTestResult.classList.remove('hidden');
        this.oscTestResult.textContent =
          '[Modo Web] El loopback UDP requiere el puente Node.js local activo (npm start).';
      }
    });
  }

  private bindSkeletonModuleEvents(): void {
    const applySkelTarget = () => {
      const host = byId<HTMLInputElement>('skelOscHost').value.trim() || '127.0.0.1';
      const port = Math.max(
        1,
        Math.min(65535, Number(byId<HTMLInputElement>('skelOscPort').value) || 9002)
      );
      byId<HTMLInputElement>('skelOscPort').value = String(port);
      this.oscClient.updateSkeletonConfig({ host, port });
      this.skelOscStatusPill.textContent = `Puerto ${port}`;
    };

    byId<HTMLButtonElement>('btnApplySkelOsc').addEventListener('click', applySkelTarget);
    byId<HTMLSelectElement>('skelOscSendMode').addEventListener('change', (e) => {
      this.oscClient.updateSkeletonConfig({
        sendMode: (e.target as HTMLSelectElement).value as 'bundle' | 'individual',
      });
    });
    byId<HTMLSelectElement>('skelOscRateHz').addEventListener('change', (e) => {
      this.oscClient.updateSkeletonConfig({
        rateHz: Number((e.target as HTMLSelectElement).value),
      });
    });
    byId<HTMLInputElement>('chkSkelOscEnabled').addEventListener('change', (e) => {
      this.oscClient.updateSkeletonConfig({
        enabled: (e.target as HTMLInputElement).checked,
      });
    });

    const skelChannels: Array<
      [string, keyof ReturnType<OscBridgeClient['getSkeletonConfig']>['channels']]
    > = [
      ['chkSkelChanJoints', 'namedJoints'],
      ['chkSkelChanAngles', 'angles'],
      ['chkSkelChanTorso', 'torsoMetrics'],
      ['chkSkelChanLandmarks', 'landmarks'],
      ['chkSkelChanWorld', 'worldLandmarks'],
    ];
    for (const [id, key] of skelChannels) {
      byId<HTMLInputElement>(id).addEventListener('change', (e) => {
        const cur = this.oscClient.getSkeletonConfig().channels;
        this.oscClient.updateSkeletonConfig({
          channels: { ...cur, [key]: (e.target as HTMLInputElement).checked },
        });
      });
    }

    byId<HTMLButtonElement>('btnTestSkelOsc').addEventListener('click', () => {
      applySkelTarget();
      if (!this.oscClient.sendTestPacket('skeleton')) {
        this.skelOscTestResult.classList.remove('hidden');
        this.skelOscTestResult.textContent =
          '[Modo Web] Conecta el puente Node.js local para enviar OSC de Esqueleto por UDP.';
      }
    });
  }

  private bindGesturesModuleEvents(): void {
    const filterButtons = document.querySelectorAll<HTMLButtonElement>('[data-gfilter]');
    filterButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const f = (btn.dataset.gfilter || 'all') as 'all' | 'right' | 'left' | 'body';
        filterButtons.forEach((b) => b.classList.toggle('active', b === btn));
        for (const ref of this.gestureRowRefs.values()) {
          const visible = f === 'all' || ref.side === f;
          ref.row.classList.toggle('hidden', !visible);
        }
      });
    });

    byId<HTMLButtonElement>('btnGestEnableAll').addEventListener('click', () => {
      this.gestureEngine.setAllEnabled(true);
      for (const ref of this.gestureRowRefs.values()) {
        ref.chk.checked = true;
        ref.row.classList.remove('is-disabled');
      }
    });
    byId<HTMLButtonElement>('btnGestDisableAll').addEventListener('click', () => {
      this.gestureEngine.setAllEnabled(false);
      for (const ref of this.gestureRowRefs.values()) {
        ref.chk.checked = false;
        ref.row.classList.add('is-disabled');
      }
    });
    byId<HTMLButtonElement>('btnClearGestureEvents').addEventListener('click', () => {
      this.gestureEngine.clearEvents();
      this.gestureEventLog.replaceChildren();
    });

    const applyGestTarget = () => {
      const host = byId<HTMLInputElement>('gestOscHost').value.trim() || '127.0.0.1';
      const port = Math.max(
        1,
        Math.min(65535, Number(byId<HTMLInputElement>('gestOscPort').value) || 9001)
      );
      byId<HTMLInputElement>('gestOscPort').value = String(port);
      this.oscClient.updateGesturesConfig({ host, port });
      this.gestOscStatusPill.textContent = `Puerto ${port}`;
    };

    byId<HTMLButtonElement>('btnApplyGestOsc').addEventListener('click', applyGestTarget);
    byId<HTMLSelectElement>('gestOscSendMode').addEventListener('change', (e) => {
      this.oscClient.updateGesturesConfig({
        sendMode: (e.target as HTMLSelectElement).value as 'bundle' | 'individual',
      });
    });
    byId<HTMLSelectElement>('gestOscRateHz').addEventListener('change', (e) => {
      this.oscClient.updateGesturesConfig({
        rateHz: Number((e.target as HTMLSelectElement).value),
      });
    });
    byId<HTMLInputElement>('chkGestOscEnabled').addEventListener('change', (e) => {
      this.oscClient.updateGesturesConfig({
        enabled: (e.target as HTMLInputElement).checked,
      });
    });

    const gestChannels: Array<
      [string, keyof ReturnType<OscBridgeClient['getGesturesConfig']>['channels']]
    > = [
      ['chkGestChanTop', 'sendTopGesture'],
      ['chkGestChanScores', 'sendScores'],
      ['chkGestChanOnlyActive', 'onlyActiveOrChanged'],
    ];
    for (const [id, key] of gestChannels) {
      byId<HTMLInputElement>(id).addEventListener('change', (e) => {
        const cur = this.oscClient.getGesturesConfig().channels;
        this.oscClient.updateGesturesConfig({
          channels: { ...cur, [key]: (e.target as HTMLInputElement).checked },
        });
      });
    }

    byId<HTMLButtonElement>('btnTestGestOsc').addEventListener('click', () => {
      applyGestTarget();
      if (!this.oscClient.sendTestPacket('gestures')) {
        this.gestOscTestResult.classList.remove('hidden');
        this.gestOscTestResult.textContent =
          '[Modo Web] Conecta el puente Node.js local para enviar OSC de Gestos por UDP.';
      }
    });
  }

  private bindTriggerEvents(): void {
    const chkShowTriggers = byId<HTMLInputElement>('chkShowTriggers');
    chkShowTriggers.addEventListener('change', () => {
      this.showTriggers = chkShowTriggers.checked;
      this.updateZoneQuickHud();
    });

    const btnEditTriggers = byId<HTMLButtonElement>('btnEditTriggers');
    const editHint = byId<HTMLElement>('viewportEditHint');
    btnEditTriggers.addEventListener('click', () => {
      this.editTriggers = !this.editTriggers;
      btnEditTriggers.classList.toggle('is-active', this.editTriggers);
      btnEditTriggers.textContent = this.editTriggers ? 'Edición Mouse: ON' : 'Edición Bloqueada';
      this.handCanvas.classList.toggle('is-editing', this.editTriggers);
      editHint.classList.toggle('hidden', !this.editTriggers);
      if (!this.editTriggers) {
        this.handCanvas.style.cursor = '';
        this.hoveredTriggerId = null;
      }
      this.updateZoneQuickHud();
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
      else this.updateZoneQuickHud();
    };

    // Floating Quick HUD sobre el visor
    byId<HTMLInputElement>('hudZoneOsc').addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value;
      updateSelected((id) => this.triggerEngine.updateZone(id, { oscAddress: val }), true, true);
    });
    byId<HTMLButtonElement>('hudZoneMode').addEventListener('click', () => {
      const zone = this.selectedTriggerId ? this.triggerEngine.getZone(this.selectedTriggerId) : null;
      if (!zone) return;
      const order: TriggerMode[] = ['pulse', 'momentary', 'toggle'];
      const next = order[(order.indexOf(zone.mode) + 1) % order.length];
      updateSelected((id) => this.triggerEngine.updateZone(id, { mode: next }), true, true);
    });
    byId<HTMLButtonElement>('hudZoneShape').addEventListener('click', () => {
      const zone = this.selectedTriggerId ? this.triggerEngine.getZone(this.selectedTriggerId) : null;
      if (!zone) return;
      const next: TriggerShape = zone.shape === 'rect' ? 'circle' : 'rect';
      updateSelected((id) => this.triggerEngine.updateZone(id, { shape: next }), true, true);
    });
    byId<HTMLSelectElement>('hudZoneTarget').addEventListener('change', (e) => {
      const target = (e.target as HTMLSelectElement).value as TriggerTarget;
      updateSelected((id) => this.triggerEngine.updateZone(id, { target }), true, true);
    });
    byId<HTMLButtonElement>('hudZoneDuplicate').addEventListener('click', () => {
      const zone = this.selectedTriggerId ? this.triggerEngine.getZone(this.selectedTriggerId) : null;
      if (!zone) return;
      const copy = this.triggerEngine.addZone({
        ...zone,
        id: undefined,
        name: `${zone.name} copia`,
        x: Math.min(0.92, zone.x + 0.05),
        y: Math.min(0.92, zone.y + 0.05),
        oscAddress: `${zone.oscAddress}_2`,
      });
      this.selectedTriggerId = copy.id;
      this.renderTriggerZonesList();
      this.syncSelectedTriggerEditor();
    });
    byId<HTMLButtonElement>('hudZoneDelete').addEventListener('click', () => {
      if (!this.selectedTriggerId) return;
      this.triggerEngine.removeZone(this.selectedTriggerId);
      this.selectedTriggerId = this.triggerEngine.getZones()[0]?.id ?? null;
      this.renderTriggerZonesList();
      this.syncSelectedTriggerEditor();
    });

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

    // Atajos de teclado cuando se edita una zona (flechas mueven, Supr elimina)
    window.addEventListener('keydown', (ev) => {
      if (!this.editTriggers || !this.selectedTriggerId) return;
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'select' || activeTag === 'textarea') return;

      const z = this.triggerEngine.getZone(this.selectedTriggerId);
      if (!z) return;
      const step = ev.shiftKey ? 0.04 : 0.01;

      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        this.triggerEngine.updateZone(z.id, { x: z.x - step });
        this.syncSelectedTriggerEditor();
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        this.triggerEngine.updateZone(z.id, { x: z.x + step });
        this.syncSelectedTriggerEditor();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        this.triggerEngine.updateZone(z.id, { y: z.y - step });
        this.syncSelectedTriggerEditor();
      } else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        this.triggerEngine.updateZone(z.id, { y: z.y + step });
        this.syncSelectedTriggerEditor();
      } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        this.triggerEngine.removeZone(z.id);
        this.selectedTriggerId = this.triggerEngine.getZones()[0]?.id ?? null;
        this.renderTriggerZonesList();
        this.syncSelectedTriggerEditor();
      }
    });

    window.addEventListener('resize', () => this.updateZoneQuickHud());
  }

  private bindTriggerCanvasInteractions(): void {
    type DragState =
      | {
          mode: 'move';
          zoneId: string;
          startX: number;
          startY: number;
          origX: number;
          origY: number;
          box: ReturnType<typeof computeContainBox>;
        }
      | {
          mode: 'resize';
          zoneId: string;
          handle: ZoneHandleId;
          origLeft: number;
          origTop: number;
          origRight: number;
          origBottom: number;
          box: ReturnType<typeof computeContainBox>;
        }
      | {
          mode: 'draw';
          startVx: number;
          startVy: number;
          startPxX: number;
          startPxY: number;
          box: ReturnType<typeof computeContainBox>;
        };
    let drag: DragState | null = null;

    const getCanvasCoords = (ev: PointerEvent | MouseEvent | WheelEvent) => {
      const rect = this.handCanvas.getBoundingClientRect();
      return {
        x: ev.clientX - rect.left,
        y: ev.clientY - rect.top,
        w: rect.width,
        h: rect.height,
      };
    };

    const findHandleAt = (px: number, py: number, box: ReturnType<typeof computeContainBox>) => {
      const zones = this.triggerEngine.getZones();
      // Priorizar la zona seleccionada primero para que sus 8 manijas no queden tapadas
      const ordered = [...zones].sort((a, b) =>
        a.id === this.selectedTriggerId ? 1 : b.id === this.selectedTriggerId ? -1 : 0
      );
      for (let i = ordered.length - 1; i >= 0; i--) {
        const z = ordered[i];
        for (const h of getZoneHandles(z, box)) {
          if (Math.hypot(px - h.x, py - h.y) <= 11) {
            return { zone: z, handle: h };
          }
        }
      }
      return null;
    };

    this.handCanvas.addEventListener('pointerdown', (ev) => {
      if (!this.editTriggers || !this.showTriggers) return;
      if (ev.button !== 0) return;
      const pt = getCanvasCoords(ev);
      const box = computeContainBox(pt.w, pt.h, this.lastVideoAspect);

      // 1. Verificar cualquiera de las manijas (8 en rect, 4 en círculo)
      const hitHandle = findHandleAt(pt.x, pt.y, box);
      if (hitHandle) {
        const z = hitHandle.zone;
        this.selectedTriggerId = z.id;
        this.isDraggingZone = true;
        this.renderTriggerZonesList();
        this.syncSelectedTriggerEditor();
        drag = {
          mode: 'resize',
          zoneId: z.id,
          handle: hitHandle.handle.id,
          origLeft: z.x - z.width * 0.5,
          origTop: z.y - z.height * 0.5,
          origRight: z.x + z.width * 0.5,
          origBottom: z.y + z.height * 0.5,
          box,
        };
        this.handCanvas.setPointerCapture(ev.pointerId);
        return;
      }

      // 2. Verificar cuerpo del pulsador para mover
      const vx = (pt.x - box.x) / Math.max(box.w, 1);
      const vy = (pt.y - box.y) / Math.max(box.h, 1);
      const zones = this.triggerEngine.getZones();
      for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i];
        if (hitTestZoneNormalized(z, vx, vy, this.lastVideoAspect).inside) {
          this.selectedTriggerId = z.id;
          this.isDraggingZone = true;
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

      // 3. Arrastrar sobre área vacía para dibujar una nueva zona directamente
      if (vx >= 0 && vx <= 1 && vy >= 0 && vy <= 1) {
        this.isDraggingZone = true;
        this.updateZoneQuickHud();
        drag = {
          mode: 'draw',
          startVx: vx,
          startVy: vy,
          startPxX: pt.x,
          startPxY: pt.y,
          box,
        };
        this.draftZone = { x1: vx, y1: vy, x2: vx, y2: vy };
        this.handCanvas.setPointerCapture(ev.pointerId);
      }
    });

    this.handCanvas.addEventListener('pointermove', (ev) => {
      if (!this.editTriggers || !this.showTriggers) return;
      const pt = getCanvasCoords(ev);

      if (drag) {
        if (drag.mode === 'draw') {
          const vx = Math.max(0, Math.min(1, (pt.x - drag.box.x) / Math.max(drag.box.w, 1)));
          const vy = Math.max(0, Math.min(1, (pt.y - drag.box.y) / Math.max(drag.box.h, 1)));
          this.draftZone = { x1: drag.startVx, y1: drag.startVy, x2: vx, y2: vy };
          return;
        }

        const z = this.triggerEngine.getZone(drag.zoneId);
        if (!z) return;

        if (drag.mode === 'move') {
          const dx = (pt.x - drag.startX) / Math.max(drag.box.w, 1);
          const dy = (pt.y - drag.startY) / Math.max(drag.box.h, 1);
          this.triggerEngine.updateZone(drag.zoneId, {
            x: drag.origX + dx,
            y: drag.origY + dy,
          });
          this.handCanvas.style.cursor = 'grabbing';
        } else {
          if (z.shape === 'circle') {
            const geom = getZonePixelGeometry(z, drag.box);
            const minDim = Math.min(drag.box.w, drag.box.h);
            const r = Math.hypot(pt.x - geom.cx, pt.y - geom.cy);
            this.triggerEngine.updateZone(drag.zoneId, {
              width: (r * 2) / Math.max(minDim, 1),
            });
          } else if (ev.altKey) {
            const geom = getZonePixelGeometry(z, drag.box);
            const halfW = Math.abs(pt.x - geom.cx);
            const halfH = Math.abs(pt.y - geom.cy);
            const update: { width?: number; height?: number } = {};
            if (drag.handle.includes('e') || drag.handle.includes('w')) {
              update.width = (halfW * 2) / Math.max(drag.box.w, 1);
            }
            if (drag.handle.includes('n') || drag.handle.includes('s')) {
              update.height = (halfH * 2) / Math.max(drag.box.h, 1);
            }
            this.triggerEngine.updateZone(drag.zoneId, update);
          } else {
            // Redimensionado anclado al borde opuesto (como Figma / TD)
            const vx = Math.max(0.01, Math.min(0.99, (pt.x - drag.box.x) / Math.max(drag.box.w, 1)));
            const vy = Math.max(0.01, Math.min(0.99, (pt.y - drag.box.y) / Math.max(drag.box.h, 1)));
            const minSize = 0.04;

            let left = drag.origLeft;
            let right = drag.origRight;
            let top = drag.origTop;
            let bottom = drag.origBottom;

            if (drag.handle.includes('w')) left = Math.min(vx, right - minSize);
            if (drag.handle.includes('e')) right = Math.max(vx, left + minSize);
            if (drag.handle.includes('n')) top = Math.min(vy, bottom - minSize);
            if (drag.handle.includes('s')) bottom = Math.max(vy, top + minSize);

            this.triggerEngine.updateZone(drag.zoneId, {
              x: (left + right) * 0.5,
              y: (top + bottom) * 0.5,
              width: right - left,
              height: bottom - top,
            });
          }
        }
        this.syncSelectedTriggerEditor();
        return;
      }

      // Hover y cursor en vivo
      const box = computeContainBox(pt.w, pt.h, this.lastVideoAspect);
      const hitHandle = findHandleAt(pt.x, pt.y, box);
      if (hitHandle) {
        this.hoveredTriggerId = hitHandle.zone.id;
        this.handCanvas.style.cursor = hitHandle.handle.cursor;
        return;
      }

      const vx = (pt.x - box.x) / Math.max(box.w, 1);
      const vy = (pt.y - box.y) / Math.max(box.h, 1);
      const zones = this.triggerEngine.getZones();
      let hovered: string | null = null;
      for (let i = zones.length - 1; i >= 0; i--) {
        if (hitTestZoneNormalized(zones[i], vx, vy, this.lastVideoAspect).inside) {
          hovered = zones[i].id;
          break;
        }
      }
      this.hoveredTriggerId = hovered;
      this.handCanvas.style.cursor = hovered ? 'grab' : 'crosshair';
    });

    this.handCanvas.addEventListener('pointerleave', () => {
      if (!drag) {
        this.hoveredTriggerId = null;
      }
    });

    const endDrag = (ev: PointerEvent) => {
      if (!drag) return;
      const finished = drag;
      drag = null;
      this.isDraggingZone = false;

      if (finished.mode === 'draw' && this.draftZone) {
        const pt = getCanvasCoords(ev);
        const distPx = Math.hypot(pt.x - finished.startPxX, pt.y - finished.startPxY);
        const wNorm = Math.abs(this.draftZone.x2 - this.draftZone.x1);
        const hNorm = Math.abs(this.draftZone.y2 - this.draftZone.y1);

        if (distPx >= 24 && wNorm >= 0.04 && hNorm >= 0.04) {
          const created = this.triggerEngine.addZone({
            x: (this.draftZone.x1 + this.draftZone.x2) * 0.5,
            y: (this.draftZone.y1 + this.draftZone.y2) * 0.5,
            width: wNorm,
            height: hNorm,
          });
          this.selectedTriggerId = created.id;
          this.renderTriggerZonesList();
          this.syncSelectedTriggerEditor();
        } else {
          // Clic simple en espacio vacío: deseleccionar HUD para limpiar vista
          this.selectedTriggerId = null;
          this.renderTriggerZonesList();
          this.syncSelectedTriggerEditor();
        }
        this.draftZone = null;
      } else {
        this.updateZoneQuickHud();
      }

      try {
        this.handCanvas.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore if not captured
      }
    };
    this.handCanvas.addEventListener('pointerup', endDrag);
    this.handCanvas.addEventListener('pointercancel', endDrag);

    // Rueda del mouse sobre una zona: redimensiona rápido
    this.handCanvas.addEventListener(
      'wheel',
      (ev) => {
        if (!this.editTriggers || !this.showTriggers) return;
        const targetId = this.hoveredTriggerId || this.selectedTriggerId;
        if (!targetId) return;
        const z = this.triggerEngine.getZone(targetId);
        if (!z) return;
        ev.preventDefault();
        const delta = ev.deltaY < 0 ? 0.02 : -0.02;
        this.selectedTriggerId = z.id;
        this.triggerEngine.updateZone(z.id, {
          width: z.width + delta,
          height: z.shape === 'circle' ? z.height : z.height + delta,
        });
        this.renderTriggerZonesList();
        this.syncSelectedTriggerEditor();
      },
      { passive: false }
    );

    this.handCanvas.addEventListener('dblclick', (ev) => {
      if (!this.editTriggers || !this.showTriggers) return;
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

  private updateZoneQuickHud(): void {
    const hud = byId<HTMLElement>('zoneQuickHud');
    const zone = this.selectedTriggerId
      ? this.triggerEngine.getZone(this.selectedTriggerId)
      : undefined;

    if (!zone || !this.editTriggers || !this.showTriggers || this.isDraggingZone) {
      hud.classList.add('hidden');
      return;
    }

    const modeLabels: Record<TriggerMode, string> = {
      pulse: 'Pulso',
      momentary: 'Mantener',
      toggle: 'Toggle',
    };

    byId<HTMLElement>('hudZoneName').textContent = zone.name;
    const oscInput = byId<HTMLInputElement>('hudZoneOsc');
    if (document.activeElement !== oscInput) {
      oscInput.value = zone.oscAddress;
    }
    byId<HTMLButtonElement>('hudZoneMode').textContent = modeLabels[zone.mode];
    byId<HTMLButtonElement>('hudZoneShape').textContent =
      zone.shape === 'circle' ? 'Círculo' : 'Rect';
    byId<HTMLSelectElement>('hudZoneTarget').value = zone.target;

    hud.classList.remove('hidden');

    // Posicionar flotante arriba o abajo de la zona dentro de viewportWrap
    const wrapW = this.handCanvas.clientWidth;
    const wrapH = this.handCanvas.clientHeight;
    if (wrapW === 0 || wrapH === 0) return;

    const box = computeContainBox(wrapW, wrapH, this.lastVideoAspect);
    const geom = getZonePixelGeometry(zone, box);
    const hudW = hud.offsetWidth || 320;
    const hudH = hud.offsetHeight || 32;

    const left = Math.max(8, Math.min(geom.cx - hudW * 0.5, wrapW - hudW - 8));
    const preferTop = geom.top - hudH - 8;
    const top = preferTop >= 8 ? preferTop : Math.min(geom.top + geom.h + 8, wrapH - hudH - 8);

    hud.style.left = `${Math.round(left)}px`;
    hud.style.top = `${Math.round(top)}px`;
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
      this.updateZoneQuickHud();
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
    this.updateZoneQuickHud();
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
    requestAnimationFrame(() => this.updateZoneQuickHud());
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
        poses: [],
        rawGestures: [],
      };
    }

    this.lastVideoAspect = videoAspect;
    const effectiveMirrored = this.sourceMode === 'camera' ? this.mirrored : false;

    // 2. Evaluación espacial de Pulsadores, Gestos y Síntesis Sonora
    const triggers = this.triggerEngine.evaluate(frame, effectiveMirrored, videoAspect);
    const gestures = this.gestureEngine.evaluate(frame);
    const synthTelemetry = this.synth.updateFromTracking(frame);

    // 3. Render overlays (Pose + Manos + Pulsadores + Audio FFT/Oscilloscope)
    renderHandOverlay(this.handCanvas, frame, synthTelemetry, triggers, gestures, {
      mirrored: effectiveMirrored,
      showLandmarkIds: this.showIds,
      showPhalanxAngles: this.showAngles,
      showPitchGuides: true,
      showTriggers: this.showTriggers,
      showPoseSkeleton: this.showPoseSkeleton,
      editTriggers: this.editTriggers,
      selectedTriggerId: this.selectedTriggerId,
      hoveredTriggerId: this.hoveredTriggerId,
      draftZone: this.draftZone,
      videoAspect,
    });

    this.visualizer.render(
      this.audioCanvas,
      this.synth.getAnalyser(),
      this.synth.getSampleRate(),
      synthTelemetry
    );

    // 4. OSC TX en 3 módulos independientes (Principal :9000, Gestos :9001, Esqueleto :9002)
    let triggerEdge = false;
    for (const ev of triggers) {
      const prev = this.lastTriggerValues.get(ev.zone.id);
      if (ev.justTriggered || (prev !== undefined && prev !== ev.value)) {
        triggerEdge = true;
      }
      this.lastTriggerValues.set(ev.zone.id, ev.value);
    }

    let gestureEdge = false;
    for (const g of gestures.items) {
      const prev = this.lastGestureActiveMap.get(g.id);
      if (prev !== undefined && prev !== g.active) {
        gestureEdge = true;
      }
      this.lastGestureActiveMap.set(g.id, g.active);
    }

    const mainMessages = buildOscMessages(
      frame,
      synthTelemetry,
      this.oscClient.getConfig().channels,
      triggers
    );
    const gestureMessages = buildGestureOscMessages(
      gestures,
      this.oscClient.getGesturesConfig().channels
    );
    const skeletonMessages = buildSkeletonOscMessages(
      frame,
      this.oscClient.getSkeletonConfig().channels
    );

    this.oscClient.sendBatch(mainMessages, nowMs, triggerEdge, 'main');
    this.oscClient.sendBatch(gestureMessages, nowMs, gestureEdge, 'gestures');
    this.oscClient.sendBatch(skeletonMessages, nowMs, false, 'skeleton');

    // 5. UI telemetry (~30Hz max para DOM liviano, OSC Monitores ~10Hz)
    if (nowMs - this.lastUiTelemetryTime >= 32) {
      this.lastUiTelemetryTime = nowMs;
      this.updateTelemetryDom(frame, synthTelemetry, triggers, gestures);
    }

    if (nowMs - this.lastOscMonitorTime >= 110) {
      this.lastOscMonitorTime = nowMs;
      this.renderOscMonitor(this.oscMonitorList, mainMessages);
      this.renderOscMonitor(this.gestOscMonitorList, gestureMessages);
      this.renderOscMonitor(this.skelOscMonitorList, skeletonMessages);
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
    triggers: TriggerEvaluation[],
    gestures: GestureDetectionFrame
  ): void {
    for (const ev of triggers) {
      const ref = this.triggerRowRefs.get(ev.zone.id);
      if (!ref) continue;
      ref.item.classList.toggle('is-active', ev.active);
      ref.pill.textContent = `${ev.value} · #${ev.hitCount}`;
    }

    // Gesture list DOM update
    this.gesturesActiveBadge.textContent =
      gestures.activeCount === 1 ? '1 activo' : `${gestures.activeCount} activos`;
    this.topGestureLeftText.textContent = gestures.topLeft
      ? `${gestures.topLeft.label} (${Math.round(gestures.topLeft.confidence * 100)}%)`
      : '—';
    this.topGestureRightText.textContent = gestures.topRight
      ? `${gestures.topRight.label} (${Math.round(gestures.topRight.confidence * 100)}%)`
      : '—';

    for (const item of gestures.items) {
      const ref = this.gestureRowRefs.get(item.id);
      if (!ref) continue;
      ref.row.classList.toggle('is-active', item.active);
      const pct = Math.round(item.confidence * 100);
      ref.scoreVal.textContent = `${pct}% · #${item.hitCount}`;
      ref.bar.style.width = `${pct}%`;
    }

    const evFrag = document.createDocumentFragment();
    for (const ev of gestures.recentEvents.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'gesture-event-row';
      const left = document.createElement('span');
      left.textContent = `${ev.label} (${Math.round(ev.confidence * 100)}%)`;
      const right = document.createElement('span');
      right.textContent = ev.oscAddress;
      row.append(left, right);
      evFrag.appendChild(row);
    }
    this.gestureEventLog.replaceChildren(evFrag);

    // Pose skeleton DOM update
    const pose = frame.poses[0];
    if (!pose) {
      this.poseStatusBadge.textContent = 'Sin cuerpo detectado';
      this.poseVisBadge.textContent = 'Visibilidad 0%';
      this.poseCenterText.textContent = '—';
      this.poseLeanText.textContent = '0° / 0° / 0°';
      for (const ref of this.poseAngleRefs.values()) {
        ref.val.textContent = '180°';
        ref.bar.style.width = '0%';
      }
    } else {
      this.poseStatusBadge.textContent = `Cuerpo detectado (${frame.poses.length})`;
      this.poseVisBadge.textContent = `Visibilidad ${Math.round(pose.visibilityMean * 100)}%`;
      this.poseCenterText.textContent = `${pose.centerOfMass.x.toFixed(2)}, ${pose.centerOfMass.y.toFixed(2)}, ${pose.centerOfMass.z.toFixed(2)}`;
      this.poseLeanText.textContent = `${Math.round(pose.torsoLean.forwardDeg)}° / ${Math.round(pose.torsoLean.lateralDeg)}° / ${Math.round(pose.torsoLean.twistDeg)}°`;
      for (const [k, ref] of this.poseAngleRefs.entries()) {
        const deg = pose.angles[k];
        ref.val.textContent = `${Math.round(deg)}°`;
        const flexPct = Math.round(Math.max(0, Math.min(1, (180 - deg) / 140)) * 100);
        ref.bar.style.width = `${flexPct}%`;
      }
    }

    const count = frame.hands.length;
    const handLabel = count === 1 ? '1 mano' : `${count} manos`;
    const poseLabel = frame.poses.length > 0 ? 'Pose OK' : 'Sin pose';
    this.handsDetectedBadge.textContent = `${handLabel} · ${poseLabel}`;

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
    const mainCfg = this.oscClient.getConfig();
    const gestCfg = this.oscClient.getGesturesConfig();
    const skelCfg = this.oscClient.getSkeletonConfig();
    const anyEnabled = mainCfg.enabled || gestCfg.enabled || skelCfg.enabled;

    this.oscBridgeRow.classList.toggle('hidden', stats.bridgeMode === 'connected');

    if (stats.bridgeMode === 'standalone' && !stats.wsConnected) {
      this.oscStatusDot.className = stats.lastError ? 'dot dot-err' : 'dot dot-warn';
      this.oscStatusText.textContent = stats.lastError
        ? `OSC: ${stats.lastError}`
        : 'OSC: Modo Web (Monitor local)';
      this.oscBridgeState.textContent = stats.lastError
        ? `Sin puente (${stats.lastError})`
        : 'Modo Web (sin puente UDP)';
    } else if (stats.bridgeMode === 'connecting' && !stats.wsConnected) {
      this.oscStatusDot.className = 'dot dot-warn';
      this.oscStatusText.textContent = 'OSC: Conectando...';
      this.oscBridgeState.textContent = 'Conectando...';
    } else if (!stats.wsConnected) {
      this.oscStatusDot.className = 'dot dot-err';
      this.oscStatusText.textContent = 'OSC: Puente desconectado';
      this.oscBridgeState.textContent = 'Desconectado';
    } else if (stats.lastError) {
      this.oscStatusDot.className = 'dot dot-err';
      this.oscStatusText.textContent = `OSC Error: ${stats.lastError}`;
      this.oscBridgeState.textContent = `Error: ${stats.lastError}`;
    } else if (!anyEnabled) {
      this.oscStatusDot.className = 'dot dot-warn';
      this.oscStatusText.textContent = 'OSC: Módulos pausados';
      this.oscBridgeState.textContent = 'Pausado';
    } else {
      const ports: string[] = [];
      if (mainCfg.enabled) ports.push(String(stats.modules.main.targetPort));
      if (gestCfg.enabled) ports.push(String(stats.modules.gestures.targetPort));
      if (skelCfg.enabled) ports.push(String(stats.modules.skeleton.targetPort));
      this.oscStatusDot.className = 'dot dot-ok';
      this.oscStatusText.textContent = `OSC [${ports.join(' | ')}] · ${stats.messagesPerSec} msg/s`;
      this.oscBridgeState.textContent = mainCfg.enabled
        ? `UDP Activo (${stats.modules.main.sendMode})`
        : 'Pausado';
    }

    const mMain = stats.modules.main;
    const mGest = stats.modules.gestures;
    const mSkel = stats.modules.skeleton;

    this.mainOscStatusPill.textContent = `Puerto ${mMain.targetPort}`;
    this.oscMsgRate.textContent = `${mMain.messagesPerSec} msg/s`;
    this.oscPacketsTotal.textContent = mMain.packetsSent.toLocaleString('es-ES');
    this.oscBytesTotal.textContent =
      mMain.bytesSent > 1024 * 1024
        ? `${(mMain.bytesSent / (1024 * 1024)).toFixed(2)} MB`
        : mMain.bytesSent > 1024
          ? `${(mMain.bytesSent / 1024).toFixed(1)} KB`
          : `${mMain.bytesSent} B`;

    this.gestOscStatusPill.textContent = `Puerto ${mGest.targetPort}`;
    this.gestOscMsgRate.textContent = `${mGest.messagesPerSec} msg/s`;
    this.gestOscPacketsTotal.textContent = mGest.packetsSent.toLocaleString('es-ES');

    this.skelOscStatusPill.textContent = `Puerto ${mSkel.targetPort}`;
    this.skelOscMsgRate.textContent = `${mSkel.messagesPerSec} msg/s`;
    this.skelOscPacketsTotal.textContent = mSkel.packetsSent.toLocaleString('es-ES');
  }

  private renderOscMonitor(container: HTMLElement, messages: OscMessageItem[]): void {
    const maxRows = 38;
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

    container.replaceChildren(frag);
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

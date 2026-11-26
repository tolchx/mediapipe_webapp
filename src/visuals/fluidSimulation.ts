/*
 * WebGL Fluid Simulation Engine
 * Adapted to TypeScript module from PavelDoGreat/WebGL-Fluid-Simulation (MIT License)
 * Copyright (c) 2017 Pavel Dobryakov
 */

import type { FluidRgbColor, HandBlob } from '../vision/handBlobSystem';

export interface FluidConfig {
  SIM_RESOLUTION: number;
  DYE_RESOLUTION: number;
  DENSITY_DISSIPATION: number;
  VELOCITY_DISSIPATION: number;
  PRESSURE: number;
  PRESSURE_ITERATIONS: number;
  CURL: number;
  SPLAT_RADIUS: number;
  SPLAT_FORCE: number;
  SHADING: boolean;
  COLORFUL: boolean;
  COLOR_UPDATE_SPEED: number;
  PAUSED: boolean;
  BACK_COLOR: { r: number; g: number; b: number };
  TRANSPARENT: boolean;
  BLOOM: boolean;
  BLOOM_ITERATIONS: number;
  BLOOM_RESOLUTION: number;
  BLOOM_INTENSITY: number;
  BLOOM_THRESHOLD: number;
  BLOOM_SOFT_KNEE: number;
  SUNRAYS: boolean;
  SUNRAYS_RESOLUTION: number;
  SUNRAYS_WEIGHT: number;
}

export const DEFAULT_FLUID_CONFIG: FluidConfig = {
  SIM_RESOLUTION: 128,
  DYE_RESOLUTION: 1024,
  DENSITY_DISSIPATION: 1.0,
  VELOCITY_DISSIPATION: 0.25,
  PRESSURE: 0.8,
  PRESSURE_ITERATIONS: 20,
  CURL: 30,
  SPLAT_RADIUS: 0.25,
  SPLAT_FORCE: 6000,
  SHADING: true,
  COLORFUL: true,
  COLOR_UPDATE_SPEED: 10,
  PAUSED: false,
  BACK_COLOR: { r: 7, g: 10, b: 15 },
  TRANSPARENT: false,
  BLOOM: true,
  BLOOM_ITERATIONS: 8,
  BLOOM_RESOLUTION: 256,
  BLOOM_INTENSITY: 0.8,
  BLOOM_THRESHOLD: 0.6,
  BLOOM_SOFT_KNEE: 0.7,
  SUNRAYS: true,
  SUNRAYS_RESOLUTION: 196,
  SUNRAYS_WEIGHT: 1.0,
};

interface FBO {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  attach: (id: number) => number;
}

interface DoubleFBO {
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  read: FBO;
  write: FBO;
  swap: () => void;
}

interface TextureFormatInfo {
  internalFormat: number;
  format: number;
}

interface WebGLExtensions {
  formatRGBA: TextureFormatInfo;
  formatRG: TextureFormatInfo;
  formatR: TextureFormatInfo;
  halfFloatTexType: number;
  supportLinearFiltering: boolean;
}

interface PointerState {
  id: number;
  texcoordX: number;
  texcoordY: number;
  prevTexcoordX: number;
  prevTexcoordY: number;
  deltaX: number;
  deltaY: number;
  down: boolean;
  moved: boolean;
  color: FluidRgbColor;
}

type UniformMap = Record<string, WebGLUniformLocation | null>;

function hashCode(s: string): number {
  if (s.length === 0) return 0;
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function hsvToRgb(h: number, s: number, v: number): FluidRgbColor {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return { r, g, b };
}

function generateColor(): FluidRgbColor {
  const c = hsvToRgb(Math.random(), 1.0, 1.0);
  c.r *= 0.15;
  c.g *= 0.15;
  c.b *= 0.15;
  return c;
}

function wrap(value: number, min: number, max: number): number {
  const range = max - min;
  if (range === 0) return min;
  return ((value - min) % range) + min;
}

function scaleByPixelRatio(input: number): number {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  return Math.floor(input * pixelRatio);
}

const BASE_VERTEX_SOURCE = `
  precision highp float;
  attribute vec2 aPosition;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const BLUR_VERTEX_SOURCE = `
  precision highp float;
  attribute vec2 aPosition;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    float offset = 1.33333333;
    vL = vUv - texelSize * offset;
    vR = vUv + texelSize * offset;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const BLUR_FRAGMENT_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  uniform sampler2D uTexture;
  void main () {
    vec4 sum = texture2D(uTexture, vUv) * 0.29411764;
    sum += texture2D(uTexture, vL) * 0.35294117;
    sum += texture2D(uTexture, vR) * 0.35294117;
    gl_FragColor = sum;
  }
`;

const COPY_FRAGMENT_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  uniform sampler2D uTexture;
  void main () {
    gl_FragColor = texture2D(uTexture, vUv);
  }
`;

const CLEAR_FRAGMENT_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  uniform sampler2D uTexture;
  uniform float value;
  void main () {
    gl_FragColor = value * texture2D(uTexture, vUv);
  }
`;

const COLOR_FRAGMENT_SOURCE = `
  precision mediump float;
  uniform vec4 color;
  void main () {
    gl_FragColor = color;
  }
`;

const DISPLAY_FRAGMENT_SOURCE = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;
  uniform sampler2D uBloom;
  uniform sampler2D uSunrays;
  uniform sampler2D uDithering;
  uniform vec2 ditherScale;
  uniform vec2 texelSize;

  vec3 linearToGamma (vec3 color) {
    color = max(color, vec3(0));
    return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
  }

  void main () {
    vec3 c = texture2D(uTexture, vUv).rgb;

  #ifdef SHADING
    vec3 lc = texture2D(uTexture, vL).rgb;
    vec3 rc = texture2D(uTexture, vR).rgb;
    vec3 tc = texture2D(uTexture, vT).rgb;
    vec3 bc = texture2D(uTexture, vB).rgb;

    float dx = length(rc) - length(lc);
    float dy = length(tc) - length(bc);

    vec3 n = normalize(vec3(dx, dy, length(texelSize)));
    vec3 l = vec3(0.0, 0.0, 1.0);

    float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
    c *= diffuse;
  #endif

  #ifdef BLOOM
    vec3 bloom = texture2D(uBloom, vUv).rgb;
  #endif

  #ifdef SUNRAYS
    float sunrays = texture2D(uSunrays, vUv).r;
    c *= sunrays;
  #ifdef BLOOM
    bloom *= sunrays;
  #endif
  #endif

  #ifdef BLOOM
    float noise = texture2D(uDithering, vUv * ditherScale).r;
    noise = noise * 2.0 - 1.0;
    bloom += noise / 255.0;
    bloom = linearToGamma(bloom);
    c += bloom;
  #endif

    float a = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c, a);
  }
`;

const BLOOM_PREFILTER_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform vec3 curve;
  uniform float threshold;
  void main () {
    vec3 c = texture2D(uTexture, vUv).rgb;
    float br = max(c.r, max(c.g, c.b));
    float rq = clamp(br - curve.x, 0.0, curve.y);
    rq = curve.z * rq * rq;
    c *= max(rq, br - threshold) / max(br, 0.0001);
    gl_FragColor = vec4(c, 0.0);
  }
`;

const BLOOM_BLUR_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;
  void main () {
    vec4 sum = vec4(0.0);
    sum += texture2D(uTexture, vL);
    sum += texture2D(uTexture, vR);
    sum += texture2D(uTexture, vT);
    sum += texture2D(uTexture, vB);
    sum *= 0.25;
    gl_FragColor = sum;
  }
`;

const BLOOM_FINAL_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uTexture;
  uniform float intensity;
  void main () {
    vec4 sum = vec4(0.0);
    sum += texture2D(uTexture, vL);
    sum += texture2D(uTexture, vR);
    sum += texture2D(uTexture, vT);
    sum += texture2D(uTexture, vB);
    sum *= 0.25;
    gl_FragColor = sum * intensity;
  }
`;

const SUNRAYS_MASK_SOURCE = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  void main () {
    vec4 c = texture2D(uTexture, vUv);
    float br = max(c.r, max(c.g, c.b));
    c.a = 1.0 - min(max(br * 20.0, 0.0), 0.8);
    gl_FragColor = c;
  }
`;

const SUNRAYS_SOURCE = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float weight;
  #define ITERATIONS 16
  void main () {
    float Density = 0.3;
    float Decay = 0.95;
    float Exposure = 0.7;
    vec2 coord = vUv;
    vec2 dir = vUv - 0.5;
    dir *= 1.0 / float(ITERATIONS) * Density;
    float illuminationDecay = 1.0;
    float color = texture2D(uTexture, vUv).a;
    for (int i = 0; i < ITERATIONS; i++) {
      coord -= dir;
      float col = texture2D(uTexture, coord).a;
      color += col * illuminationDecay * weight;
      illuminationDecay *= Decay;
    }
    gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);
  }
`;

const SPLAT_FRAGMENT_SOURCE = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;
  void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`;

const ADVECTION_FRAGMENT_SOURCE = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform vec2 dyeTexelSize;
  uniform float dt;
  uniform float dissipation;

  vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
    vec2 st = uv / tsize - 0.5;
    vec2 iuv = floor(st);
    vec2 fuv = fract(st);
    vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
    vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
    vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
    vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
  }

  void main () {
  #ifdef MANUAL_FILTERING
    vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
    vec4 result = bilerp(uSource, coord, dyeTexelSize);
  #else
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    vec4 result = texture2D(uSource, coord);
  #endif
    float decay = 1.0 + dissipation * dt;
    gl_FragColor = result / decay;
  }
`;

const DIVERGENCE_FRAGMENT_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`;

const CURL_FRAGMENT_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
  }
`;

const VORTICITY_FRAGMENT_SOURCE = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curl;
  uniform float dt;
  void main () {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity += force * dt;
    velocity = min(max(velocity, -1000.0), 1000.0);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const PRESSURE_FRAGMENT_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`;

const GRADIENT_SUBTRACT_SOURCE = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

class GLProgram {
  public uniforms: UniformMap;
  private program: WebGLProgram;
  private gl: WebGLRenderingContext;

  constructor(gl: WebGLRenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader) {
    this.gl = gl;
    const program = gl.createProgram();
    if (!program) throw new Error('Unable to create WebGLProgram');
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
    }
    this.program = program;
    this.uniforms = GLProgram.getUniforms(gl, program);
  }

  public bind(): void {
    this.gl.useProgram(this.program);
  }

  public static getUniforms(gl: WebGLRenderingContext, program: WebGLProgram): UniformMap {
    const uniforms: UniformMap = {};
    const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < uniformCount; i++) {
      const info = gl.getActiveUniform(program, i);
      if (info) {
        uniforms[info.name] = gl.getUniformLocation(program, info.name);
      }
    }
    return uniforms;
  }
}

class GLMaterial {
  public uniforms: UniformMap = {};
  private programs = new Map<number, WebGLProgram>();
  private activeProgram: WebGLProgram | null = null;
  private gl: WebGLRenderingContext;
  private vertexShader: WebGLShader;
  private fragmentShaderSource: string;

  constructor(gl: WebGLRenderingContext, vertexShader: WebGLShader, fragmentShaderSource: string) {
    this.gl = gl;
    this.vertexShader = vertexShader;
    this.fragmentShaderSource = fragmentShaderSource;
  }

  public setKeywords(keywords: string[], compileFn: (type: number, source: string, kw?: string[]) => WebGLShader): void {
    let hash = 0;
    for (let i = 0; i < keywords.length; i++) {
      hash += hashCode(keywords[i]);
    }
    let program = this.programs.get(hash) ?? null;
    if (!program) {
      const fragmentShader = compileFn(this.gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
      const created = this.gl.createProgram();
      if (!created) throw new Error('Unable to create Material WebGLProgram');
      this.gl.attachShader(created, this.vertexShader);
      this.gl.attachShader(created, fragmentShader);
      this.gl.linkProgram(created);
      program = created;
      this.programs.set(hash, program);
    }
    if (program === this.activeProgram) return;
    this.uniforms = GLProgram.getUniforms(this.gl, program);
    this.activeProgram = program;
  }

  public bind(): void {
    if (this.activeProgram) {
      this.gl.useProgram(this.activeProgram);
    }
  }
}

export class FluidSimulationEngine {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private ext: WebGLExtensions;
  private config: FluidConfig;
  private supported = true;

  private dye!: DoubleFBO;
  private velocity!: DoubleFBO;
  private divergence!: FBO;
  private curl!: FBO;
  private pressure!: DoubleFBO;
  private bloom!: FBO;
  private bloomFramebuffers: FBO[] = [];
  private sunrays!: FBO;
  private sunraysTemp!: FBO;
  private ditheringTexture: { texture: WebGLTexture; width: number; height: number; attach: (id: number) => number };

  private blurProgram!: GLProgram;
  private copyProgram!: GLProgram;
  private clearProgram!: GLProgram;
  private colorProgram!: GLProgram;
  private bloomPrefilterProgram!: GLProgram;
  private bloomBlurProgram!: GLProgram;
  private bloomFinalProgram!: GLProgram;
  private sunraysMaskProgram!: GLProgram;
  private sunraysProgram!: GLProgram;
  private splatProgram!: GLProgram;
  private advectionProgram!: GLProgram;
  private divergenceProgram!: GLProgram;
  private curlProgram!: GLProgram;
  private vorticityProgram!: GLProgram;
  private pressureProgram!: GLProgram;
  private gradientSubtractProgram!: GLProgram;
  private displayMaterial!: GLMaterial;

  private blitFn!: (target: FBO | null, clear?: boolean) => void;
  private pointer: PointerState;
  private lastUpdateTime = performance.now();
  private colorUpdateTimer = 0;

  constructor(canvas: HTMLCanvasElement, initialConfig?: Partial<FluidConfig>) {
    this.canvas = canvas;
    this.config = { ...DEFAULT_FLUID_CONFIG, ...initialConfig };
    this.pointer = {
      id: -1,
      texcoordX: 0,
      texcoordY: 0,
      prevTexcoordX: 0,
      prevTexcoordY: 0,
      deltaX: 0,
      deltaY: 0,
      down: false,
      moved: false,
      color: generateColor(),
    };

    const ctx = this.initWebGLContext(canvas);
    this.gl = ctx.gl;
    this.ext = ctx.ext;

    if (!this.ext.supportLinearFiltering) {
      this.config.DYE_RESOLUTION = 512;
      this.config.SHADING = false;
      this.config.BLOOM = false;
      this.config.SUNRAYS = false;
    }

    this.ditheringTexture = this.createDitheringTexture();
    this.initQuadBlit();
    this.initPrograms();
    this.updateKeywords();
    this.ensureCanvasSize();
    this.initFramebuffers();
    this.multipleSplats(8);
    this.attachPointerEvents();
  }

  public isSupported(): boolean {
    return this.supported;
  }

  public getConfig(): FluidConfig {
    return { ...this.config };
  }

  public updateConfig(partial: Partial<FluidConfig>): void {
    const prevShading = this.config.SHADING;
    const prevBloom = this.config.BLOOM;
    const prevSunrays = this.config.SUNRAYS;
    const prevSimRes = this.config.SIM_RESOLUTION;
    const prevDyeRes = this.config.DYE_RESOLUTION;

    this.config = { ...this.config, ...partial };

    if (!this.ext.supportLinearFiltering) {
      this.config.SHADING = false;
      this.config.BLOOM = false;
      this.config.SUNRAYS = false;
    }

    if (
      prevShading !== this.config.SHADING ||
      prevBloom !== this.config.BLOOM ||
      prevSunrays !== this.config.SUNRAYS
    ) {
      this.updateKeywords();
    }

    if (prevSimRes !== this.config.SIM_RESOLUTION || prevDyeRes !== this.config.DYE_RESOLUTION) {
      this.initFramebuffers();
    }
  }

  public clear(): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.clearProgram.bind();
    gl.uniform1i(this.clearProgram.uniforms.uTexture, this.dye.read.attach(0));
    gl.uniform1f(this.clearProgram.uniforms.value, 0.0);
    this.blitFn(this.dye.write);
    this.dye.swap();

    gl.uniform1i(this.clearProgram.uniforms.uTexture, this.velocity.read.attach(0));
    gl.uniform1f(this.clearProgram.uniforms.value, 0.0);
    this.blitFn(this.velocity.write);
    this.velocity.swap();
  }

  public multipleSplats(amount: number): void {
    for (let i = 0; i < amount; i++) {
      const color = generateColor();
      color.r *= 10.0;
      color.g *= 10.0;
      color.b *= 10.0;
      const x = Math.random();
      const y = Math.random();
      const dx = 1000 * (Math.random() - 0.5);
      const dy = 1000 * (Math.random() - 0.5);
      this.splat(x, y, dx, dy, color);
    }
  }

  /**
   * Inyecta los blobs de movimiento de manos en el simulador de fluidos.
   */
  public applyBlobs(blobs: HandBlob[]): void {
    if (!this.supported || this.config.PAUSED) return;

    for (const blob of blobs) {
      if (!blob.active) continue;

      const x = blob.x;
      const y = 1.0 - blob.y; // Invertir Y para coordenadas UV de WebGL

      let dx = this.correctDeltaX(blob.dx) * this.config.SPLAT_FORCE * blob.force;
      let dy = this.correctDeltaY(-blob.dy) * this.config.SPLAT_FORCE * blob.force;

      // Si el usuario tiene "emitir en reposo" activo y la mano está quieta, dar un pulso suave
      if (Math.hypot(dx, dy) < 12) {
        const angle = performance.now() * 0.004 + (blob.side === 'right' ? 0 : Math.PI);
        dx = Math.cos(angle) * 45 * blob.force;
        dy = Math.sin(angle) * 45 * blob.force;
      }

      this.splat(x, y, dx, dy, blob.color, blob.radiusScale);
    }
  }

  public stepAndRender(nowMs = performance.now()): void {
    if (!this.supported) return;

    const dt = Math.min((nowMs - this.lastUpdateTime) / 1000, 0.016666);
    this.lastUpdateTime = nowMs;

    if (this.ensureCanvasSize()) {
      this.initFramebuffers();
    }

    if (this.canvas.width === 0 || this.canvas.height === 0) return;

    this.updateColors(dt);

    if (this.pointer.moved) {
      this.pointer.moved = false;
      const dx = this.pointer.deltaX * this.config.SPLAT_FORCE;
      const dy = this.pointer.deltaY * this.config.SPLAT_FORCE;
      this.splat(this.pointer.texcoordX, this.pointer.texcoordY, dx, dy, this.pointer.color);
    }

    if (!this.config.PAUSED) {
      this.stepSimulation(Math.max(dt, 0.001));
    }

    this.render(null);
  }

  public splat(
    x: number,
    y: number,
    dx: number,
    dy: number,
    color: FluidRgbColor,
    radiusScale = 1.0
  ): void {
    const gl = this.gl;
    this.splatProgram.bind();
    gl.uniform1i(this.splatProgram.uniforms.uTarget, this.velocity.read.attach(0));
    gl.uniform1f(this.splatProgram.uniforms.aspectRatio, this.canvas.width / Math.max(this.canvas.height, 1));
    gl.uniform2f(this.splatProgram.uniforms.point, x, y);
    gl.uniform3f(this.splatProgram.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(
      this.splatProgram.uniforms.radius,
      this.correctRadius((this.config.SPLAT_RADIUS * radiusScale) / 100.0)
    );
    this.blitFn(this.velocity.write);
    this.velocity.swap();

    gl.uniform1i(this.splatProgram.uniforms.uTarget, this.dye.read.attach(0));
    gl.uniform3f(this.splatProgram.uniforms.color, color.r, color.g, color.b);
    this.blitFn(this.dye.write);
    this.dye.swap();
  }

  private ensureCanvasSize(): boolean {
    const width = scaleByPixelRatio(this.canvas.clientWidth);
    const height = scaleByPixelRatio(this.canvas.clientHeight);
    if (width <= 0 || height <= 0) return false;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      return true;
    }
    return false;
  }

  private initWebGLContext(canvas: HTMLCanvasElement): { gl: WebGLRenderingContext; ext: WebGLExtensions } {
    const params: WebGLContextAttributes = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
    };

    let gl = canvas.getContext('webgl2', params) as WebGL2RenderingContext | null;
    const isWebGL2 = Boolean(gl);
    if (!gl) {
      gl = (canvas.getContext('webgl', params) ||
        canvas.getContext('experimental-webgl', params)) as WebGL2RenderingContext | null;
    }

    if (!gl) {
      this.supported = false;
      throw new Error('WebGL no está disponible en este navegador');
    }

    let halfFloat: OES_texture_half_float | null = null;
    let supportLinearFiltering = false;

    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      supportLinearFiltering = Boolean(gl.getExtension('OES_texture_float_linear'));
    } else {
      halfFloat = gl.getExtension('OES_texture_half_float');
      supportLinearFiltering = Boolean(gl.getExtension('OES_texture_half_float_linear'));
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    const halfFloatTexType = isWebGL2
      ? (gl as WebGL2RenderingContext).HALF_FLOAT
      : halfFloat
        ? halfFloat.HALF_FLOAT_OES
        : gl.UNSIGNED_BYTE;

    let formatRGBA: TextureFormatInfo | null;
    let formatRG: TextureFormatInfo | null;
    let formatR: TextureFormatInfo | null;

    if (isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      formatRGBA = this.getSupportedFormat(gl, gl2.RGBA16F, gl.RGBA, halfFloatTexType);
      formatRG = this.getSupportedFormat(gl, gl2.RG16F, gl2.RG, halfFloatTexType);
      formatR = this.getSupportedFormat(gl, gl2.R16F, gl2.RED, halfFloatTexType);
    } else {
      formatRGBA = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatR = this.getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }

    const fallback: TextureFormatInfo = { internalFormat: gl.RGBA, format: gl.RGBA };

    return {
      gl,
      ext: {
        formatRGBA: formatRGBA ?? fallback,
        formatRG: formatRG ?? fallback,
        formatR: formatR ?? fallback,
        halfFloatTexType,
        supportLinearFiltering,
      },
    };
  }

  private getSupportedFormat(
    gl: WebGLRenderingContext,
    internalFormat: number,
    format: number,
    type: number
  ): TextureFormatInfo | null {
    if (!this.supportRenderTextureFormat(gl, internalFormat, format, type)) {
      const gl2 = gl as WebGL2RenderingContext;
      if (internalFormat === gl2.R16F) {
        return this.getSupportedFormat(gl, gl2.RG16F, gl2.RG, type);
      }
      if (internalFormat === gl2.RG16F) {
        return this.getSupportedFormat(gl, gl2.RGBA16F, gl.RGBA, type);
      }
      return null;
    }
    return { internalFormat, format };
  }

  private supportRenderTextureFormat(
    gl: WebGLRenderingContext,
    internalFormat: number,
    format: number,
    type: number
  ): boolean {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    return status === gl.FRAMEBUFFER_COMPLETE;
  }

  private compileShader = (type: number, source: string, keywords?: string[]): WebGLShader => {
    const gl = this.gl;
    let finalSource = source;
    if (keywords && keywords.length > 0) {
      finalSource = keywords.map((kw) => `#define ${kw}\n`).join('') + source;
    }
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Unable to create WebGLShader');
    gl.shaderSource(shader, finalSource);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
    }
    return shader;
  };

  private initPrograms(): void {
    const gl = this.gl;
    const baseVert = this.compileShader(gl.VERTEX_SHADER, BASE_VERTEX_SOURCE);
    const blurVert = this.compileShader(gl.VERTEX_SHADER, BLUR_VERTEX_SOURCE);

    this.blurProgram = new GLProgram(gl, blurVert, this.compileShader(gl.FRAGMENT_SHADER, BLUR_FRAGMENT_SOURCE));
    this.copyProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, COPY_FRAGMENT_SOURCE));
    this.clearProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, CLEAR_FRAGMENT_SOURCE));
    this.colorProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, COLOR_FRAGMENT_SOURCE));
    this.bloomPrefilterProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, BLOOM_PREFILTER_SOURCE));
    this.bloomBlurProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, BLOOM_BLUR_SOURCE));
    this.bloomFinalProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, BLOOM_FINAL_SOURCE));
    this.sunraysMaskProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, SUNRAYS_MASK_SOURCE));
    this.sunraysProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, SUNRAYS_SOURCE));
    this.splatProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, SPLAT_FRAGMENT_SOURCE));
    this.advectionProgram = new GLProgram(
      gl,
      baseVert,
      this.compileShader(
        gl.FRAGMENT_SHADER,
        ADVECTION_FRAGMENT_SOURCE,
        this.ext.supportLinearFiltering ? undefined : ['MANUAL_FILTERING']
      )
    );
    this.divergenceProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, DIVERGENCE_FRAGMENT_SOURCE));
    this.curlProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, CURL_FRAGMENT_SOURCE));
    this.vorticityProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, VORTICITY_FRAGMENT_SOURCE));
    this.pressureProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, PRESSURE_FRAGMENT_SOURCE));
    this.gradientSubtractProgram = new GLProgram(gl, baseVert, this.compileShader(gl.FRAGMENT_SHADER, GRADIENT_SUBTRACT_SOURCE));
    this.displayMaterial = new GLMaterial(gl, baseVert, DISPLAY_FRAGMENT_SOURCE);
  }

  private initQuadBlit(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    this.blitFn = (target: FBO | null, clear = false) => {
      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      if (clear) {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  }

  private createDitheringTexture() {
    const gl = this.gl;
    const size = 64;
    const data = new Uint8Array(size * size * 3);
    for (let i = 0; i < size * size; i++) {
      const v = Math.floor(Math.random() * 255);
      data[i * 3] = v;
      data[i * 3 + 1] = v;
      data[i * 3 + 2] = v;
    }

    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, data);

    return {
      texture,
      width: size,
      height: size,
      attach(id: number) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  private updateKeywords(): void {
    const keywords: string[] = [];
    if (this.config.SHADING) keywords.push('SHADING');
    if (this.config.BLOOM) keywords.push('BLOOM');
    if (this.config.SUNRAYS) keywords.push('SUNRAYS');
    this.displayMaterial.setKeywords(keywords, this.compileShader);
  }

  private initFramebuffers(): void {
    const simRes = this.getResolution(this.config.SIM_RESOLUTION);
    const dyeRes = this.getResolution(this.config.DYE_RESOLUTION);

    const texType = this.ext.halfFloatTexType;
    const rgba = this.ext.formatRGBA;
    const rg = this.ext.formatRG;
    const r = this.ext.formatR;
    const filtering = this.ext.supportLinearFiltering ? this.gl.LINEAR : this.gl.NEAREST;

    this.gl.disable(this.gl.BLEND);

    if (!this.dye) {
      this.dye = this.createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    } else {
      this.dye = this.resizeDoubleFBO(this.dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    }

    if (!this.velocity) {
      this.velocity = this.createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    } else {
      this.velocity = this.resizeDoubleFBO(this.velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    }

    this.divergence = this.createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, this.gl.NEAREST);
    this.curl = this.createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, this.gl.NEAREST);
    this.pressure = this.createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, this.gl.NEAREST);

    this.initBloomFramebuffers();
    this.initSunraysFramebuffers();
  }

  private initBloomFramebuffers(): void {
    const res = this.getResolution(this.config.BLOOM_RESOLUTION);
    const texType = this.ext.halfFloatTexType;
    const rgba = this.ext.formatRGBA;
    const filtering = this.ext.supportLinearFiltering ? this.gl.LINEAR : this.gl.NEAREST;

    this.bloom = this.createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);
    this.bloomFramebuffers.length = 0;

    for (let i = 0; i < this.config.BLOOM_ITERATIONS; i++) {
      const width = res.width >> (i + 1);
      const height = res.height >> (i + 1);
      if (width < 2 || height < 2) break;
      this.bloomFramebuffers.push(this.createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering));
    }
  }

  private initSunraysFramebuffers(): void {
    const res = this.getResolution(this.config.SUNRAYS_RESOLUTION);
    const texType = this.ext.halfFloatTexType;
    const r = this.ext.formatR;
    const filtering = this.ext.supportLinearFiltering ? this.gl.LINEAR : this.gl.NEAREST;

    this.sunrays = this.createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
    this.sunraysTemp = this.createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
  }

  private createFBO(
    w: number,
    h: number,
    internalFormat: number,
    format: number,
    type: number,
    param: number
  ): FBO {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture,
      fbo,
      width: w,
      height: h,
      texelSizeX: 1.0 / w,
      texelSizeY: 1.0 / h,
      attach(id: number) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  private createDoubleFBO(
    w: number,
    h: number,
    internalFormat: number,
    format: number,
    type: number,
    param: number
  ): DoubleFBO {
    let fbo1 = this.createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = this.createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w,
      height: h,
      texelSizeX: fbo1.texelSizeX,
      texelSizeY: fbo1.texelSizeY,
      get read() {
        return fbo1;
      },
      set read(v: FBO) {
        fbo1 = v;
      },
      get write() {
        return fbo2;
      },
      set write(v: FBO) {
        fbo2 = v;
      },
      swap() {
        const tmp = fbo1;
        fbo1 = fbo2;
        fbo2 = tmp;
      },
    };
  }

  private resizeFBO(
    target: FBO,
    w: number,
    h: number,
    internalFormat: number,
    format: number,
    type: number,
    param: number
  ): FBO {
    const newFBO = this.createFBO(w, h, internalFormat, format, type, param);
    this.copyProgram.bind();
    this.gl.uniform1i(this.copyProgram.uniforms.uTexture, target.attach(0));
    this.blitFn(newFBO);
    return newFBO;
  }

  private resizeDoubleFBO(
    target: DoubleFBO,
    w: number,
    h: number,
    internalFormat: number,
    format: number,
    type: number,
    param: number
  ): DoubleFBO {
    if (target.width === w && target.height === h) return target;
    target.read = this.resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write = this.createFBO(w, h, internalFormat, format, type, param);
    target.width = w;
    target.height = h;
    target.texelSizeX = 1.0 / w;
    target.texelSizeY = 1.0 / h;
    return target;
  }

  private updateColors(dt: number): void {
    if (!this.config.COLORFUL) return;
    this.colorUpdateTimer += dt * this.config.COLOR_UPDATE_SPEED;
    if (this.colorUpdateTimer >= 1) {
      this.colorUpdateTimer = wrap(this.colorUpdateTimer, 0, 1);
      this.pointer.color = generateColor();
    }
  }

  private stepSimulation(dt: number): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);

    this.curlProgram.bind();
    gl.uniform2f(this.curlProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.curlProgram.uniforms.uVelocity, this.velocity.read.attach(0));
    this.blitFn(this.curl);

    this.vorticityProgram.bind();
    gl.uniform2f(this.vorticityProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.vorticityProgram.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.vorticityProgram.uniforms.uCurl, this.curl.attach(1));
    gl.uniform1f(this.vorticityProgram.uniforms.curl, this.config.CURL);
    gl.uniform1f(this.vorticityProgram.uniforms.dt, dt);
    this.blitFn(this.velocity.write);
    this.velocity.swap();

    this.divergenceProgram.bind();
    gl.uniform2f(this.divergenceProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.divergenceProgram.uniforms.uVelocity, this.velocity.read.attach(0));
    this.blitFn(this.divergence);

    this.clearProgram.bind();
    gl.uniform1i(this.clearProgram.uniforms.uTexture, this.pressure.read.attach(0));
    gl.uniform1f(this.clearProgram.uniforms.value, this.config.PRESSURE);
    this.blitFn(this.pressure.write);
    this.pressure.swap();

    this.pressureProgram.bind();
    gl.uniform2f(this.pressureProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.pressureProgram.uniforms.uDivergence, this.divergence.attach(0));
    for (let i = 0; i < this.config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(this.pressureProgram.uniforms.uPressure, this.pressure.read.attach(1));
      this.blitFn(this.pressure.write);
      this.pressure.swap();
    }

    this.gradientSubtractProgram.bind();
    gl.uniform2f(this.gradientSubtractProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    gl.uniform1i(this.gradientSubtractProgram.uniforms.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(this.gradientSubtractProgram.uniforms.uVelocity, this.velocity.read.attach(1));
    this.blitFn(this.velocity.write);
    this.velocity.swap();

    this.advectionProgram.bind();
    gl.uniform2f(this.advectionProgram.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    if (!this.ext.supportLinearFiltering) {
      gl.uniform2f(this.advectionProgram.uniforms.dyeTexelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
    }
    const velocityId = this.velocity.read.attach(0);
    gl.uniform1i(this.advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(this.advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(this.advectionProgram.uniforms.dt, dt);
    gl.uniform1f(this.advectionProgram.uniforms.dissipation, this.config.VELOCITY_DISSIPATION);
    this.blitFn(this.velocity.write);
    this.velocity.swap();

    if (!this.ext.supportLinearFiltering) {
      gl.uniform2f(this.advectionProgram.uniforms.dyeTexelSize, this.dye.texelSizeX, this.dye.texelSizeY);
    }
    gl.uniform1i(this.advectionProgram.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.advectionProgram.uniforms.uSource, this.dye.read.attach(1));
    gl.uniform1f(this.advectionProgram.uniforms.dissipation, this.config.DENSITY_DISSIPATION);
    this.blitFn(this.dye.write);
    this.dye.swap();
  }

  private render(target: FBO | null): void {
    const gl = this.gl;
    if (this.config.BLOOM) {
      this.applyBloom(this.dye.read, this.bloom);
    }
    if (this.config.SUNRAYS) {
      this.applySunrays(this.dye.read, this.dye.write, this.sunrays);
      this.blur(this.sunrays, this.sunraysTemp, 1);
    }

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);

    if (!this.config.TRANSPARENT) {
      this.colorProgram.bind();
      gl.uniform4f(
        this.colorProgram.uniforms.color,
        this.config.BACK_COLOR.r / 255,
        this.config.BACK_COLOR.g / 255,
        this.config.BACK_COLOR.b / 255,
        1
      );
      this.blitFn(target);
    }

    this.drawDisplay(target);
  }

  private drawDisplay(target: FBO | null): void {
    const gl = this.gl;
    const width = target == null ? gl.drawingBufferWidth : target.width;
    const height = target == null ? gl.drawingBufferHeight : target.height;

    this.displayMaterial.bind();
    if (this.config.SHADING) {
      gl.uniform2f(this.displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
    }
    gl.uniform1i(this.displayMaterial.uniforms.uTexture, this.dye.read.attach(0));
    if (this.config.BLOOM) {
      gl.uniform1i(this.displayMaterial.uniforms.uBloom, this.bloom.attach(1));
      gl.uniform1i(this.displayMaterial.uniforms.uDithering, this.ditheringTexture.attach(2));
      gl.uniform2f(
        this.displayMaterial.uniforms.ditherScale,
        width / this.ditheringTexture.width,
        height / this.ditheringTexture.height
      );
    }
    if (this.config.SUNRAYS) {
      gl.uniform1i(this.displayMaterial.uniforms.uSunrays, this.sunrays.attach(3));
    }
    this.blitFn(target);
  }

  private applyBloom(source: FBO, destination: FBO): void {
    if (this.bloomFramebuffers.length < 2) return;
    const gl = this.gl;
    let last = destination;

    gl.disable(gl.BLEND);
    this.bloomPrefilterProgram.bind();
    const knee = this.config.BLOOM_THRESHOLD * this.config.BLOOM_SOFT_KNEE + 0.0001;
    const curve0 = this.config.BLOOM_THRESHOLD - knee;
    const curve1 = knee * 2;
    const curve2 = 0.25 / knee;
    gl.uniform3f(this.bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(this.bloomPrefilterProgram.uniforms.threshold, this.config.BLOOM_THRESHOLD);
    gl.uniform1i(this.bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
    this.blitFn(last);

    this.bloomBlurProgram.bind();
    for (let i = 0; i < this.bloomFramebuffers.length; i++) {
      const dest = this.bloomFramebuffers[i];
      gl.uniform2f(this.bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
      gl.uniform1i(this.bloomBlurProgram.uniforms.uTexture, last.attach(0));
      this.blitFn(dest);
      last = dest;
    }

    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);

    for (let i = this.bloomFramebuffers.length - 2; i >= 0; i--) {
      const baseTex = this.bloomFramebuffers[i];
      gl.uniform2f(this.bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
      gl.uniform1i(this.bloomBlurProgram.uniforms.uTexture, last.attach(0));
      gl.viewport(0, 0, baseTex.width, baseTex.height);
      this.blitFn(baseTex);
      last = baseTex;
    }

    gl.disable(gl.BLEND);
    this.bloomFinalProgram.bind();
    gl.uniform2f(this.bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(this.bloomFinalProgram.uniforms.uTexture, last.attach(0));
    gl.uniform1f(this.bloomFinalProgram.uniforms.intensity, this.config.BLOOM_INTENSITY);
    this.blitFn(destination);
  }

  private applySunrays(source: FBO, mask: FBO, destination: FBO): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.sunraysMaskProgram.bind();
    gl.uniform1i(this.sunraysMaskProgram.uniforms.uTexture, source.attach(0));
    this.blitFn(mask);

    this.sunraysProgram.bind();
    gl.uniform1f(this.sunraysProgram.uniforms.weight, this.config.SUNRAYS_WEIGHT);
    gl.uniform1i(this.sunraysProgram.uniforms.uTexture, mask.attach(0));
    this.blitFn(destination);
  }

  private blur(target: FBO, temp: FBO, iterations: number): void {
    const gl = this.gl;
    this.blurProgram.bind();
    for (let i = 0; i < iterations; i++) {
      gl.uniform2f(this.blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
      gl.uniform1i(this.blurProgram.uniforms.uTexture, target.attach(0));
      this.blitFn(temp);

      gl.uniform2f(this.blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
      gl.uniform1i(this.blurProgram.uniforms.uTexture, temp.attach(0));
      this.blitFn(target);
    }
  }

  private correctRadius(radius: number): number {
    const aspectRatio = this.canvas.width / Math.max(this.canvas.height, 1);
    return aspectRatio > 1 ? radius * aspectRatio : radius;
  }

  private correctDeltaX(delta: number): number {
    const aspectRatio = this.canvas.width / Math.max(this.canvas.height, 1);
    return aspectRatio < 1 ? delta * aspectRatio : delta;
  }

  private correctDeltaY(delta: number): number {
    const aspectRatio = this.canvas.width / Math.max(this.canvas.height, 1);
    return aspectRatio > 1 ? delta / aspectRatio : delta;
  }

  private getResolution(resolution: number): { width: number; height: number } {
    const gl = this.gl;
    const w = Math.max(gl.drawingBufferWidth, 2);
    const h = Math.max(gl.drawingBufferHeight, 2);
    let aspectRatio = w / h;
    if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;
    const min = Math.round(resolution);
    const max = Math.round(resolution * aspectRatio);
    return w > h ? { width: max, height: min } : { width: min, height: max };
  }

  private attachPointerEvents(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const posX = scaleByPixelRatio(e.clientX - rect.left);
      const posY = scaleByPixelRatio(e.clientY - rect.top);
      this.pointer.down = true;
      this.pointer.moved = false;
      this.pointer.texcoordX = posX / Math.max(this.canvas.width, 1);
      this.pointer.texcoordY = 1.0 - posY / Math.max(this.canvas.height, 1);
      this.pointer.prevTexcoordX = this.pointer.texcoordX;
      this.pointer.prevTexcoordY = this.pointer.texcoordY;
      this.pointer.deltaX = 0;
      this.pointer.deltaY = 0;
      this.pointer.color = generateColor();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.pointer.down && e.buttons === 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const posX = scaleByPixelRatio(e.clientX - rect.left);
      const posY = scaleByPixelRatio(e.clientY - rect.top);
      this.pointer.prevTexcoordX = this.pointer.texcoordX;
      this.pointer.prevTexcoordY = this.pointer.texcoordY;
      this.pointer.texcoordX = posX / Math.max(this.canvas.width, 1);
      this.pointer.texcoordY = 1.0 - posY / Math.max(this.canvas.height, 1);
      this.pointer.deltaX = this.correctDeltaX(this.pointer.texcoordX - this.pointer.prevTexcoordX);
      this.pointer.deltaY = this.correctDeltaY(this.pointer.texcoordY - this.pointer.prevTexcoordY);
      this.pointer.moved = Math.abs(this.pointer.deltaX) > 0 || Math.abs(this.pointer.deltaY) > 0;
    });

    window.addEventListener('pointerup', () => {
      this.pointer.down = false;
    });
  }
}

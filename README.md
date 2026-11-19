# HAND·OSC — MediaPipe Manos, Gestos, Esqueleto Pose + OSC Multipuerto + Control Sonoro

Aplicación web en tiempo real para rastrear **manos, dedos, falanges, gestos y esqueleto corporal completo** mediante **MediaPipe Tasks Vision** (`GestureRecognizer`, `HandLandmarker` y `PoseLandmarker`), transmitir cada flujo por **protocolo OSC 1.0 sobre UDP en puertos independientes** y manipular frecuencias sonoras mediante gestos con un sintetizador **Web Audio API**.

---

## Características principales

- **Tracking de Manos, Dedos y Falanges (MediaPipe Tasks Vision autoalojado)**
  - Detección de hasta **2 manos simultáneas** (`left` / `right`) y **21 landmarks 3D** por mano usando activos locales (`public/mediapipe/wasm`, `gesture_recognizer.task` con fallback a `hand_landmarker.task`), con fallback automático `GPU → CPU`.
  - Cálculo cinemático 3D independiente de la distancia a cámara (basado en `worldLandmarks`) para las **3 falanges de cada dedo** (`proximal`, `intermediate`, `distal`): ángulo articular en grados (`°`) y flexión normalizada (`0..1`).
  - Cálculo de `curl` y extensión por dedo, separación entre dedos (`spread`), distancias de **Pinch** (`Pulgar` vs `Índice`, `Medio`, `Anular`, `Meñique`), centro de palma (`XYZ`), apertura global, velocidad y orientación (`pitch`, `yaw`, `roll`), con suavizado temporal EMA configurable.
  - **Simulador de Mano Virtual** integrado (`theremin_wave`, `pinch_sweep` y `manual`) para probar falanges, paquetes OSC y síntesis sonora sin necesidad de cámara física.

- **Esqueleto Corporal Completo (`PoseLandmarker` · 33 puntos)**
  - Detección simultánea de cuerpo completo (en modo `Manos + Pose`, `Solo Manos/Gestos` o `Solo Esqueleto`) usando `pose_landmarker_lite.task` con suavizado EMA configurable.
  - Cálculo 3D de ángulos articulares (`Codos`, `Hombros`, `Caderas`, `Rodillas`), centro de masa (cadera), centro de hombros e inclinación/torsión del torso (`forwardDeg`, `lateralDeg`, `twistDeg`).

- **Lista de Detección de Gestos (`GestureRecognizer` + Cinemática + Pose)**
  - Combina los gestos nativos de MediaPipe (`Palma Abierta`, `Puño Cerrado`, `Índice Arriba`, `Victoria / Paz`, `Pulgar Arriba`, `Pulgar Abajo`, `Te Amo`), gestos biomecánicos por falanges/pinch (`Pinch Índice`, `Pinch Medio`, `Cuernos / Rock`) y gestos corporales (`Brazos Arriba`, `Pose en T`, `Manos Juntas`, `Sentadilla`).
  - Lista filtrable por lado (`Todos`, `Der`, `Izq`, `Cuerpo`) con barras de confianza en vivo, activación individual por checkbox e historial de eventos disparados.

- **Puente OSC 1.0 sobre UDP en 3 Módulos y Puertos Independientes**
  - El navegador envía la telemetría por WebSocket (`/osc`) al servidor Node.js ([server/index.mjs](server/index.mjs)), que enruta datagramas binarios **OSC 1.0 sobre UDP** hacia **3 destinos independientes**:
    - **Módulo Principal** (puerto `9000` por defecto): manos/falanges (`/hand/*`), sintetizador (`/synth/*`) y pulsadores (`/td/pad/*`).
    - **Módulo Aparte — Gestos** (puerto `9001` por defecto): gestos detectados (`/gestures/*`).
    - **Módulo Aparte — Esqueleto** (puerto `9002` por defecto): pose y articulaciones de cuerpo completo (`/pose/*`).
  - Cada módulo tiene su propia IP destino, puerto UDP, modo (`OSC Bundle` o `Mensajes Individuales`), límite de tasa (`Hz`), prueba de envío y monitor OSC en vivo. Compatible con TouchDesigner, Max/MSP, Pure Data, Ableton Live, Resolume, SuperCollider y VCV Rack.

- **Sistema de Pulsadores / Zonas Interactivas OSC para TouchDesigner (`Pulsadores (TD)`)**
  - Crea áreas rectangulares o circulares sobre el visor de cámara y edita su **posición (`X, Y`)**, **tamaño (`Ancho/Alto` o `Diámetro`)**, **dirección OSC personalizada** (ej. `/td/pad/1`), color y filtro de mano (`Cualquiera`, `Derecha`, `Izquierda`).
  - **Edición directa con el cursor sobre el video** (`Edición Mouse: ON` por defecto, bloqueable con un clic): arrastra una zona para moverla, usa cualquiera de sus **8 manijas** (esquinas y bordes en rectángulo; 4 manijas en círculo) o la **rueda del mouse** para cambiar tamaño, arrastra sobre un espacio vacío o haz **doble clic** para dibujar un nuevo pulsador, edita su dirección OSC/modo/forma desde la barra flotante sobre el visor y mueve/elimina con las flechas o `Supr`.
  - **3 tipos de trigger** con anti-rebote (*cooldown*):
    - **Pulso (`pulse`)**: dispara `1` durante una duración configurable (`40–1000 ms`) al ingresar al área y vuelve a `0`.
    - **Mantener (`momentary`)**: mantiene `1` mientras la mano o dedo permanezca dentro del área y vuelve a `0` al salir.
    - **Interruptor (`toggle`)**: alterna `0 ↔ 1` cada vez que el elemento ingresa al área.
  - Selección del elemento detector: cualquier punto de la mano, centro de palma, cualquier punta de dedo, dedo específico (`Índice`, `Pulgar`, `Medio`, `Anular`, `Meñique`), pinch activo, muñecas del esqueleto Pose (`pose_wrists`) o cualquier punto del cuerpo Pose (`pose_any`).

- **Ejemplo de Control Sonoro para Manipular Frecuencias**
  - Sintetizador polivalente basado en **Web Audio API** ([src/audio/synthEngine.ts](src/audio/synthEngine.ts)) con oscilador principal (`sine`, `triangle`, `sawtooth`, `square`), sub-oscilador (`-1` octava), modulador armónico FM, vibrato LFO, filtro paso bajo resonante, delay y compresor limitador.
  - **3 modos de control gestual de frecuencia**:
    1. **Teremin (`theremin`)**: la altura vertical de la palma (`Y`) controla la frecuencia fundamental (`Hz`) en escala logarítmica; la falange distal del índice aplica micro *pitch-bend* en modo libre; el índice controla el corte del filtro (`Hz`); el medio la modulación FM; el anular la tasa/profundidad del vibrato LFO (`Hz`) y el meñique el sub-oscilador y eco.
    2. **Pinch (`pinch-pitch`)**: la apertura entre pulgar e índice manipula directamente la frecuencia fundamental (`Hz`), la falange media del índice el filtro y los demás dedos FM/LFO/sub.
    3. **Dual 2 Manos (`dual-hand`)**: la mano derecha manipula la frecuencia fundamental y filtro; la mano izquierda manipula la profundidad/ratio FM y el volumen (con fallback automático a 1 mano).
  - Cuantizador musical (`Libre Hz`, `Pentatónica Menor`, `Mayor`, `Menor Natural`, `Dórica`, `Cromática`), portamento/glide configurable y visualizador a **60 FPS** con espectro **FFT logarítmico + osciloscopio**.

---

## Requisitos

- **Node.js** `v20` o superior (probado en `v22.17.1`) y `npm`.
- Navegador moderno con soporte WebGL/WASM y Web Audio API (Chrome, Edge, Safari o Firefox).
- *(Opcional)* Cámara web para tracking en vivo (o usar el **Simulador Virtual** integrado).

---

## Ejecución rápida con lanzadores (doble clic)

### Windows (`.bat`)
1. Haz doble clic en **`instalar.bat`**: verifica Node.js/npm, instala dependencias, prepara el runtime WASM + modelo de MediaPipe y compila `dist/`.
2. Haz doble clic en **`abrir_webapp.bat`**: inicia el servidor + puente OSC UDP y abre `http://localhost:3000` en tu navegador.

### macOS (`.command`)
> macOS no ejecuta archivos `.bat` de Windows de forma nativa; se incluyen lanzadores `.command` equivalentes con formato LF.

1. La primera vez, abre Terminal en la carpeta del proyecto y otorga permisos de ejecución:
   ```bash
   chmod +x instalar_mac.command abrir_webapp_mac.command
   ```
2. Haz doble clic en **`instalar_mac.command`** para instalar dependencias, activos de MediaPipe y compilar.
3. Haz doble clic en **`abrir_webapp_mac.command`** para iniciar el servidor y abrir `http://localhost:3000`.

---

## Ejecución manual por consola

```bash
# 1. Clonar e instalar dependencias (postinstall prepara WASM y descarga los 3 modelos .task)
git clone https://github.com/tolchx/mediapipe_webapp.git
cd mediapipe_webapp
npm install

# 2a. Modo desarrollo (Puente OSC en :3001 + Vite con Hot Reload en :5173)
npm run dev

# 2b. Modo producción (compilar dist/ y servir en :3000)
npm run build
npm start
```

### Comandos útiles adicionales

| Comando | Descripción |
| :--- | :--- |
| `npm run dev` | Inicia el puente OSC (`3001`) y Vite (`5173`) simultáneamente |
| `npm run build` | Verifica tipos TypeScript (`tsc --noEmit`) y compila en `dist/` |
| `npm start` | Sirve la build de producción y el puente OSC en `http://localhost:3000` |
| `npm test` | Ejecuta todas las pruebas unitarias y de integración (`tests/*.test.mjs`) |
| `npm run osc:listen` | Escucha e imprime paquetes OSC UDP en los puertos `9000`, `9001` y `9002` (o los puertos indicados en CLI, ej. `npm run osc:listen -- 9001 9002`) |
| `npm run setup:assets` | Copia WASM local y descarga `hand_landmarker.task`, `gesture_recognizer.task` y `pose_landmarker_lite.task` si faltan |

Variables de entorno opcionales para el servidor (`server/index.mjs`):
- `PORT` (por defecto `3000`)
- `OSC_HOST` (por defecto `127.0.0.1`)
- `OSC_PORT` (puerto módulo principal, por defecto `9000`)
- `OSC_GESTURES_PORT` (puerto módulo Gestos, por defecto `9001`)
- `OSC_SKELETON_PORT` (puerto módulo Esqueleto/Pose, por defecto `9002`)

### Despliegue estático / Modo Web y Puente Local Opcional

La compilación (`npm run build`) genera activos con rutas relativas (`base: './'` en [vite.config.ts](vite.config.ts)) e incluye [public/.htaccess](public/.htaccess) (MIME types `.wasm` / `.task`, `Permissions-Policy: camera=(self)`, CSP con soporte `wasm-unsafe-eval` y enrutamiento para subdirectorio `/mediapipeweb/`).

- Si la webapp se sirve desde un hosting estático sin backend Node.js en el mismo origen, entra automáticamente en **Modo Web (Monitor local)** sin errores de reconexión: el tracking de MediaPipe, los pulsadores y el sintetizador Web Audio funcionan 100% en el navegador.
- Desde la pestaña **OSC Principal**, puedes indicar la URL de un puente WebSocket local (por defecto `ws://127.0.0.1:3000/osc`) y pulsar **Conectar Puente** si deseas reenviar paquetes OSC UDP hacia TouchDesigner en tu máquina local mientras usas la versión web alojada online.

---

## Mapa anatómico de dedos y falanges

Para cada dedo (`thumb`, `index`, `middle`, `ring`, `pinky`) se calculan tres segmentos (`proximal`, `intermediate`, `distal`) usando ángulos vectoriales 3D sobre `worldLandmarks`:

| Dedo | `proximal` | `intermediate` | `distal` |
| :--- | :--- | :--- | :--- |
| `thumb` (Pulgar) | Metacarpiano (`CMC` · `0-1-2`) | Falange Proximal (`MCP` · `1-2-3`) | Falange Distal (`IP` · `2-3-4`) |
| `index` (Índice) | Falange Proximal (`MCP` · `0-5-6`) | Falange Media (`PIP` · `5-6-7`) | Falange Distal (`DIP` · `6-7-8`) |
| `middle` (Medio) | Falange Proximal (`MCP` · `0-9-10`) | Falange Media (`PIP` · `9-10-11`) | Falange Distal (`DIP` · `10-11-12`) |
| `ring` (Anular) | Falange Proximal (`MCP` · `0-13-14`) | Falange Media (`PIP` · `13-14-15`) | Falange Distal (`DIP` · `14-15-16`) |
| `pinky` (Meñique) | Falange Proximal (`MCP` · `0-17-18`) | Falange Media (`PIP` · `17-18-19`) | Falange Distal (`DIP` · `18-19-20`) |

---

## Referencia de direcciones OSC

`{side}` toma el valor `left` o `right`. `{finger}` toma `thumb`, `index`, `middle`, `ring` o `pinky`. `{phalanx}` toma `proximal`, `intermediate` o `distal`.

### Palma y detección
| Dirección OSC | Tipos | Descripción |
| :--- | :--- | :--- |
| `/hand/{side}/detected` | `i` | `1` si la mano está presente, `0` si no |
| `/hand/{side}/palm/xyz` | `fff` | Centro de palma normalizado `(x, y, z)` |
| `/hand/{side}/palm/openness` | `f` | Apertura promedio de la mano (`0..1`) |
| `/hand/{side}/palm/orientation` | `fff` | Orientación `(pitch, yaw, roll)` en grados |
| `/hand/{side}/palm/velocity` | `f` | Velocidad suavizada de desplazamiento de palma |

### Dedos y Pinch
| Dirección OSC | Tipos | Descripción |
| :--- | :--- | :--- |
| `/hand/{side}/finger/{finger}/curl` | `f` | Flexión total del dedo (`0` recto .. `1` cerrado) |
| `/hand/{side}/finger/{finger}/extended` | `f` | Extensión total del dedo (`1 - curl`) |
| `/hand/{side}/finger/spread` | `ffff` | Apertura entre dedos adyacentes (`0..1`) |
| `/hand/{side}/pinch/{index\|middle\|ring\|pinky}` | `ffi` | `(closeness 0..1, distanceNorm, active 0\|1)` |

### Falanges individuales
| Dirección OSC | Tipos | Descripción |
| :--- | :--- | :--- |
| `/hand/{side}/phalanx/{finger}/{phalanx}/angle` | `f` | Ángulo de flexión articular en grados (`°`) |
| `/hand/{side}/phalanx/{finger}/{phalanx}/flex` | `f` | Flexión normalizada (`0..1`) |

### Landmarks raw (canal opcional)
| Dirección OSC | Tipos | Descripción |
| :--- | :--- | :--- |
| `/hand/{side}/landmark/{0..20}` | `fff` | Coordenadas normalizadas de imagen `(x, y, z)` |
| `/hand/{side}/world_landmark/{0..20}` | `fff` | Coordenadas métricas 3D en metros `(x, y, z)` |

### Pulsadores / Zonas TouchDesigner
Por cada pulsador habilitado (con su dirección configurable `{oscAddress}`, por defecto `/td/pad/1`, `/td/pad/2`, ...):

| Dirección OSC | Tipos | Descripción |
| :--- | :--- | :--- |
| `{oscAddress}` | `i` | Estado lógico del pulsador (`1` activo / pulso, `0` inactivo) |
| `{oscAddress}/inside` | `i` | `1` si el elemento detector está físicamente dentro del área *(subcanal opcional)* |
| `{oscAddress}/xy` | `ff` | Posición normalizada `(localX, localY)` `0..1` dentro del área *(subcanal opcional)* |
| `{oscAddress}/count` | `i` | Contador acumulado de activaciones *(subcanal opcional)* |

### Control Sonoro / Frecuencia
| Dirección OSC | Tipos | Descripción |
| :--- | :--- | :--- |
| `/synth/active` | `i` | `1` si el audio del sintetizador está encendido, `0` si no |
| `/synth/frequency` | `f` | Frecuencia fundamental cuantizada (`Hz`) |
| `/synth/raw_frequency` | `f` | Frecuencia continua antes del cuantizador (`Hz`) |
| `/synth/midi` | `f` | Nota MIDI equivalente |
| `/synth/cutoff` | `f` | Frecuencia de corte del filtro low-pass (`Hz`) |
| `/synth/resonance` | `f` | Resonancia del filtro (`Q`) |
| `/synth/fm_depth` | `f` | Profundidad de modulación FM (`Hz`) |
| `/synth/lfo_rate` | `f` | Frecuencia del LFO de vibrato (`Hz`) |
| `/synth/lfo_depth` | `f` | Profundidad de vibrato (`Hz`) |
| `/synth/gain` | `f` | Ganancia de salida (`0..1`) |

### Módulo Aparte: OSC Gestos (Puerto `9001` por defecto)
| Dirección OSC | Tipos | Descripción |
| :--- | :--- | :--- |
| `/gestures/active_count` | `i` | Cantidad total de gestos activos en el frame |
| `/gestures/{left\|right}/top` | `sf` | `(slug, confidence)` del gesto principal de cada mano |
| `/gestures/{left\|right\|body}/active/{slug}` | `i` | `1` cuando el gesto está activo, `0` cuando no (`open_palm`, `closed_fist`, `pointing_up`, `victory`, `thumb_up`, `thumb_down`, `i_love_you`, `pinch_index`, `pinch_middle`, `rock_horns`, `arms_up`, `t_pose`, `hands_together`, `squat_crouch`) |
| `/gestures/{left\|right\|body}/score/{slug}` | `f` | Nivel de confianza normalizado (`0..1`) |

### Módulo Aparte: OSC Esqueleto / Pose (Puerto `9002` por defecto)
| Dirección OSC | Tipos | Descripción |
| :--- | :--- | :--- |
| `/pose/detected` | `i` | `1` si se detecta un cuerpo, `0` si no |
| `/pose/count` | `i` | Número de poses detectadas |
| `/pose/0/center` | `fff` | Centro de masa (cadera) `(x, y, z)` |
| `/pose/0/shoulder_center` | `fff` | Centro de hombros `(x, y, z)` |
| `/pose/0/lean` | `fff` | Inclinación del torso `(forwardDeg, lateralDeg, twistDeg)` |
| `/pose/0/visibility` | `f` | Visibilidad promedio del esqueleto (`0..1`) |
| `/pose/0/angles` | `ffffffff` | 8 ángulos articulares en grados (`leftElbow`, `rightElbow`, `leftShoulder`, `rightShoulder`, `leftHip`, `rightHip`, `leftKnee`, `rightKnee`) |
| `/pose/0/angle/{joint}` | `f` | Ángulo individual por articulación (`left_elbow`, `right_elbow`, `left_shoulder`, `right_shoulder`, `left_hip`, `right_hip`, `left_knee`, `right_knee`) |
| `/pose/0/joint/{name}` | `ffff` | `(x, y, z, visibility)` de las 13 articulaciones principales (`nose`, `left_shoulder`, `right_shoulder`, `left_elbow`, `right_elbow`, `left_wrist`, `right_wrist`, `left_hip`, `right_hip`, `left_knee`, `right_knee`, `left_ankle`, `right_ankle`) |
| `/pose/0/landmark/{0..32}` | `ffff` | Coordenadas normalizadas `(x, y, z, visibility)` *(canal opcional)* |
| `/pose/0/world_landmark/{0..32}` | `ffff` | Coordenadas métricas 3D en metros `(x, y, z, visibility)` *(canal opcional)* |

---

## Edición directa de Pulsadores con el mouse

Con `Edición Mouse: ON` activo en la barra del visor (activado por defecto; pulsa de nuevo para pasar a `Edición Bloqueada` durante presentaciones en vivo):

| Acción | Comportamiento |
| :--- | :--- |
| **Arrastrar el área** | Mueve la posición `(X, Y)` del pulsador sobre la cámara |
| **Arrastrar manijas (8 en rect / 4 en círculo)** | Redimensiona manteniendo el borde opuesto anclado (`Alt + arrastrar` escala simétricamente desde el centro) |
| **Rueda del mouse sobre un área** | Escala rápidamente el tamaño de la zona |
| **Arrastrar sobre espacio vacío** | Dibuja y crea un nuevo pulsador con ese tamaño y posición |
| **Doble clic sobre espacio vacío** | Crea un nuevo pulsador centrado en el cursor |
| **Barra flotante sobre la zona** | Permite editar dirección OSC, ciclar `Pulso / Mantener / Toggle`, alternar `Rect / Círculo`, elegir detector, duplicar (`⧉`) o eliminar (`✕`) |
| **Flechas / `Shift + Flechas` / `Supr`** | Mueve la zona seleccionada en pasos finos o amplios, o la elimina |

---

## Estructura del proyecto

```text
mediapipe_webapp/
├── index.html                  # Interfaz principal de la aplicación
├── package.json                # Scripts y dependencias
├── tsconfig.json               # Configuración estricta de TypeScript
├── vite.config.ts              # Configuración Vite (base: './') y proxy WebSocket /osc
├── public/
│   └── .htaccess               # Cabeceras Apache, MIME WASM/task y SPA /mediapipeweb/
├── instalar.bat                # Instalador doble clic para Windows
├── abrir_webapp.bat            # Lanzador doble clic para Windows
├── instalar_mac.command        # Instalador doble clic para macOS
├── abrir_webapp_mac.command    # Lanzador doble clic para macOS
├── scripts/
│   ├── dev.mjs                 # Arranca puente OSC + servidor Vite en desarrollo
│   └── setup-assets.mjs        # Copia WASM local y descarga modelos MediaPipe (.task)
├── server/
│   ├── index.mjs               # Servidor Express + WebSocket + puente OSC UDP multipuerto
│   └── osc-listen.mjs          # Monitor CLI multipuerto para inspeccionar paquetes OSC UDP
├── src/
│   ├── main.ts                 # Bucle principal, estado de UI y sincronización
│   ├── styles.css              # Diseño de interfaz de estudio oscuro
│   ├── types/hand.ts           # Tipos compartidos (manos, pose, gestos, OSC, synth)
│   ├── vision/
│   │   ├── handTracker.ts      # GestureRecognizer, HandLandmarker, PoseLandmarker y simulador
│   │   ├── handKinematics.ts   # Cálculo 3D de falanges, ángulos, pinch y palma
│   │   ├── poseKinematics.ts   # Cálculo 3D del esqueleto corporal (33 puntos y ángulos)
│   │   ├── gestureEngine.ts    # Lista unificada de gestos nativos, 3D y de pose
│   │   ├── handRenderer.ts     # Renderizado de pose, manos, falanges, gestos y pulsadores
│   │   └── triggerZones.ts     # Motor de zonas/pulsadores (pulso, mantener, toggle)
│   ├── audio/
│   │   ├── synthEngine.ts      # Sintetizador Web Audio controlado por gestos
│   │   └── audioVisualizer.ts  # Visualizador FFT de espectro + osciloscopio
│   └── osc/
│       ├── oscClient.ts        # Cliente WebSocket multipuerto hacia el puente OSC UDP
│       └── oscProtocol.ts      # Serializadores OSC independientes (Principal, Gestos, Pose)
└── tests/
    ├── osc-server.test.mjs     # Test de integración WebSocket -> OSC UDP
    ├── pose-gestures.test.mjs  # Tests de esqueleto Pose, gestos y ruteo multipuerto
    └── trigger-zones.test.mjs  # Tests unitarios de pulsadores y serialización OSC
```

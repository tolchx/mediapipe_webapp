import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDest = path.join(root, 'public', 'mediapipe', 'wasm');
const modelsDir = path.join(root, 'public', 'models');

const MODELS = [
  {
    name: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
  {
    name: 'gesture_recognizer.task',
    url: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
  },
  {
    name: 'pose_landmarker_lite.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  },
];

fs.mkdirSync(wasmDest, { recursive: true });
fs.mkdirSync(modelsDir, { recursive: true });

if (fs.existsSync(wasmSrc)) {
  for (const file of fs.readdirSync(wasmSrc)) {
    fs.copyFileSync(path.join(wasmSrc, file), path.join(wasmDest, file));
  }
  console.log('[setup:assets] Copied MediaPipe WASM assets -> public/mediapipe/wasm');
} else {
  console.warn('[setup:assets] Warning: @mediapipe/tasks-vision wasm folder not found.');
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          downloadFile(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        file.close();
        reject(err);
      });
  });
}

for (const model of MODELS) {
  const modelFile = path.join(modelsDir, model.name);
  if (fs.existsSync(modelFile) && fs.statSync(modelFile).size > 1_000_000) {
    console.log(`[setup:assets] Model already exists -> public/models/${model.name}`);
  } else {
    console.log(`[setup:assets] Downloading ${model.name}...`);
    await downloadFile(model.url, modelFile);
    console.log(`[setup:assets] Model downloaded -> public/models/${model.name}`);
  }
}

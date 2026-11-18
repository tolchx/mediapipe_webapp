import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDest = path.join(root, 'public', 'mediapipe', 'wasm');
const modelsDir = path.join(root, 'public', 'models');
const modelFile = path.join(modelsDir, 'hand_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

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

if (fs.existsSync(modelFile) && fs.statSync(modelFile).size > 1_000_000) {
  console.log('[setup:assets] Model already exists -> public/models/hand_landmarker.task');
} else {
  console.log('[setup:assets] Downloading hand_landmarker.task...');
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(modelFile);
    https
      .get(MODEL_URL, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https.get(res.headers.location, (redirectRes) => {
            redirectRes.pipe(file);
            file.on('finish', () => file.close(resolve));
          }).on('error', reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
  console.log('[setup:assets] Model downloaded -> public/models/hand_landmarker.task');
}

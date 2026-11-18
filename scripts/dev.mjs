import { spawn } from 'node:child_process';
import process from 'node:process';

const bridge = spawn(process.execPath, ['server/index.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.BRIDGE_PORT || '3001', DEV_MODE: '1' },
});

const vite = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite'],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  }
);

function shutdown(code = 0) {
  if (!bridge.killed) bridge.kill('SIGTERM');
  if (!vite.killed) vite.kill('SIGTERM');
  process.exit(code);
}

bridge.on('exit', (code) => {
  if (code !== null && code !== 0) shutdown(code);
});

vite.on('exit', (code) => {
  shutdown(code ?? 0);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

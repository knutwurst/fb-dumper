import { spawn } from 'node:child_process';

const children = new Set();

const HINTS = {
  'yt-dlp': 'brew install yt-dlp',
  ffmpeg: 'brew install ffmpeg',
  ffprobe: 'brew install ffmpeg',
};

export function run(cmd, args, { stdio = 'inherit', capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : stdio });
    children.add(child);
    let out = '';
    if (capture) child.stdout.on('data', d => (out += d));
    child.on('error', err => {
      children.delete(child);
      reject(err.code === 'ENOENT' ? new Error(`${cmd} not found on PATH (${HINTS[cmd] ?? 'install it'})`) : err);
    });
    child.on('close', code => {
      children.delete(child);
      resolve(capture ? { code, out } : code);
    });
  });
}

export function killChildren() {
  for (const child of children) child.kill('SIGTERM');
}

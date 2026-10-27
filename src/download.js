import { spawn } from 'node:child_process';
import { join } from 'node:path';

export function downloadAll({ linksFile, outDir, cookieArgs, extraArgs = [] }) {
  const args = [
    '--batch-file', linksFile,
    ...cookieArgs,
    '--format', 'hd/bv*[vcodec^=avc1]+ba/sd/bv*+ba/b',
    '--download-archive', join(outDir, 'archive.txt'),
    '--paths', outDir,
    '--output', '%(upload_date)s_%(id)s.%(ext)s',
    '--sleep-interval', '3',
    '--max-sleep-interval', '8',
    '--ignore-errors',
    '--no-overwrites',
    ...extraArgs,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: 'inherit' });
    child.on('error', err =>
      reject(err.code === 'ENOENT' ? new Error('yt-dlp not found on PATH (brew install yt-dlp ffmpeg)') : err),
    );
    child.on('close', resolve);
  });
}

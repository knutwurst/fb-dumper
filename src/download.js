import { join } from 'node:path';
import { run } from './proc.js';

export function downloadAll({ linksFile, outDir, cookieArgs, extraArgs = [] }) {
  return run('yt-dlp', [
    '--batch-file', linksFile,
    ...cookieArgs,
    '--format', 'hd/bv*[vcodec^=avc1]+ba/sd/bv*+ba/b',
    '--download-archive', join(outDir, 'archive.txt'),
    '--paths', outDir,
    '--output', '%(upload_date|undated)s_%(id)s.%(ext)s',
    '--sleep-interval', '3',
    '--max-sleep-interval', '8',
    '--ignore-errors',
    '--no-overwrites',
    '--newline',
    ...extraArgs,
  ]);
}

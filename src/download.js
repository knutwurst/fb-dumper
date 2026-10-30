import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.js';

const FORMATS = {
  hd: 'hd/bv*[vcodec^=avc1]+ba/sd/bv*+ba/b',
  full: 'bv*+ba/b',
};

export function downloadAll({ linksFile, outDir, cookieArgs, quality = 'hd', extraArgs = [], log = console.log }) {
  const count = readFileSync(linksFile, 'utf8').split('\n').filter(Boolean).length;
  log(`Downloading ${count} video${count === 1 ? '' : 's'}`);
  return run('yt-dlp', [
    '--batch-file', linksFile,
    ...cookieArgs,
    '--format', FORMATS[quality],
    '--download-archive', join(outDir, 'archive.txt'),
    '--paths', outDir,
    '--output', '%(upload_date|undated)s_%(id)s.%(ext)s',
    '--ignore-errors',
    '--no-overwrites',
    '--newline',
    ...extraArgs,
  ]);
}

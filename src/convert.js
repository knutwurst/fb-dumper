import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.js';

async function videoCodec(file) {
  const { out } = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file],
    { capture: true },
  );
  return out.trim();
}

export async function convertToH264(outDir, log = console.log) {
  const pending = [];
  for (const name of readdirSync(outDir).filter(f => f.endsWith('.mp4') && !f.startsWith('.'))) {
    if ((await videoCodec(join(outDir, name))) !== 'h264') pending.push(name);
  }

  let failed = 0;
  for (const [i, name] of pending.entries()) {
    log(`Converting ${i + 1}/${pending.length}: ${name}`);
    const src = join(outDir, name);
    const tmp = join(outDir, `.${name}.h264.mp4`);
    const code = await run('ffmpeg', [
      '-v', 'error', '-y', '-i', src,
      '-map', '0:v:0', '-map', '0:a?',
      '-c:v', 'h264_videotoolbox', '-q:v', '65', '-tag:v', 'avc1',
      '-c:a', 'copy', '-movflags', '+faststart',
      tmp,
    ]);
    if (code === 0) renameSync(tmp, src);
    else {
      rmSync(tmp, { force: true });
      failed++;
    }
  }
  return { converted: pending.length - failed, failed };
}

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function removeMacJunk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) removed += removeMacJunk(path);
    else if (entry.name === '.DS_Store' || entry.name.startsWith('._')) {
      rmSync(path, { force: true });
      removed++;
    }
  }
  return removed;
}

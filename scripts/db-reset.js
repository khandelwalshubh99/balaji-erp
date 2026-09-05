/** Delete the local synced copy. Tally is untouched — this only clears the mirror. */
import fs from 'node:fs';
import { config } from '../src/config.js';

for (const suffix of ['', '-wal', '-shm']) {
  const p = config.dbPath + suffix;
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log('removed', p);
  }
}
console.log('Local store cleared. Next start will re-create it and re-sync.');

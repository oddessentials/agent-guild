// Temp folders for a test file: each is removed after the test that made it, passed or failed. A folder that cannot
// be removed fails that test, since something still holds it.
import { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDirs(prefix, root = os.tmpdir()) {
  const made = [];
  afterEach(() => {
    const failures = [];
    for (const dir of made.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length) throw new AggregateError(failures, `could not remove ${failures.length} temp folder(s): ${failures[0].message}`);
  });
  return () => {
    const dir = fs.mkdtempSync(path.join(root, prefix));
    made.push(dir);
    return dir;
  };
}

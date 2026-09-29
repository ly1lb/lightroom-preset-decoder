// Tiny JSON-file persistence layer. Writes are serialized per file and
// performed atomically (write to temp file, then rename).
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.queues = new Map();
  }

  file(name) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error(`Invalid store name: ${name}`);
    return path.join(this.dir, name);
  }

  async read(name, fallback) {
    try {
      return JSON.parse(await fs.readFile(this.file(name), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return structuredClone(fallback);
      throw err;
    }
  }

  // Runs `mutator(current)` under a per-file lock; the returned value is saved.
  update(name, fallback, mutator) {
    const prev = this.queues.get(name) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const current = await this.read(name, fallback);
        const result = await mutator(current);
        const value = result === undefined ? current : result;
        await fs.mkdir(this.dir, { recursive: true });
        const target = this.file(name);
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
        await fs.rename(tmp, target);
        return value;
      });
    this.queues.set(name, next);
    return next;
  }
}

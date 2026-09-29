// Per-user library of saved presets ("Mano presetai").
import crypto from 'node:crypto';

const MAX_PRESETS = 1000;
const MAX_TEXT = 4 * 1024 * 1024;

export class PresetError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fileFor = (userId) => `presets-${userId}.json`;

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

export class PresetLibrary {
  constructor(store) {
    this.store = store;
  }

  async list(userId) {
    const presets = await this.store.read(fileFor(userId), []);
    return presets.map(({ xmp, lrtemplate, ...meta }) => meta);
  }

  async get(userId, id) {
    const presets = await this.store.read(fileFor(userId), []);
    return presets.find((p) => p.id === id) || null;
  }

  async add(userId, body) {
    const name = cleanText(body?.name, 200);
    const xmp = String(body?.xmp ?? '');
    const lrtemplate = String(body?.lrtemplate ?? '');
    if (!name) throw new PresetError(400, 'Preseto pavadinimas privalomas.');
    if (!xmp.includes('camera-raw-settings')) throw new PresetError(400, 'Netinkamas preseto XMP.');
    if (xmp.length > MAX_TEXT || lrtemplate.length > MAX_TEXT) {
      throw new PresetError(413, 'Presetas per didelis.');
    }
    const preset = {
      id: crypto.randomUUID(),
      name,
      group: cleanText(body?.group, 200),
      sourceFile: cleanText(body?.sourceFile, 300),
      camera: cleanText(body?.camera, 200),
      settingsCount: Number.isFinite(body?.settingsCount) ? body.settingsCount : null,
      createdAt: new Date().toISOString(),
      xmp,
      lrtemplate,
    };
    await this.store.update(fileFor(userId), [], (presets) => {
      if (presets.length >= MAX_PRESETS) {
        throw new PresetError(409, `Pasiektas limitas: ${MAX_PRESETS} presetų.`);
      }
      presets.unshift(preset);
    });
    const { xmp: _x, lrtemplate: _l, ...meta } = preset;
    return meta;
  }

  async remove(userId, id) {
    let removed = false;
    await this.store.update(fileFor(userId), [], (presets) => {
      const idx = presets.findIndex((p) => p.id === id);
      if (idx >= 0) {
        presets.splice(idx, 1);
        removed = true;
      }
    });
    return removed;
  }
}

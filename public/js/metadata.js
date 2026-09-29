// Reads everything we can learn about a photo, fully in the browser.
import * as exifr from '../vendor/exifr/exifr.full.esm.mjs';
import { extractXmpPackets, parseXmp } from './xmp.js';
import { NS } from './preset.js';

const EXIFR_OPTIONS = {
  tiff: true,
  ifd0: true,
  ifd1: true,
  exif: true,
  gps: true,
  interop: true,
  makerNote: true,
  userComment: true,
  xmp: false, // parsed by xmp.js (supports Extended XMP)
  icc: true,
  iptc: true,
  jfif: true,
  ihdr: true,
  mergeOutput: false,
  translateKeys: true,
  translateValues: true,
  reviveValues: true,
  sanitize: true,
  multiSegment: true,
};

async function sha256(buffer) {
  if (!globalThis.crypto?.subtle) return null; // unavailable on plain-HTTP origins
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function histogram(img) {
  const max = 512;
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  let sum = 0;
  let clippedHi = 0;
  let clippedLo = 0;
  for (let i = 0; i < data.length; i += 4) {
    r[data[i]]++;
    g[data[i + 1]]++;
    b[data[i + 2]]++;
    const y = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    l[y]++;
    sum += y;
    if (data[i] >= 254 && data[i + 1] >= 254 && data[i + 2] >= 254) clippedHi++;
    if (data[i] <= 1 && data[i + 1] <= 1 && data[i + 2] <= 1) clippedLo++;
  }
  const n = data.length / 4;
  return { r, g, b, l, mean: sum / n, clippedHi: clippedHi / n, clippedLo: clippedLo / n };
}

function crsSettings(properties) {
  return properties.filter((p) => p.ns === NS.crs);
}

export async function analyzeFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const result = {
    file: {
      name: file.name,
      size: file.size,
      type: file.type || '',
      lastModified: file.lastModified ? new Date(file.lastModified) : null,
      magic: Array.from(bytes.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join(' '),
    },
    exif: {},
    exifError: null,
    xmpPackets: [],
    xmp: { properties: [], namespaces: new Map(), errors: [] },
    crs: [],
    imageUrl: null,
    thumbnailUrl: null,
    image: null,
    histogram: null,
    sha256: null,
  };

  const isSidecar = /\.xmp$/i.test(file.name);

  const [hash] = await Promise.all([
    sha256(buffer).catch(() => null),
    (async () => {
      if (isSidecar) return;
      try {
        result.exif = (await exifr.parse(buffer, EXIFR_OPTIONS)) || {};
      } catch (err) {
        result.exifError = err?.message || String(err);
      }
    })(),
  ]);
  result.sha256 = hash;

  result.xmpPackets = extractXmpPackets(bytes, file.name);
  result.xmp = parseXmp(result.xmpPackets);
  result.crs = crsSettings(result.xmp.properties);

  if (!isSidecar) {
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    if (img) {
      result.imageUrl = url;
      result.image = { width: img.naturalWidth, height: img.naturalHeight };
      try {
        result.histogram = histogram(img);
      } catch {
        /* ignore (e.g. decode limits) */
      }
    } else {
      URL.revokeObjectURL(url);
    }
    try {
      const thumb = await exifr.thumbnail(buffer);
      if (thumb) {
        result.thumbnailUrl = URL.createObjectURL(new Blob([thumb], { type: 'image/jpeg' }));
        if (!result.imageUrl) {
          const timg = await loadImage(result.thumbnailUrl);
          if (timg) result.histogram = histogram(timg);
        }
      }
    } catch {
      /* no embedded thumbnail */
    }
  }
  return result;
}

// --- Summary helpers -----------------------------------------------------------

export function pick(meta, ...keys) {
  const blocks = ['exif', 'ifd0', 'gps', 'iptc', 'icc', 'jfif', 'ihdr', 'interop', 'ifd1'];
  for (const key of keys) {
    for (const block of blocks) {
      const v = meta.exif?.[block]?.[key];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

export function xmpValue(meta, ...names) {
  for (const name of names) {
    const [prefix, local] = name.split(':');
    const ns = meta.xmp.namespaces.get(prefix) || KNOWN_NS[prefix];
    const prop = meta.xmp.properties.find((p) => p.name === local && (!ns || p.ns === ns));
    if (!prop) continue;
    const v = prop.value;
    if (typeof v === 'string') return v;
    if (v.type === 'alt') return v.items[0]?.value;
    if (v.type === 'seq' || v.type === 'bag') return v.items.filter((i) => typeof i === 'string').join(', ');
  }
  return undefined;
}

const KNOWN_NS = {
  xmp: 'http://ns.adobe.com/xap/1.0/',
  dc: 'http://purl.org/dc/elements/1.1/',
  aux: 'http://ns.adobe.com/exif/1.0/aux/',
  exif: 'http://ns.adobe.com/exif/1.0/',
  exifEX: 'http://cipa.jp/exif/1.0/',
  tiff: 'http://ns.adobe.com/tiff/1.0/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
  lr: 'http://ns.adobe.com/lightroom/1.0/',
  xmpMM: 'http://ns.adobe.com/xap/1.0/mm/',
  Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/',
  crs: NS.crs,
};

export function gpsCoordinates(meta) {
  const gps = meta.exif?.gps;
  if (!gps) return null;
  if (typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
    return { lat: gps.latitude, lon: gps.longitude, alt: gps.GPSAltitude };
  }
  const toDec = (v, ref) => {
    if (!Array.isArray(v)) return typeof v === 'number' ? v : null;
    const [d = 0, m = 0, s = 0] = v.map(Number);
    const dec = d + m / 60 + s / 3600;
    return /^[SW]/i.test(String(ref || '')) ? -dec : dec;
  };
  const lat = toDec(gps.GPSLatitude, gps.GPSLatitudeRef);
  const lon = toDec(gps.GPSLongitude, gps.GPSLongitudeRef);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
  let alt = gps.GPSAltitude;
  if (typeof alt === 'number' && (gps.GPSAltitudeRef === 1 || /below/i.test(String(gps.GPSAltitudeRef)))) alt = -alt;
  return { lat, lon, alt };
}

import { h, svg, api, download, copyText, toast } from './dom.js';
import { analyzeFile, pick, xmpValue, gpsCoordinates } from './metadata.js';
import { flatten } from './xmp.js';
import {
  GROUPS, META_KEYS, groupOf, groupSettings, selectSettings, buildPresetXmp, buildLrTemplate, fingerprint, toScalar,
} from './preset.js';
import { crsLabel, sliderRange, EXIF_BLOCK_LABELS } from './labels.js';
import { createZip } from './zip.js';

const state = {
  user: null,
  items: [], // { id, file, status: 'loading'|'ready'|'error', meta, error, preset: { name, group, enabled:Set } }
  selectedId: null,
  tab: 'overview',
  filter: '',
};

const $ = (id) => document.getElementById(id);
let nextId = 1;

// --- Formatting ------------------------------------------------------------------

const LOCALE = 'lt-LT';

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(LOCALE, { maximumFractionDigits: i ? 2 : 0 })} ${units[i]} (${n.toLocaleString(LOCALE)} B)`;
}

function fmtDate(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString(LOCALE, {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtAgo(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const days = (Date.now() - d.getTime()) / 86400000;
  if (days < 0) return '';
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  if (days >= 365) return rtf.format(-Math.floor(days / 365.25), 'year');
  if (days >= 30) return rtf.format(-Math.floor(days / 30.44), 'month');
  if (days >= 1) return rtf.format(-Math.floor(days), 'day');
  return rtf.format(-Math.floor(days * 24), 'hour');
}

function fmtNum(n, digits = 2) {
  return Number(n).toLocaleString(LOCALE, { maximumFractionDigits: digits });
}

function fmtExposure(t) {
  if (!Number.isFinite(t) || t <= 0) return '';
  if (t >= 0.3) return `${fmtNum(t, 1)} s`;
  return `1/${Math.round(1 / t)} s`;
}

function fmtDms(dec, pos, neg) {
  const abs = Math.abs(dec);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  return `${d}° ${m}′ ${s.toFixed(2)}″ ${dec >= 0 ? pos : neg}`;
}

function fmtAny(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return fmtDate(v);
  if (ArrayBuffer.isView(v)) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const hex = Array.from(bytes.subarray(0, 24), (b) => b.toString(16).padStart(2, '0')).join(' ');
    return `[${bytes.length} baitų] ${hex}${bytes.length > 24 ? ' …' : ''}`;
  }
  if (Array.isArray(v)) return v.map(fmtAny).join(', ');
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : fmtNum(v, 6);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, jsonReplacer);
    } catch {
      return String(v);
    }
  }
  return String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
}

function jsonReplacer(key, value) {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (ArrayBuffer.isView(value)) return fmtAny(value);
  return value;
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'presetas';
}

// --- File handling ---------------------------------------------------------------

function defaultPresetState(file) {
  return {
    name: baseName(file.name),
    group: 'Atkurti presetai',
    enabled: new Set(GROUPS.filter((g) => g.defaultOn).map((g) => g.id)),
  };
}

async function addFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  for (const file of files) {
    const item = { id: nextId++, file, status: 'loading', meta: null, error: null, preset: defaultPresetState(file) };
    state.items.push(item);
    if (!state.selectedId) state.selectedId = item.id;
  }
  renderAll();
  for (const item of state.items.filter((i) => i.status === 'loading' && !i.started)) {
    item.started = true;
    try {
      item.meta = await analyzeFile(item.file);
      item.status = 'ready';
    } catch (err) {
      console.error(err);
      item.status = 'error';
      item.error = err?.message || String(err);
    }
    renderAll();
  }
}

function clearFiles() {
  for (const item of state.items) {
    if (item.meta?.imageUrl) URL.revokeObjectURL(item.meta.imageUrl);
    if (item.meta?.thumbnailUrl) URL.revokeObjectURL(item.meta.thumbnailUrl);
  }
  state.items = [];
  state.selectedId = null;
  renderAll();
}

const selected = () => state.items.find((i) => i.id === state.selectedId) || null;

// Settings that describe the "look" (used to detect photos sharing a preset).
const LOOK_GROUPS = ['profile', 'basic', 'presence', 'curve', 'hsl', 'bw', 'grading', 'detail', 'effects', 'calibration'];

function lookFingerprint(meta) {
  const s = selectSettings(meta.crs, LOOK_GROUPS);
  return s.length ? fingerprint(s) : null;
}

function similarityGroups() {
  const byFp = new Map();
  for (const item of state.items) {
    if (item.status !== 'ready') continue;
    const fp = lookFingerprint(item.meta);
    if (!fp) continue;
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(item.id);
  }
  const labels = new Map();
  let letter = 0;
  for (const ids of byFp.values()) {
    if (ids.length < 2) continue;
    const label = String.fromCharCode(65 + (letter++ % 26));
    for (const id of ids) labels.set(id, { label, count: ids.length, index: letter - 1 });
  }
  return labels;
}

// --- Preset generation -------------------------------------------------------------

function crsProp(meta, name) {
  return meta.crs.find((p) => p.name === name)?.value;
}

function presetFiles(item) {
  const { meta, preset } = item;
  const settings = selectSettings(meta.crs, [...preset.enabled]);
  const processVersion = crsProp(meta, 'ProcessVersion');
  const version = crsProp(meta, 'Version');
  const monochrome = /^true$/i.test(String(crsProp(meta, 'ConvertToGrayscale') ?? ''));
  const name = preset.name.trim() || baseName(item.file.name);
  const args = { name, group: preset.group.trim(), settings, processVersion, version, monochrome };
  return {
    name,
    settings,
    xmp: buildPresetXmp({
      ...args,
      description: `Atkurta iš ${item.file.name}`,
    }),
    lrtemplate: buildLrTemplate(args),
  };
}

function cameraName(meta) {
  const make = fmtAny(pick(meta, 'Make'));
  const model = fmtAny(pick(meta, 'Model'));
  if (make && model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return [make, model].filter(Boolean).join(' ');
}

// --- Rendering: sidebar -----------------------------------------------------------

function renderSidebar() {
  const list = $('file-list');
  const sim = similarityGroups();
  list.replaceChildren(
    ...state.items.map((item) => {
      const thumbUrl = item.meta?.imageUrl || item.meta?.thumbnailUrl;
      const s = sim.get(item.id);
      let status;
      if (item.status === 'loading') status = h('span', { class: 'pill' }, 'Analizuojama…');
      else if (item.status === 'error') status = h('span', { class: 'pill danger' }, 'Klaida');
      else if (item.meta.crs.length) {
        const n = item.meta.crs.filter((p) => !META_KEYS.has(p.name)).length;
        status = h('span', { class: 'pill ok' }, `Presetas: ${n} nust.`);
      } else status = h('span', { class: 'pill warn' }, 'Be Lightroom duomenų');
      return h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: `fileitem${item.id === state.selectedId ? ' active' : ''}`,
            'aria-current': item.id === state.selectedId ? 'true' : null,
            onclick: () => {
              state.selectedId = item.id;
              renderAll();
            },
          },
          thumbUrl ? h('img', { src: thumbUrl, alt: '', class: 'thumb' }) : h('span', { class: 'thumb placeholder' }, '◧'),
          h(
            'span',
            { class: 'fileinfo' },
            h('span', { class: 'filename', title: item.file.name }, item.file.name),
            h('span', { class: 'filemeta' }, status,
              s ? h('span', { class: `pill sim sim-${s.index % 6}`, title: `${s.count} nuotraukos turi identišką presetą` }, `Presetas ${s.label}`) : null),
          ),
        ),
      );
    }),
  );
  const ready = state.items.filter((i) => i.status === 'ready' && i.meta.crs.length);
  $('btn-zip').disabled = !ready.length;
  $('btn-clear').disabled = !state.items.length;
}

// --- Rendering: content -----------------------------------------------------------

const TABS = [
  ['overview', 'Apžvalga'],
  ['preset', 'Lightroom presetas'],
  ['all', 'Visa metadata'],
  ['xmp', 'XMP (raw)'],
];

function renderContent() {
  const root = $('content');
  const item = selected();
  if (!item) {
    root.replaceChildren(emptyState());
    return;
  }
  if (item.status === 'loading') {
    root.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner' }), h('p', {}, `Analizuojama: ${item.file.name}`)));
    return;
  }
  if (item.status === 'error') {
    root.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Nepavyko perskaityti failo'), h('p', { class: 'muted' }, item.error)));
    return;
  }
  const { meta } = item;
  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    TABS.map(([id, label]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'tab',
          'aria-selected': String(state.tab === id),
          onclick: () => {
            state.tab = id;
            renderContent();
          },
        },
        label,
        id === 'preset' && meta.crs.length ? h('span', { class: 'dot ok', title: 'Rasti Lightroom nustatymai' }) : null,
      ),
    ),
  );
  let body;
  if (state.tab === 'overview') body = renderOverview(item);
  else if (state.tab === 'preset') body = renderPreset(item);
  else if (state.tab === 'all') body = renderAllMetadata(item);
  else body = renderRawXmp(item);
  root.replaceChildren(renderHero(item), tabs, h('div', { class: 'tabpanel', role: 'tabpanel' }, body));
}

function emptyState() {
  return h(
    'div',
    { class: 'empty' },
    h('h2', {}, 'Įkelkite nuotrauką, kurią apdorojote Lightroom'),
    h('p', { class: 'muted' },
      'Programa perskaitys visą metadata (EXIF, XMP, IPTC, GPS, ICC) ir iš Lightroom ',
      'įrašytų apdorojimo nustatymų sukurs presetą, kurį galėsite atsisiųsti ir importuoti atgal į Lightroom.'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Nutempkite nuotraukas į kairėje esantį langelį (arba spustelėkite jį).'),
      h('li', {}, 'Skiltyje „Lightroom presetas“ pasirinkite, ką įtraukti, ir spauskite „Atsisiųsti .xmp“.'),
      h('li', {}, 'Lightroom: Develop → Presets → „+“ → Import Presets… ir pasirinkite failą.')),
    h('p', { class: 'muted small' }, 'Patarimas: geriausia įkelti JPEG, eksportuotą su „Metadata: All Metadata“, DNG failą arba RAW failo .xmp šalutinį failą.'),
  );
}

function renderHero(item) {
  const { meta } = item;
  const img = meta.imageUrl || meta.thumbnailUrl;
  const exposure = [
    pick(meta, 'FNumber') ? `f/${fmtNum(pick(meta, 'FNumber'), 1)}` : null,
    fmtExposure(pick(meta, 'ExposureTime')),
    pick(meta, 'ISO', 'ISOSpeedRatings', 'PhotographicSensitivity') ? `ISO ${fmtAny(pick(meta, 'ISO', 'ISOSpeedRatings', 'PhotographicSensitivity'))}` : null,
    pick(meta, 'FocalLength') ? `${fmtNum(pick(meta, 'FocalLength'), 1)} mm` : null,
  ].filter(Boolean);
  const date = pick(meta, 'DateTimeOriginal', 'CreateDate', 'DateTimeDigitized');
  return h(
    'div',
    { class: 'hero' },
    img ? h('img', { src: img, alt: item.file.name, class: 'hero-img' }) : h('div', { class: 'hero-img placeholder' }, 'Peržiūra negalima'),
    h(
      'div',
      { class: 'hero-info' },
      h('h2', { class: 'hero-title' }, item.file.name),
      h('p', { class: 'muted' }, [cameraName(meta), fmtAny(pick(meta, 'LensModel') || xmpValue(meta, 'aux:Lens'))].filter(Boolean).join(' · ') || 'Fotoaparatas nežinomas'),
      exposure.length ? h('p', { class: 'chips' }, exposure.map((e) => h('span', { class: 'chip' }, e))) : null,
      date ? h('p', { class: 'muted small' }, fmtDate(date), ' · ', fmtAgo(date)) : null,
      meta.histogram ? histogramSvg(meta.histogram) : null,
    ),
  );
}

function histogramSvg(hist) {
  const W = 256;
  const H = 80;
  const max = Math.max(1, ...[hist.r, hist.g, hist.b].flatMap((a) => Array.from(a).slice(2, 254)));
  const path = (arr) => {
    let d = `M0 ${H}`;
    for (let i = 0; i < 256; i++) d += ` L${i} ${H - Math.min(H, (arr[i] / max) * H)}`;
    return `${d} L255 ${H} Z`;
  };
  return h(
    'figure',
    { class: 'histogram' },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Histograma' },
      svg('path', { d: path(hist.r), class: 'h-r' }),
      svg('path', { d: path(hist.g), class: 'h-g' }),
      svg('path', { d: path(hist.b), class: 'h-b' })),
    h('figcaption', { class: 'muted small' },
      `Vid. šviesumas ${fmtNum((hist.mean / 255) * 100, 0)}% · pervertinta ${fmtNum(hist.clippedHi * 100, 2)}% · juoda ${fmtNum(hist.clippedLo * 100, 2)}%`),
  );
}

// --- Overview -----------------------------------------------------------------------

function card(title, rows, extra) {
  const filtered = rows.filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length));
  if (!filtered.length && !extra) return null;
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, title),
    filtered.length
      ? h('dl', { class: 'kv' }, filtered.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v instanceof Node ? v : fmtAny(v))]))
      : null,
    extra || null,
  );
}

function renderOverview(item) {
  const { meta } = item;
  const P = (...k) => pick(meta, ...k);
  const X = (...k) => xmpValue(meta, ...k);

  const focal = P('FocalLength');
  const focal35 = P('FocalLengthIn35mmFormat');
  const fnum = P('FNumber');
  const t = P('ExposureTime');
  const iso = P('ISO', 'ISOSpeedRatings', 'PhotographicSensitivity');
  const isoNum = Array.isArray(iso) ? iso[0] : iso;
  let ev;
  if (fnum && t && isoNum) ev = Math.log2((fnum * fnum) / t) - Math.log2(isoNum / 100);

  const width = P('ExifImageWidth', 'ImageWidth', 'PixelXDimension') || meta.image?.width;
  const height = P('ExifImageHeight', 'ImageHeight', 'PixelYDimension') || meta.image?.height;
  const mp = width && height ? (width * height) / 1e6 : null;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const ratio = width && height ? `${width / gcd(width, height)}:${height / gcd(width, height)} (${fmtNum(width / height, 3)})` : null;

  const gps = gpsCoordinates(meta);
  let gpsExtra = null;
  if (gps) {
    const q = `${gps.lat.toFixed(6)},${gps.lon.toFixed(6)}`;
    gpsExtra = h(
      'p',
      { class: 'links' },
      h('a', { href: `https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lon}#map=16/${gps.lat}/${gps.lon}`, target: '_blank', rel: 'noopener noreferrer' }, 'OpenStreetMap ↗'),
      h('a', { href: `https://www.google.com/maps?q=${q}`, target: '_blank', rel: 'noopener noreferrer' }, 'Google Maps ↗'),
    );
  }

  const date = P('DateTimeOriginal');
  const crsCount = meta.crs.filter((p) => !META_KEYS.has(p.name)).length;
  const look = crsProp(meta, 'Look');
  const lookName = look && typeof look !== 'string' ? look.fields?.find((f) => f.name === 'Name')?.value : undefined;

  const cards = [
    card('Lightroom / Camera Raw', [
      ['Apdorojimo nustatymai', crsCount ? `Rasta ${crsCount} nustatymų` : 'Nerasta'],
      ['Programa', X('xmp:CreatorTool') || P('Software')],
      ['Camera Raw versija', crsProp(meta, 'Version')],
      ['Apdorojimo versija', crsProp(meta, 'ProcessVersion')],
      ['Profilis', crsProp(meta, 'CameraProfile')],
      ['Kūrybinis profilis', typeof lookName === 'string' ? lookName : lookName?.items?.[0]?.value],
      ['Nespalvota', crsProp(meta, 'ConvertToGrayscale')],
      ['Originalus failas', crsProp(meta, 'RawFileName')],
      ['Įvertinimas', Number(X('xmp:Rating')) > 0 ? '★'.repeat(Math.min(5, Number(X('xmp:Rating')))) : X('xmp:Rating')],
      ['Spalvos žymė', X('xmp:Label')],
    ], crsCount ? h('button', { type: 'button', class: 'btn primary small', onclick: () => { state.tab = 'preset'; renderContent(); } }, 'Atidaryti presetą →') : null),
    card('Fotoaparatas', [
      ['Gamintojas', P('Make')],
      ['Modelis', P('Model')],
      ['Korpuso serijos nr.', P('BodySerialNumber', 'SerialNumber') || X('aux:SerialNumber', 'exifEX:BodySerialNumber')],
      ['Savininkas', P('CameraOwnerName', 'OwnerName') || X('aux:OwnerName')],
      ['Programinė įranga', P('Software')],
      ['Autorius', P('Artist')],
    ]),
    card('Objektyvas', [
      ['Objektyvas', P('LensModel') || X('aux:Lens', 'exifEX:LensModel')],
      ['Gamintojas', P('LensMake') || X('exifEX:LensMake')],
      ['Serijos nr.', P('LensSerialNumber') || X('aux:LensSerialNumber', 'exifEX:LensSerialNumber')],
      ['Specifikacija', P('LensSpecification', 'LensInfo') || X('aux:LensInfo')],
      ['Židinio nuotolis', focal ? `${fmtNum(focal, 1)} mm` : undefined],
      ['35 mm ekvivalentas', focal35 ? `${focal35} mm` : undefined],
      ['Jutiklio „crop“ faktorius', focal && focal35 ? `×${fmtNum(focal35 / focal, 2)}` : undefined],
      ['Atstumas iki objekto', P('SubjectDistance') ? `${fmtAny(P('SubjectDistance'))} m` : undefined],
    ]),
    card('Ekspozicija', [
      ['Išlaikymas', fmtExposure(t)],
      ['Diafragma', fnum ? `f/${fmtNum(fnum, 1)}` : undefined],
      ['ISO', iso],
      ['Ekspozicijos korekcija', P('ExposureCompensation', 'ExposureBiasValue') !== undefined ? `${fmtNum(P('ExposureCompensation', 'ExposureBiasValue'), 2)} EV` : undefined],
      ['Ekspozicijos vertė (EV100)', ev !== undefined && Number.isFinite(ev) ? fmtNum(ev, 2) : undefined],
      ['Programa', P('ExposureProgram')],
      ['Režimas', P('ExposureMode')],
      ['Matavimas', P('MeteringMode')],
      ['Blykstė', P('Flash')],
      ['Baltos balansas', P('WhiteBalance')],
      ['Šviesos šaltinis', P('LightSource')],
      ['Scenos tipas', P('SceneCaptureType')],
      ['Kontrastas / sodrumas / ryškumas', [P('Contrast'), P('Saturation'), P('Sharpness')].filter((v) => v !== undefined).join(' / ')],
      ['Skaitmeninis priartinimas', P('DigitalZoomRatio')],
    ]),
    card('Data ir laikas', [
      ['Nufotografuota', date ? fmtDate(date) : undefined],
      ['Prieš', date ? fmtAgo(date) : undefined],
      ['Laiko juosta', P('OffsetTimeOriginal', 'OffsetTime')],
      ['Sekundės dalys', P('SubSecTimeOriginal')],
      ['Suskaitmeninta', P('DateTimeDigitized', 'CreateDate') ? fmtDate(P('DateTimeDigitized', 'CreateDate')) : undefined],
      ['Pakeista', P('ModifyDate', 'DateTime') ? fmtDate(P('ModifyDate', 'DateTime')) : undefined],
      ['Metaduomenys atnaujinti', X('xmp:MetadataDate') ? fmtDate(X('xmp:MetadataDate')) : undefined],
      ['GPS laikas (UTC)', P('GPSDateStamp') ? `${P('GPSDateStamp')} ${fmtAny(P('GPSTimeStamp'))}` : undefined],
      ['Failas pakeistas', meta.file.lastModified ? fmtDate(meta.file.lastModified) : undefined],
    ]),
    card('Vieta', [
      ['Platuma', gps ? `${fmtDms(gps.lat, 'Š', 'P')} (${gps.lat.toFixed(6)})` : undefined],
      ['Ilguma', gps ? `${fmtDms(gps.lon, 'R', 'V')} (${gps.lon.toFixed(6)})` : undefined],
      ['Aukštis', gps && typeof gps.alt === 'number' ? `${fmtNum(gps.alt, 1)} m` : undefined],
      ['Kryptis', P('GPSImgDirection') !== undefined ? `${fmtNum(P('GPSImgDirection'), 1)}°` : undefined],
      ['Greitis', P('GPSSpeed')],
      ['Miestas', X('photoshop:City') || P('City')],
      ['Regionas', X('photoshop:State') || P('State')],
      ['Šalis', X('photoshop:Country') || P('Country')],
      ['Vietovė', X('Iptc4xmpCore:Location') || P('Sublocation')],
    ], gpsExtra),
    card('Vaizdas', [
      ['Matmenys', width && height ? `${width} × ${height} px` : undefined],
      ['Megapikseliai', mp ? `${fmtNum(mp, 1)} MP` : undefined],
      ['Kraštinių santykis', ratio],
      ['Orientacija', P('Orientation')],
      ['Spalvų erdvė', P('ColorSpace')],
      ['ICC profilis', P('ProfileDescription') || X('photoshop:ICCProfile')],
      ['Bitų gylis', P('BitsPerSample', 'BitDepth')],
      ['Raiška', P('XResolution') > 1 && P('ResolutionUnit') ? `${fmtAny(P('XResolution'))} × ${fmtAny(P('YResolution'))} ${P('ResolutionUnit') || ''}` : undefined],
      ['Glaudinimas', P('Compression')],
    ]),
    card('Aprašymas ir teisės', [
      ['Pavadinimas', X('dc:title') || P('ObjectName')],
      ['Aprašymas', X('dc:description') || P('ImageDescription', 'Caption')],
      ['Raktažodžiai', X('dc:subject') || P('Keywords')],
      ['Hierarchiniai raktažodžiai', X('lr:hierarchicalSubject')],
      ['Autorius', X('dc:creator') || P('Artist', 'Byline')],
      ['Autorių teisės', X('dc:rights') || P('Copyright', 'CopyrightNotice')],
      ['Naudojimo sąlygos', X('xmpRights:UsageTerms')],
      ['Komentaras', P('UserComment')],
    ]),
    card('Failas', [
      ['Pavadinimas', meta.file.name],
      ['Dydis', fmtBytes(meta.file.size)],
      ['MIME tipas', meta.file.type],
      ['Pirmieji baitai', meta.file.magic],
      ['SHA-256', meta.sha256 ? h('code', { class: 'break' }, meta.sha256) : undefined],
      ['Dokumento ID', X('xmpMM:DocumentID')],
      ['Originalo ID', X('xmpMM:OriginalDocumentID')],
      ['XMP paketai', meta.xmpPackets.length ? `${meta.xmpPackets.length} (${fmtBytes(meta.xmpPackets.reduce((s, p) => s + p.length, 0))})` : 'Nėra'],
    ]),
  ].filter(Boolean);
  return h('div', { class: 'cards' }, cards);
}

// --- Preset tab -----------------------------------------------------------------------

function noSettingsNotice(meta) {
  return h(
    'div',
    { class: 'notice warn' },
    h('h3', {}, 'Šioje nuotraukoje Lightroom apdorojimo nustatymų nerasta'),
    h('p', {}, meta.xmpPackets.length
      ? 'Nuotraukoje yra XMP metaduomenų, bet juose nėra Camera Raw (crs:) nustatymų.'
      : 'Nuotraukoje nėra XMP metaduomenų.'),
    h('p', {}, 'Dažniausios priežastys:'),
    h('ul', {},
      h('li', {}, 'Eksportuojant pasirinkta „Metadata: Copyright Only“ arba „Copyright & Contact Info Only“ – reikia „All Metadata“.'),
      h('li', {}, 'Nuotrauka atsisiųsta iš Instagram, Facebook, Messenger ar kitos platformos – jos ištrina metaduomenis.'),
      h('li', {}, 'Failas apdorotas kita programa, kuri neišsaugo XMP.')),
    h('p', {}, 'Ką daryti: įkelkite originalų RAW failo .xmp šalutinį failą, DNG failą arba iš Lightroom eksportuokite JPEG su „All Metadata“.'),
  );
}

function renderPreset(item) {
  const { meta, preset } = item;
  if (!meta.crs.length) return noSettingsNotice(meta);

  const groups = groupSettings(meta.crs);
  const present = GROUPS.filter((g) => groups.get(g.id).length);

  const nameInput = h('input', { type: 'text', value: preset.name, maxlength: '200' });
  nameInput.addEventListener('input', () => {
    preset.name = nameInput.value;
  });
  const groupInput = h('input', { type: 'text', value: preset.group, maxlength: '200' });
  groupInput.addEventListener('input', () => {
    preset.group = groupInput.value;
  });

  const countEl = h('span', { class: 'muted small' });
  const updateCount = () => {
    const n = selectSettings(meta.crs, [...preset.enabled]).length;
    countEl.textContent = `Į presetą bus įtraukta ${n} nustatymų.`;
  };
  updateCount();

  const toggles = h(
    'div',
    { class: 'group-toggles' },
    present.map((g) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = preset.enabled.has(g.id);
      cb.addEventListener('change', () => {
        if (cb.checked) preset.enabled.add(g.id);
        else preset.enabled.delete(g.id);
        updateCount();
        const sec = document.querySelector(`[data-group-section="${g.id}"]`);
        if (sec) sec.classList.toggle('excluded', !cb.checked);
      });
      return h('label', { class: `toggle${g.defaultOn ? '' : ' specific'}` }, cb, h('span', {}, g.label), h('span', { class: 'count' }, String(groups.get(g.id).length)));
    }),
  );

  const actions = h(
    'div',
    { class: 'preset-actions' },
    h('button', { type: 'button', class: 'btn primary', onclick: () => {
      const f = presetFiles(item);
      download(`${safeFileName(f.name)}.xmp`, f.xmp, 'application/rdf+xml');
      toast('Presetas (.xmp) atsisiųstas.');
    } }, '⬇ Atsisiųsti .xmp presetą'),
    h('button', { type: 'button', class: 'btn', onclick: () => {
      const f = presetFiles(item);
      download(`${safeFileName(f.name)}.lrtemplate`, f.lrtemplate, 'text/plain');
    } }, '⬇ .lrtemplate (senas Lightroom)'),
    h('button', { type: 'button', class: 'btn', onclick: (e) => saveToLibrary(item, e.currentTarget) }, '☁ Išsaugoti „Mano presetuose“'),
    h('button', { type: 'button', class: 'btn ghost', onclick: async () => {
      const ok = await copyText(presetFiles(item).xmp);
      toast(ok ? 'XMP nukopijuotas.' : 'Nepavyko nukopijuoti.', ok ? 'info' : 'error');
    } }, 'Kopijuoti XMP'),
  );

  const builder = h(
    'section',
    { class: 'card builder' },
    h('h3', {}, 'Sukurti presetą'),
    h('div', { class: 'form-row' },
      h('label', { class: 'field' }, h('span', {}, 'Preseto pavadinimas'), nameInput),
      h('label', { class: 'field' }, h('span', {}, 'Grupė (aplankas Lightroom)'), groupInput)),
    h('p', { class: 'muted small' }, 'Pažymėkite, ką įtraukti. Pilkai pažymėtos grupės priklauso nuo konkrečios nuotraukos (apkarpymas, maskės, dėmės), todėl pagal nutylėjimą neįtraukiamos.'),
    toggles,
    countEl,
    actions,
    h('details', { class: 'howto' },
      h('summary', {}, 'Kaip importuoti į Lightroom?'),
      h('ul', {},
        h('li', {}, h('strong', {}, 'Lightroom Classic (7.3+): '), 'Develop modulis → kairėje „Presets“ skydelis → „+“ → „Import Presets…“ → pasirinkite .xmp failą.'),
        h('li', {}, h('strong', {}, 'Lightroom (CC, kompiuteriui): '), 'Edit → „Presets“ → „…“ meniu → „Import Presets…“.'),
        h('li', {}, h('strong', {}, 'Lightroom Mobile: '), 'importuokite presetą kompiuteryje – jis susisinchronizuos per Adobe debesį.'),
        h('li', {}, h('strong', {}, 'Lightroom 4–7.2: '), 'naudokite .lrtemplate failą: Develop → Presets → dešiniu pelės mygtuku → „Import…“.'),
        h('li', {}, h('strong', {}, 'Photoshop / Camera Raw: '), '.xmp failą nukopijuokite į „Settings“ aplanką (Adobe/CameraRaw/Settings).'))),
  );

  const sections = present.map((g) => renderGroupSection(g, groups.get(g.id), preset.enabled.has(g.id)));
  const metaRows = meta.crs.filter((p) => META_KEYS.has(p.name));

  return h(
    'div',
    { class: 'preset-view' },
    builder,
    h('div', { class: 'settings-grid' }, sections),
    metaRows.length
      ? h('section', { class: 'card' }, h('h3', {}, 'Techninė informacija (į presetą neįtraukiama)'),
          h('dl', { class: 'kv' }, metaRows.flatMap((p) => [h('dt', {}, `${crsLabel(p.name)}`), h('dd', {}, typeof p.value === 'string' ? p.value : flatten(p.value).map(([, v]) => v).join(', '))])))
      : null,
  );
}

const COLOR_SWATCH = {
  Red: 0, Orange: 30, Yellow: 55, Green: 120, Aqua: 180, Blue: 220, Purple: 275, Magenta: 310,
};

function swatchFor(key, settingsByName) {
  const color = key.match(/(Red|Orange|Yellow|Green|Aqua|Blue|Purple|Magenta)$/)?.[1]
    || key.match(/^(Red|Green|Blue)(Hue|Saturation)$/)?.[1];
  if (color) {
    const el = h('span', { class: 'swatch' });
    el.style.background = `hsl(${COLOR_SWATCH[color]}, 75%, 50%)`;
    return el;
  }
  const m = key.match(/^(SplitToning(Shadow|Highlight)|ColorGrade(Shadow|Highlight|Midtone|Global))Hue$/);
  if (m) {
    const satKey = key.replace(/Hue$/, key.startsWith('Split') ? 'Saturation' : 'Sat');
    const sat = Number(settingsByName.get(satKey) ?? 50);
    const el = h('span', { class: 'swatch' });
    el.style.background = `hsl(${Number(settingsByName.get(key))}, ${Math.max(15, sat)}%, 50%)`;
    return el;
  }
  return null;
}

function valueBar(key, text) {
  const range = sliderRange(key);
  const v = toScalar(text);
  if (!range || typeof v !== 'number') return null;
  const [min, max] = range;
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const bar = h('span', { class: 'bar' });
  const fill = h('span', { class: 'bar-fill' });
  if (min < 0) {
    const zero = clamp((0 - min) / (max - min));
    const pos = clamp((v - min) / (max - min));
    fill.style.left = `${Math.min(zero, pos) * 100}%`;
    fill.style.width = `${Math.abs(pos - zero) * 100}%`;
    bar.append(h('span', { class: 'bar-zero' }));
    bar.lastChild.style.left = `${zero * 100}%`;
  } else {
    fill.style.left = '0';
    fill.style.width = `${clamp((v - min) / (max - min)) * 100}%`;
  }
  bar.prepend(fill);
  return bar;
}

function renderGroupSection(group, settings, enabled) {
  const simple = settings.filter((s) => typeof s.value === 'string');
  const complex = settings.filter((s) => typeof s.value !== 'string');
  const byName = new Map(simple.map((s) => [s.name, s.value]));
  const curves = complex.filter((s) => /^ToneCurve/.test(s.name) && s.value.type === 'seq');
  const others = complex.filter((s) => !curves.includes(s));

  return h(
    'section',
    { class: `card group-section${enabled ? '' : ' excluded'}`, dataset: { groupSection: group.id } },
    h('h3', {}, group.label),
    curves.length ? toneCurveSvg(curves) : null,
    simple.length
      ? h('div', { class: 'settings' }, simple.map((s) => h(
          'div',
          { class: 'setting', title: s.name },
          h('span', { class: 'setting-label' }, swatchFor(s.name, byName), crsLabel(s.name)),
          h('span', { class: 'setting-value' }, s.value),
          valueBar(s.name, s.value),
        )))
      : null,
    others.map((s) => complexSetting(s)),
  );
}

function complexSetting(s) {
  const rows = flatten(s.value);
  let summary = crsLabel(s.name);
  if (s.value.type === 'seq' || s.value.type === 'bag') summary += ` (${s.value.items.length})`;
  const table = h('table', { class: 'meta-table compact' },
    h('tbody', {}, rows.slice(0, 2000).map(([k, v]) => h('tr', {}, h('th', {}, k || s.name), h('td', {}, v)))));
  return h('details', { class: 'complex' }, h('summary', {}, summary, h('span', { class: 'muted small' }, ` · ${rows.length} reikšmių`)), table);
}

function toneCurveSvg(curves) {
  const size = 200;
  const classFor = (name) => (/Red$/.test(name) ? 'c-r' : /Green$/.test(name) ? 'c-g' : /Blue$/.test(name) ? 'c-b' : 'c-l');
  const grid = [];
  for (let i = 1; i < 4; i++) {
    const p = (size / 4) * i;
    grid.push(svg('line', { x1: p, y1: 0, x2: p, y2: size, class: 'grid' }), svg('line', { x1: 0, y1: p, x2: size, y2: p, class: 'grid' }));
  }
  const lines = curves.map((c) => {
    const pts = c.value.items
      .map((it) => String(it).split(',').map((n) => Number(n.trim())))
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    const coords = pts.map(([x, y]) => [(x / 255) * size, size - (y / 255) * size]);
    return svg('g', { class: classFor(c.name) },
      svg('polyline', { points: coords.map((p) => p.join(',')).join(' '), fill: 'none' }),
      ...coords.map(([x, y]) => svg('circle', { cx: x, cy: y, r: 2.5 })));
  });
  return h(
    'figure',
    { class: 'curve' },
    svg('svg', { viewBox: `-4 -4 ${size + 8} ${size + 8}`, role: 'img', 'aria-label': 'Tonų kreivė' },
      svg('rect', { x: 0, y: 0, width: size, height: size, class: 'frame' }),
      ...grid,
      svg('line', { x1: 0, y1: size, x2: size, y2: 0, class: 'diag' }),
      ...lines),
    h('figcaption', { class: 'muted small' }, curves.map((c) => `${crsLabel(c.name)}: ${c.value.items.length} taškai`).join(' · ')),
  );
}

async function saveToLibrary(item, button) {
  const f = presetFiles(item);
  button.disabled = true;
  try {
    await api('/api/presets', {
      method: 'POST',
      body: {
        name: f.name,
        group: item.preset.group,
        sourceFile: item.file.name,
        camera: cameraName(item.meta),
        settingsCount: f.settings.length,
        xmp: f.xmp,
        lrtemplate: f.lrtemplate,
      },
    });
    toast('Presetas išsaugotas jūsų paskyroje.');
  } catch (err) {
    handleApiError(err);
  } finally {
    button.disabled = false;
  }
}

// --- All metadata --------------------------------------------------------------------

function metadataTables(item) {
  const { meta } = item;
  const tables = [];
  tables.push({
    title: 'Failas',
    rows: [
      ['Pavadinimas', meta.file.name],
      ['Dydis', fmtBytes(meta.file.size)],
      ['MIME tipas', meta.file.type || '—'],
      ['Paskutinis pakeitimas', meta.file.lastModified ? fmtDate(meta.file.lastModified) : '—'],
      ['Pirmieji baitai', meta.file.magic],
      ['SHA-256', meta.sha256 || '— (reikia HTTPS)'],
      ['Vaizdo matmenys (dekoduota)', meta.image ? `${meta.image.width} × ${meta.image.height}` : '—'],
    ],
  });
  for (const [block, values] of Object.entries(meta.exif || {})) {
    if (!values || typeof values !== 'object') continue;
    const rows = Object.entries(values).map(([k, v]) => [k, fmtAny(v)]);
    if (rows.length) tables.push({ title: EXIF_BLOCK_LABELS[block] || block, rows });
  }
  const prefixByNs = new Map();
  for (const [prefix, uri] of meta.xmp.namespaces) if (!prefixByNs.has(uri)) prefixByNs.set(uri, prefix);
  const byNs = new Map();
  for (const p of meta.xmp.properties) {
    if (!byNs.has(p.ns)) byNs.set(p.ns, []);
    byNs.get(p.ns).push(...flatten(p.value, p.name));
  }
  for (const [ns, rows] of byNs) {
    const prefix = prefixByNs.get(ns) || ns;
    tables.push({ title: `XMP · ${prefix}`, subtitle: ns, rows });
  }
  return tables;
}

function renderAllMetadata(item) {
  const tables = metadataTables(item);
  const total = tables.reduce((s, t) => s + t.rows.length, 0);
  const search = h('input', { type: 'search', placeholder: 'Ieškoti žymos arba reikšmės…', value: state.filter, 'aria-label': 'Paieška' });
  const container = h('div', { class: 'meta-tables' });
  const draw = () => {
    const q = state.filter.trim().toLowerCase();
    container.replaceChildren(
      ...tables
        .map((t) => {
          const rows = q ? t.rows.filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(q)) : t.rows;
          if (!rows.length) return null;
          return h('section', { class: 'card' },
            h('h3', {}, t.title, h('span', { class: 'muted small' }, ` · ${rows.length}`)),
            t.subtitle ? h('p', { class: 'muted small break' }, t.subtitle) : null,
            h('table', { class: 'meta-table' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))))));
        })
        .filter(Boolean),
    );
    if (!container.children.length) container.append(h('p', { class: 'muted' }, 'Nieko nerasta.'));
  };
  search.addEventListener('input', () => {
    state.filter = search.value;
    draw();
  });
  draw();
  if (item.meta.exifError) container.prepend(h('p', { class: 'notice warn' }, `EXIF nuskaitymo klaida: ${item.meta.exifError}`));
  return h(
    'div',
    {},
    h('div', { class: 'toolbar' },
      search,
      h('span', { class: 'muted small' }, `Iš viso ${total} žymų`),
      h('button', { type: 'button', class: 'btn small', onclick: () => exportJson(item, tables) }, '⬇ JSON'),
      h('button', { type: 'button', class: 'btn small', onclick: () => exportCsv(item, tables) }, '⬇ CSV')),
    container,
  );
}

function exportJson(item, tables) {
  const out = {};
  for (const t of tables) out[t.title] = Object.fromEntries(t.rows);
  download(`${safeFileName(baseName(item.file.name))}-metadata.json`, JSON.stringify(out, jsonReplacer, 2), 'application/json');
}

function exportCsv(item, tables) {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ['Grupė,Žyma,Reikšmė'];
  for (const t of tables) for (const [k, v] of t.rows) lines.push([t.title, k, v].map(esc).join(','));
  download(`${safeFileName(baseName(item.file.name))}-metadata.csv`, `﻿${lines.join('\r\n')}`, 'text/csv');
}

// --- Raw XMP ---------------------------------------------------------------------------

function renderRawXmp(item) {
  const { meta } = item;
  if (!meta.xmpPackets.length) return h('p', { class: 'muted' }, 'Šiame faile XMP paketų nėra.');
  return h(
    'div',
    {},
    meta.xmp.errors.map((e) => h('p', { class: 'notice warn' }, e)),
    meta.xmpPackets.map((p, i) => h(
      'section',
      { class: 'card' },
      h('div', { class: 'toolbar' },
        h('h3', {}, `XMP paketas ${i + 1}${i > 0 ? ' (Extended XMP)' : ''}`),
        h('span', { class: 'muted small' }, fmtBytes(p.length)),
        h('button', { type: 'button', class: 'btn small', onclick: async () => toast((await copyText(p)) ? 'Nukopijuota.' : 'Nepavyko nukopijuoti.') }, 'Kopijuoti'),
        h('button', { type: 'button', class: 'btn small', onclick: () => download(`${safeFileName(baseName(item.file.name))}${i ? `-${i + 1}` : ''}.xmp`, p, 'application/rdf+xml') }, '⬇ .xmp')),
      h('pre', { class: 'code' }, p),
    )),
  );
}

// --- Library view -----------------------------------------------------------------------

async function renderLibrary() {
  const root = $('view-library');
  root.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner' })));
  let presets;
  try {
    ({ presets } = await api('/api/presets'));
  } catch (err) {
    handleApiError(err);
    root.replaceChildren(h('p', { class: 'notice warn' }, err.message));
    return;
  }
  const header = h('div', { class: 'library-header' },
    h('h2', {}, 'Mano presetai'),
    h('p', { class: 'muted' }, 'Presetai, kuriuos išsaugojote iš savo nuotraukų. Juos galite atsisiųsti bet kada ir bet kuriame įrenginyje.'));
  if (!presets.length) {
    root.replaceChildren(header, h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Kol kas neišsaugojote nė vieno preseto.')));
    return;
  }
  const rows = presets.map((p) => h(
    'tr',
    {},
    h('td', {}, h('strong', {}, p.name), p.group ? h('div', { class: 'muted small' }, p.group) : null),
    h('td', {}, p.sourceFile || '—', p.camera ? h('div', { class: 'muted small' }, p.camera) : null),
    h('td', {}, p.settingsCount ?? '—'),
    h('td', {}, fmtDate(p.createdAt)),
    h('td', { class: 'row-actions' },
      h('a', { class: 'btn small', href: `/api/presets/${p.id}.xmp`, download: `${safeFileName(p.name)}.xmp` }, '.xmp'),
      h('a', { class: 'btn small', href: `/api/presets/${p.id}.lrtemplate`, download: `${safeFileName(p.name)}.lrtemplate` }, '.lrtemplate'),
      h('button', { type: 'button', class: 'btn ghost small danger', onclick: async () => {
        if (!confirm(`Ištrinti presetą „${p.name}“?`)) return;
        try {
          await api(`/api/presets/${p.id}`, { method: 'DELETE' });
          toast('Presetas ištrintas.');
          renderLibrary();
        } catch (err) {
          handleApiError(err);
        }
      } }, 'Ištrinti')),
  ));
  root.replaceChildren(
    header,
    h('div', { class: 'card table-wrap' },
      h('table', { class: 'library-table' },
        h('thead', {}, h('tr', {}, ['Pavadinimas', 'Šaltinis', 'Nustatymų', 'Išsaugota', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows))),
  );
}

// --- Zip of all presets ----------------------------------------------------------------------

function downloadAllZip() {
  const files = [];
  const used = new Set();
  for (const item of state.items) {
    if (item.status !== 'ready' || !item.meta.crs.length) continue;
    const f = presetFiles(item);
    let base = safeFileName(f.name);
    for (let i = 2; used.has(base.toLowerCase()); i++) base = `${safeFileName(f.name)} (${i})`;
    used.add(base.toLowerCase());
    files.push({ name: `xmp/${base}.xmp`, data: f.xmp }, { name: `lrtemplate/${base}.lrtemplate`, data: f.lrtemplate });
  }
  if (!files.length) return;
  download('lightroom-presetai.zip', new Blob([createZip(files)], { type: 'application/zip' }));
  toast(`Atsisiųsta ${files.length / 2} presetų.`);
}

// --- App shell ---------------------------------------------------------------------------------

function renderAll() {
  renderSidebar();
  renderContent();
}

function handleApiError(err) {
  if (err.status === 401) {
    window.location.href = '/login';
    return;
  }
  toast(err.message, 'error');
}

function setView(view) {
  for (const btn of document.querySelectorAll('.navbtn')) {
    btn.setAttribute('aria-current', btn.dataset.view === view ? 'page' : 'false');
  }
  $('view-decoder').hidden = view !== 'decoder';
  $('view-library').hidden = view !== 'library';
  if (view === 'library') renderLibrary();
}

function setupDropzone() {
  const dz = $('dropzone');
  const input = $('file-input');
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth++;
    dz.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dz.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    dz.classList.remove('dragging');
    if (e.dataTransfer?.files?.length) {
      setView('decoder');
      addFiles(e.dataTransfer.files);
    }
  });
}

function setupAccount() {
  $('btn-logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } finally {
      window.location.href = '/login';
    }
  });
  const dialog = $('password-dialog');
  const form = $('password-form');
  const errorEl = $('password-error');
  $('btn-password').addEventListener('click', () => {
    form.reset();
    errorEl.textContent = '';
    dialog.showModal();
  });
  $('password-cancel').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: form.currentPassword.value, newPassword: form.newPassword.value },
      });
      dialog.close();
      toast('Slaptažodis pakeistas.');
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

async function init() {
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
    $('user-email').textContent = user.email;
  } catch {
    window.location.href = '/login';
    return;
  }
  for (const btn of document.querySelectorAll('.navbtn')) btn.addEventListener('click', () => setView(btn.dataset.view));
  $('btn-zip').addEventListener('click', downloadAllZip);
  $('btn-clear').addEventListener('click', clearFiles);
  setupDropzone();
  setupAccount();
  renderAll();
}

init();

// Exposed for debugging in the console.
window.presetDecoder = { state, groupOf };

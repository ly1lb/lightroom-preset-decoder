// Pure preset builder (no DOM): turns Camera Raw / Lightroom develop settings
// (crs:* properties) into a Lightroom preset, either as a modern .xmp preset
// (Lightroom Classic 7.3+, Lightroom CC, ACR) or a legacy .lrtemplate.
//
// Value model shared with xmp.js:
//   string
//   { type: 'seq' | 'bag', items: Value[] }
//   { type: 'alt', items: [{ lang, value }] }
//   { type: 'struct', fields: [{ ns, prefix, name, value }] }

export const NS = {
  x: 'adobe:ns:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  xml: 'http://www.w3.org/XML/1998/namespace',
  crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
  crlcp: 'http://ns.adobe.com/camera-raw-embedded-lens-profile/1.0/',
  stDim: 'http://ns.adobe.com/xap/1.0/sType/Dimensions#',
  stEvt: 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#',
  stRef: 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#',
};

// Keys describing the document or preset itself rather than a develop setting.
export const META_KEYS = new Set([
  'Version', 'CompatibleVersion', 'ProcessVersion', 'RawFileName', 'AlreadyApplied', 'HasSettings',
  'Converter', 'PresetType', 'Cluster', 'UUID', 'SupportsAmount', 'SupportsAmount2', 'SupportsColor',
  'SupportsMonochrome', 'SupportsHighDynamicRange', 'SupportsNormalDynamicRange',
  'SupportsSceneReferred', 'SupportsOutputReferred', 'CameraModelRestriction', 'Copyright',
  'ContactInfo', 'Name', 'ShortName', 'SortName', 'Group', 'Description', 'JPEGHandling',
]);

const exact = (...names) => (key) => names.includes(key);
const re = (...patterns) => (key) => patterns.some((p) => p.test(key));

// Mirrors the check-boxes of Lightroom's "Create Preset" dialog. Order matters:
// the first group whose matcher accepts a key wins.
export const GROUPS = [
  {
    id: 'wb', label: 'Baltos spalvos balansas', defaultOn: true,
    match: exact('WhiteBalance', 'Temperature', 'Tint', 'IncrementalTemperature', 'IncrementalTint'),
  },
  {
    id: 'profile', label: 'Profilis ir apdorojimas (spalvota / nespalvota)', defaultOn: true,
    match: re(/^CameraProfile/, /^Look$/, /^LookName$/, /^ConvertToGrayscale$/, /^Treatment$/),
  },
  {
    id: 'basic', label: 'Pagrindinis tonas (ekspozicija, kontrastas…)', defaultOn: true,
    match: re(
      /^(Exposure|Contrast|Highlights|Shadows|Whites|Blacks)2012$/,
      /^(Exposure|Brightness|Contrast|Shadows|FillLight|HighlightRecovery)$/,
      /^Auto(Exposure|Brightness|Contrast|Shadows|Tone)$/,
      /^HDR/, /^SDR/,
    ),
  },
  {
    id: 'presence', label: 'Buvimas (tekstūra, aiškumas, rūkas, sodrumas)', defaultOn: true,
    match: exact('Texture', 'Clarity2012', 'Clarity', 'Dehaze', 'Vibrance', 'Saturation'),
  },
  {
    id: 'curve', label: 'Tonų kreivė', defaultOn: true,
    match: re(/^ToneCurve/, /^Parametric/, /^CurveRefineSaturation$/),
  },
  {
    id: 'hsl', label: 'HSL / spalvų maišyklė', defaultOn: true,
    match: re(/^(Hue|Saturation|Luminance)Adjustment/, /^PointColors$/, /^ColorVariance/),
  },
  { id: 'bw', label: 'Nespalvota maišyklė', defaultOn: true, match: re(/^GrayMixer/) },
  { id: 'grading', label: 'Spalvų gradacija (split toning)', defaultOn: true, match: re(/^SplitToning/, /^ColorGrade/) },
  {
    id: 'detail', label: 'Detalumas (aštrinimas, triukšmo mažinimas)', defaultOn: true,
    match: re(/^Sharpen/, /^Sharpness$/, /NoiseReduction/, /^LuminanceSmoothing$/, /^ColorNoise/),
  },
  {
    id: 'lensProfile', label: 'Konkretaus objektyvo profilis', defaultOn: false,
    match: re(/^LensProfile(Name|Filename|Digest|DistortionScale|ChromaticAberrationScale|VignettingScale|IsEmbedded)$/),
  },
  {
    id: 'lens', label: 'Objektyvo korekcijos', defaultOn: true,
    match: re(/^LensProfile/, /^LensManual/, /^AutoLateralCA$/, /^Defringe/, /^Vignette(Amount|Midpoint)$/, /^ChromaticAberration[RB]$/),
  },
  { id: 'transform', label: 'Transformacija (perspektyva, Upright)', defaultOn: false, match: re(/^Perspective/, /^Upright/) },
  {
    id: 'effects', label: 'Efektai (vinjetė po apkarpymo, grūdėtumas)', defaultOn: true,
    match: re(/^PostCropVignette/, /^Grain/, /^OverrideLookVignette$/),
  },
  { id: 'calibration', label: 'Kalibracija', defaultOn: true, match: re(/^ShadowTint$/, /^(Red|Green|Blue)(Hue|Saturation)$/) },
  {
    id: 'masks', label: 'Maskės ir vietiniai koregavimai', defaultOn: false,
    match: re(/^MaskGroupBasedCorrections$/, /^(Gradient|CircularGradient|Paint)BasedCorrections$/),
  },
  { id: 'retouch', label: 'Dėmių šalinimas, raudonos akys', defaultOn: false, match: re(/^Retouch/, /^RedEye/) },
  { id: 'crop', label: 'Apkarpymas ir pasukimas', defaultOn: false, match: re(/^Crop/, /^HasCrop$/) },
  { id: 'enhance', label: 'Patobulinimai (Denoise, Super Resolution)', defaultOn: false, match: re(/^Enhance/) },
  { id: 'lensBlur', label: 'Objektyvo suliejimas (Lens Blur)', defaultOn: false, match: re(/^LensBlur/) },
  { id: 'other', label: 'Kiti nustatymai', defaultOn: true, match: () => true },
];

export function groupOf(key) {
  return GROUPS.find((g) => g.match(key)).id;
}

// Splits crs settings into preset groups (meta keys are dropped).
export function groupSettings(settings) {
  const byGroup = new Map(GROUPS.map((g) => [g.id, []]));
  for (const s of settings) {
    if (META_KEYS.has(s.name)) continue;
    byGroup.get(groupOf(s.name)).push(s);
  }
  return byGroup;
}

export function selectSettings(settings, enabledGroups) {
  const enabled = new Set(enabledGroups);
  return settings.filter((s) => !META_KEYS.has(s.name) && enabled.has(groupOf(s.name)));
}

export function newUuid() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#xD;')
    .replace(/\n/g, '&#xA;')
    .replace(/\t/g, '&#x9;');
}

// --- XMP serialization -----------------------------------------------------

class NamespaceRegistry {
  constructor() {
    this.byUri = new Map([[NS.crs, 'crs']]);
  }

  prefixFor(ns, suggested) {
    if (!ns || ns === NS.crs) return 'crs';
    if (this.byUri.has(ns)) return this.byUri.get(ns);
    const known = Object.entries(NS).find(([, uri]) => uri === ns)?.[0];
    let prefix = known || suggested || 'ns';
    const taken = new Set(this.byUri.values());
    for (let i = 1; taken.has(prefix); i++) prefix = `${known || suggested || 'ns'}${i}`;
    this.byUri.set(ns, prefix);
    return prefix;
  }

  declarations(indent) {
    return [...this.byUri].map(([uri, prefix]) => `${indent}xmlns:${prefix}="${escapeXml(uri)}"`);
  }
}

const isSimple = (v) => typeof v === 'string';

function serializeStruct(fields, registry, pad) {
  const attrs = [];
  const children = [];
  for (const f of fields) {
    const qname = `${registry.prefixFor(f.ns, f.prefix)}:${f.name}`;
    if (isSimple(f.value)) attrs.push(`${pad} ${qname}="${escapeXml(f.value)}"`);
    else children.push(serializeProperty(qname, f.value, registry, `${pad} `));
  }
  const open = attrs.length ? `${pad}<rdf:Description\n${attrs.join('\n')}` : `${pad}<rdf:Description`;
  if (!children.length) return `${open}/>`;
  return `${open}>\n${children.join('\n')}\n${pad}</rdf:Description>`;
}

function serializeContainer(value, registry, pad) {
  if (value.type === 'alt') {
    const items = value.items.map(
      (it) => `${pad} <rdf:li xml:lang="${escapeXml(it.lang || 'x-default')}">${escapeXml(it.value)}</rdf:li>`,
    );
    return `${pad}<rdf:Alt>\n${items.join('\n')}\n${pad}</rdf:Alt>`;
  }
  if (value.type === 'seq' || value.type === 'bag') {
    const tag = value.type === 'seq' ? 'rdf:Seq' : 'rdf:Bag';
    if (!value.items.length) return `${pad}<${tag}/>`;
    const items = value.items.map((it) => {
      if (isSimple(it)) return `${pad} <rdf:li>${escapeXml(it)}</rdf:li>`;
      return `${pad} <rdf:li>\n${serializeValue(it, registry, `${pad}  `)}\n${pad} </rdf:li>`;
    });
    return `${pad}<${tag}>\n${items.join('\n')}\n${pad}</${tag}>`;
  }
  throw new Error(`Unknown container type: ${value.type}`);
}

function serializeValue(value, registry, pad) {
  if (value.type === 'struct') return serializeStruct(value.fields, registry, pad);
  return serializeContainer(value, registry, pad);
}

function serializeProperty(qname, value, registry, pad) {
  if (isSimple(value)) return `${pad}<${qname}>${escapeXml(value)}</${qname}>`;
  return `${pad}<${qname}>\n${serializeValue(value, registry, `${pad} `)}\n${pad}</${qname}>`;
}

const alt = (text) => ({ type: 'alt', items: [{ lang: 'x-default', value: text }] });

export function buildPresetXmp({
  name,
  group = '',
  description = '',
  settings,
  processVersion,
  version = '15.0',
  uuid = newUuid(),
  monochrome = false,
}) {
  const registry = new NamespaceRegistry();
  const pad = '   ';
  const header = [
    ['PresetType', 'Normal'],
    ['Cluster', ''],
    ['UUID', uuid],
    ['SupportsAmount', 'False'],
    ['SupportsColor', monochrome ? 'False' : 'True'],
    ['SupportsMonochrome', 'True'],
    ['SupportsHighDynamicRange', 'True'],
    ['SupportsNormalDynamicRange', 'True'],
    ['SupportsSceneReferred', 'True'],
    ['SupportsOutputReferred', 'True'],
    ['CameraModelRestriction', ''],
    ['Copyright', ''],
    ['ContactInfo', ''],
    ['Version', version || '15.0'],
  ];
  if (processVersion) header.push(['ProcessVersion', processVersion]);

  const attrs = header.map(([k, v]) => `${pad}crs:${k}="${escapeXml(v)}"`);
  const children = [
    serializeProperty('crs:Name', alt(name), registry, `${pad}`),
    serializeProperty('crs:ShortName', alt(''), registry, pad),
    serializeProperty('crs:SortName', alt(''), registry, pad),
    serializeProperty('crs:Group', alt(group), registry, pad),
    serializeProperty('crs:Description', alt(description), registry, pad),
  ];
  for (const s of settings) {
    const qname = `${registry.prefixFor(s.ns, s.prefix)}:${s.name}`;
    if (isSimple(s.value)) attrs.push(`${pad}${qname}="${escapeXml(s.value)}"`);
    else children.push(serializeProperty(qname, s.value, registry, pad));
  }
  attrs.push(`${pad}crs:HasSettings="True"`);

  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00        ">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    ...registry.declarations(pad),
    `${attrs.join('\n')}>`,
    ...children,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '',
  ].join('\n');
}

// --- Legacy .lrtemplate (Lua) ----------------------------------------------

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function toScalar(text) {
  const t = String(text).trim();
  if (NUMBER_RE.test(t)) return Number(t);
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  return String(text);
}

// Converts the XMP value model to plain JS values suitable for Lua output.
export function toPlain(key, value) {
  if (typeof value === 'string') return toScalar(value);
  if (value.type === 'alt') {
    const item = value.items.find((i) => i.lang === 'x-default') || value.items[0];
    return item ? item.value : '';
  }
  if (value.type === 'seq' || value.type === 'bag') {
    // Tone curves are stored as "x, y" strings in XMP but as a flat number list in Lua.
    if (/^ToneCurve/.test(key) && !/Name/.test(key)) {
      return value.items.flatMap((it) => String(it).split(',').map((n) => Number(n.trim())));
    }
    return value.items.map((it) => toPlain('', it));
  }
  if (value.type === 'struct') {
    const out = {};
    for (const f of value.fields) out[f.name] = toPlain(f.name, f.value);
    return out;
  }
  return null;
}

function luaString(s) {
  return `"${String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')}"`;
}

const luaKey = (k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `[${luaString(k)}]`);

function luaNumber(n) {
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

function luaValue(v, indent) {
  if (typeof v === 'number') return luaNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return luaString(v);
  if (v === null || v === undefined) return 'nil';
  const inner = `${indent}\t`;
  if (Array.isArray(v)) {
    if (!v.length) return '{}';
    return `{\n${v.map((x) => `${inner}${luaValue(x, inner)},`).join('\n')}\n${indent}}`;
  }
  const keys = Object.keys(v).sort();
  if (!keys.length) return '{}';
  return `{\n${keys.map((k) => `${inner}${luaKey(k)} = ${luaValue(v[k], inner)},`).join('\n')}\n${indent}}`;
}

export function buildLrTemplate({ name, settings, processVersion, uuid = newUuid(), valueUuid = newUuid() }) {
  const plain = {};
  for (const s of settings) plain[s.name] = toPlain(s.name, s.value);
  if (processVersion) plain.ProcessVersion = String(processVersion);
  const doc = {
    id: uuid,
    internalName: name,
    title: name,
    type: 'Develop',
    value: { settings: plain, uuid: valueUuid },
    version: 0,
  };
  return `s = ${luaValue(doc, '')}\n`;
}

// Stable fingerprint of a set of settings, used to find photos sharing a preset.
export function fingerprint(settings) {
  const plain = settings
    .map((s) => [s.name, JSON.stringify(toPlain(s.name, s.value))])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const text = JSON.stringify(plain);
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

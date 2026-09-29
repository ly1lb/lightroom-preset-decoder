// XMP (RDF/XML) parsing into the value model used by preset.js, plus helpers
// to locate XMP packets inside JPEG / TIFF / DNG / PNG / HEIC / sidecar files.
import { NS } from './preset.js';

const RDF = NS.rdf;
const XML_NS = NS.xml;
const XMLNS = 'http://www.w3.org/2000/xmlns/';

// --- Packet extraction -------------------------------------------------------

const ascii = (bytes, start, len) => String.fromCharCode(...bytes.subarray(start, start + len));
const utf8 = new TextDecoder('utf-8');

function indexOfBytes(haystack, needle, from = 0) {
  const first = needle[0];
  const last = haystack.length - needle.length;
  outer: for (let i = haystack.indexOf(first, from); i !== -1 && i <= last; i = haystack.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const enc = (s) => new TextEncoder().encode(s);
const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';
const EXT_SIG = 'http://ns.adobe.com/xmp/extension/\0';

// JPEG: standard XMP in APP1 plus "Extended XMP" split across several APP1
// segments (Lightroom uses it for large settings such as masks and curves).
function jpegXmp(bytes) {
  const packets = [];
  const extended = new Map();
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) break;
    const marker = bytes[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    const start = pos + 4;
    const end = pos + 2 + len;
    if (marker === 0xe1) {
      if (ascii(bytes, start, XMP_SIG.length) === XMP_SIG) {
        packets.push(utf8.decode(bytes.subarray(start + XMP_SIG.length, end)));
      } else if (ascii(bytes, start, EXT_SIG.length) === EXT_SIG) {
        const p = start + EXT_SIG.length;
        const guid = ascii(bytes, p, 32);
        const view = new DataView(bytes.buffer, bytes.byteOffset + p + 32, 8);
        const total = view.getUint32(0);
        const offset = view.getUint32(4);
        if (!extended.has(guid)) extended.set(guid, { total, chunks: [] });
        extended.get(guid).chunks.push({ offset, data: bytes.subarray(p + 40, end) });
      }
    }
    pos = end;
  }
  for (const { total, chunks } of extended.values()) {
    const full = new Uint8Array(total);
    for (const c of chunks) full.set(c.data.subarray(0, Math.max(0, total - c.offset)), c.offset);
    packets.push(utf8.decode(full));
  }
  return packets;
}

// Any other container: scan for <x:xmpmeta …> … </x:xmpmeta> blocks.
function scanXmp(bytes) {
  const packets = [];
  const startTags = [enc('<x:xmpmeta'), enc('<x:xapmeta')];
  const endTags = [enc('</x:xmpmeta>'), enc('</x:xapmeta>')];
  for (let t = 0; t < startTags.length; t++) {
    let from = 0;
    for (;;) {
      const s = indexOfBytes(bytes, startTags[t], from);
      if (s < 0) break;
      const e = indexOfBytes(bytes, endTags[t], s);
      if (e < 0) break;
      packets.push(utf8.decode(bytes.subarray(s, e + endTags[t].length)));
      from = e;
    }
  }
  return packets;
}

export function extractXmpPackets(bytes, fileName = '') {
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  let packets = isJpeg ? jpegXmp(bytes) : [];
  if (!packets.length) packets = scanXmp(bytes);
  if (!packets.length && /\.xmp$/i.test(fileName)) packets = [utf8.decode(bytes)];
  return packets.map((p) => p.replace(/^[\s\S]*?(<x:x[am]pmeta|<rdf:RDF)/, '$1').replace(/\0+$/, ''));
}

// --- RDF parsing -------------------------------------------------------------

function isIgnoredAttr(attr) {
  return (
    attr.namespaceURI === XMLNS ||
    attr.namespaceURI === RDF ||
    attr.namespaceURI === XML_NS ||
    attr.name === 'xmlns' ||
    attr.name.startsWith('xmlns:')
  );
}

const elementChildren = (el) => Array.from(el.children);

function attrFields(el) {
  return Array.from(el.attributes)
    .filter((a) => !isIgnoredAttr(a))
    .map((a) => ({ ns: a.namespaceURI || '', prefix: a.prefix || '', name: a.localName, value: a.value }));
}

function childFields(el) {
  return elementChildren(el).map((c) => ({
    ns: c.namespaceURI || '',
    prefix: c.prefix || '',
    name: c.localName,
    value: parseValue(c),
  }));
}

function parseValue(el) {
  const resource = el.getAttributeNS(RDF, 'resource');
  if (resource) return resource;
  if (el.getAttributeNS(RDF, 'parseType') === 'Resource') {
    return { type: 'struct', fields: [...attrFields(el), ...childFields(el)] };
  }
  const kids = elementChildren(el);
  if (!kids.length) {
    const fields = attrFields(el);
    if (fields.length) return { type: 'struct', fields };
    return el.textContent;
  }
  const first = kids[0];
  if (first.namespaceURI === RDF) {
    const kind = first.localName;
    if (kind === 'Seq' || kind === 'Bag') {
      return {
        type: kind.toLowerCase(),
        items: elementChildren(first).filter((li) => li.localName === 'li').map(parseValue),
      };
    }
    if (kind === 'Alt') {
      return {
        type: 'alt',
        items: elementChildren(first)
          .filter((li) => li.localName === 'li')
          .map((li) => ({ lang: li.getAttributeNS(XML_NS, 'lang') || li.getAttribute('xml:lang') || '', value: li.textContent })),
      };
    }
    if (kind === 'Description') {
      return { type: 'struct', fields: [...attrFields(first), ...childFields(first)] };
    }
  }
  return { type: 'struct', fields: [...attrFields(el), ...childFields(el)] };
}

// Parses one or more XMP packets and merges their top-level properties.
export function parseXmp(packets) {
  const properties = new Map();
  const namespaces = new Map();
  const errors = [];
  for (const xml of packets) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      errors.push('Nepavyko perskaityti XMP paketo (neteisingas XML).');
      continue;
    }
    for (const desc of doc.getElementsByTagNameNS(RDF, 'Description')) {
      // Only top-level descriptions (direct children of rdf:RDF).
      if (!(desc.parentElement && desc.parentElement.namespaceURI === RDF && desc.parentElement.localName === 'RDF')) continue;
      for (const a of desc.attributes) {
        if (a.prefix === 'xmlns') namespaces.set(a.localName, a.value);
      }
      for (const f of [...attrFields(desc), ...childFields(desc)]) {
        properties.set(`${f.ns}|${f.name}`, f);
        if (f.prefix && !namespaces.has(f.prefix)) namespaces.set(f.prefix, f.ns);
      }
    }
  }
  return { properties: [...properties.values()], namespaces, errors };
}

// Flattens a value into [path, text] rows for display.
export function flatten(value, path = '') {
  if (typeof value === 'string') return [[path, value]];
  if (value.type === 'alt') {
    if (value.items.length === 1) return [[path, value.items[0].value]];
    return value.items.map((i) => [`${path}[${i.lang || '?'}]`, i.value]);
  }
  if (value.type === 'seq' || value.type === 'bag') {
    if (!value.items.length) return [[path, '(tuščia)']];
    if (value.items.every((i) => typeof i === 'string')) {
      if (value.items.length <= 12) return [[path, value.items.join(' · ')]];
    }
    return value.items.flatMap((it, i) => flatten(it, `${path}[${i + 1}]`));
  }
  if (value.type === 'struct') {
    if (!value.fields.length) return [[path, '(tuščia)']];
    return value.fields.flatMap((f) => flatten(f.value, path ? `${path}/${f.name}` : f.name));
  }
  return [[path, String(value)]];
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupOf, groupSettings, selectSettings, buildPresetXmp, buildLrTemplate, toPlain, fingerprint, NS,
} from '../public/js/preset.js';

const crs = (name, value) => ({ ns: NS.crs, prefix: 'crs', name, value });

const settings = [
  crs('Version', '15.4'),
  crs('ProcessVersion', '11.0'),
  crs('WhiteBalance', 'Custom'),
  crs('Temperature', '5600'),
  crs('Exposure2012', '+0.35'),
  crs('Saturation', '-10'),
  crs('HueAdjustmentRed', '+5'),
  crs('CropTop', '0.1'),
  crs('HasCrop', 'True'),
  crs('AlreadyApplied', 'True'),
  crs('ToneCurvePV2012', { type: 'seq', items: ['0, 0', '64, 50', '255, 255'] }),
  crs('Look', {
    type: 'struct',
    fields: [
      { ns: NS.crs, prefix: 'crs', name: 'Name', value: 'Adobe Color' },
      { ns: NS.crs, prefix: 'crs', name: 'Amount', value: '1' },
      { ns: NS.crs, prefix: 'crs', name: 'Group', value: { type: 'alt', items: [{ lang: 'x-default', value: 'Profiles' }] } },
    ],
  }),
];

test('keys are classified into Lightroom preset groups', () => {
  assert.equal(groupOf('Exposure2012'), 'basic');
  assert.equal(groupOf('Saturation'), 'presence');
  assert.equal(groupOf('SaturationAdjustmentRed'), 'hsl');
  assert.equal(groupOf('ToneCurvePV2012Red'), 'curve');
  assert.equal(groupOf('LensProfileName'), 'lensProfile');
  assert.equal(groupOf('LensProfileEnable'), 'lens');
  assert.equal(groupOf('CropTop'), 'crop');
  assert.equal(groupOf('MaskGroupBasedCorrections'), 'masks');
  assert.equal(groupOf('ShadowTint'), 'calibration');
  assert.equal(groupOf('SomethingNew'), 'other');
});

test('meta keys are never part of a preset', () => {
  const grouped = groupSettings(settings);
  const all = [...grouped.values()].flat().map((s) => s.name);
  assert.ok(!all.includes('Version'));
  assert.ok(!all.includes('AlreadyApplied'));
  const selected = selectSettings(settings, ['basic', 'crop']).map((s) => s.name);
  assert.deepEqual(selected, ['Exposure2012', 'CropTop', 'HasCrop']);
});

test('buildPresetXmp produces a well-formed Lightroom preset', () => {
  const chosen = selectSettings(settings, ['wb', 'basic', 'presence', 'hsl', 'curve', 'profile']);
  const xmp = buildPresetXmp({ name: 'Mano "vasara" & <šiluma>', group: 'Grupė', settings: chosen, processVersion: '11.0', version: '15.4', uuid: 'ABC' });
  assert.match(xmp, /crs:PresetType="Normal"/);
  assert.match(xmp, /crs:UUID="ABC"/);
  assert.match(xmp, /crs:ProcessVersion="11.0"/);
  assert.match(xmp, /crs:Exposure2012="\+0.35"/);
  assert.match(xmp, /crs:HasSettings="True"/);
  assert.match(xmp, /<rdf:li xml:lang="x-default">Mano &quot;vasara&quot; &amp; &lt;šiluma&gt;<\/rdf:li>/);
  assert.match(xmp, /<crs:ToneCurvePV2012>\s*<rdf:Seq>\s*<rdf:li>0, 0<\/rdf:li>/);
  assert.match(xmp, /<crs:Look>\s*<rdf:Description\s+crs:Name="Adobe Color"\s+crs:Amount="1">\s*<crs:Group>/);
  assert.doesNotMatch(xmp, /CropTop|AlreadyApplied|crs:Version="15.0"/);
  // Balanced tags.
  for (const tag of ['rdf:Description', 'rdf:Seq', 'rdf:Alt', 'crs:Look']) {
    const open = (xmp.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const selfClosed = (xmp.match(new RegExp(`<${tag}[^>]*/>`, 'g')) || []).length;
    const close = (xmp.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open - selfClosed, close, tag);
  }
});

test('buildLrTemplate converts values to Lua', () => {
  const chosen = selectSettings(settings, ['wb', 'basic', 'curve', 'profile']);
  const lua = buildLrTemplate({ name: 'Test "1"', settings: chosen, processVersion: '11.0', uuid: 'U1', valueUuid: 'U2' });
  assert.match(lua, /^s = \{/);
  assert.match(lua, /title = "Test \\"1\\"",/);
  assert.match(lua, /type = "Develop",/);
  assert.match(lua, /Exposure2012 = 0.35,/);
  assert.match(lua, /Temperature = 5600,/);
  assert.match(lua, /WhiteBalance = "Custom",/);
  assert.match(lua, /ProcessVersion = "11.0",/);
  assert.match(lua, /ToneCurvePV2012 = \{\s+0,\s+0,\s+64,\s+50,\s+255,\s+255,\s+\}/);
  assert.match(lua, /Look = \{\s+Amount = 1,\s+Group = "Profiles",\s+Name = "Adobe Color",/);
});

test('toPlain handles booleans and alt text', () => {
  assert.equal(toPlain('X', 'True'), true);
  assert.equal(toPlain('X', '-0.5'), -0.5);
  assert.equal(toPlain('X', { type: 'alt', items: [{ lang: 'x-default', value: 'A' }] }), 'A');
});

test('fingerprint is order independent and value sensitive', () => {
  const a = [crs('A', '1'), crs('B', '2')];
  const b = [crs('B', '2'), crs('A', '1')];
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint([crs('A', '1'), crs('B', '3')]));
});

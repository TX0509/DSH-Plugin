import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const clientPath = path.join(pluginDir, 'client.js');
const installScript = path.join(pluginDir, 'scripts', 'install.mjs');

/** Load the shipped bundle exactly as the DSH shell does, returning its test surface. */
async function loadBundle() {
  let definition = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(next) {
        definition = next;
      }
    }
  };
  await import(pathToFileURL(clientPath).href + '?case=' + Date.now() + Math.random());
  assert.ok(definition !== null, 'bundle registered with window.__ModuleLoader__');
  assert.equal(definition.id, 'dsh-selection-to-composer');
  const stub = {};
  const factory = definition.factory((specifier) => {
    if (specifier === 'react') return stub;
    throw new Error('unexpected require: ' + specifier);
  });
  assert.equal(typeof factory.apply, 'function');
  assert.deepEqual(factory.inject, ['slots', 'locale']);
  return factory.__internals;
}

const api = await loadBundle();

test('selection text drops blank edge lines but keeps indentation and inner breaks', () => {
  assert.equal(api.normalizeSelectionText('  first line\nsecond line  '), '  first line\nsecond line  ');
  assert.equal(api.normalizeSelectionText('\n\n  code();\n  more();\n\n'), '  code();\n  more();');
  assert.equal(api.normalizeSelectionText('a\u00a0b'), 'a b');
  assert.equal(api.normalizeSelectionText('first\r\nsecond'), 'first\nsecond');
  assert.equal(api.normalizeSelectionText('   \n\t '), '');
  assert.equal(api.normalizeSelectionText(null), '');
  assert.equal(api.normalizeSelectionText(undefined), '');
});

test('locale dictionaries stay in sync', () => {
  const zhKeys = Object.keys(api.ZH).sort();
  const enKeys = Object.keys(api.EN).sort();
  assert.deepEqual(zhKeys, enKeys);
  for (const key of zhKeys) {
    assert.equal(typeof api.ZH[key], 'string');
    assert.equal(typeof api.EN[key], 'string');
    assert.notEqual(api.ZH[key], '');
    assert.notEqual(api.EN[key], '');
  }
});

test('pill sits below the selection in the middle of the viewport', () => {
  const position = api.computePopoverPosition(
    { left: 200, right: 400, top: 300, bottom: 320 },
    { width: 1200, height: 800, topClearance: 0 }
  );
  assert.equal(position.placement, 'below');
  assert.equal(position.left, 300);
  assert.equal(position.top, 328);
});

test('pill flips above a selection near the bottom edge', () => {
  const position = api.computePopoverPosition(
    { left: 200, right: 400, top: 750, bottom: 770 },
    { width: 1200, height: 800, topClearance: 0 }
  );
  assert.equal(position.placement, 'above');
  assert.equal(position.top, 712);
});

test('pill stays inside the left and right viewport margins', () => {
  const right = api.computePopoverPosition(
    { left: 1150, right: 1190, top: 300, bottom: 320 },
    { width: 1200, height: 800, topClearance: 0 }
  );
  assert.equal(right.left, 1200 - 8 - 110);
  assert.ok(right.left + api.POPOVER_MAX_WIDTH / 2 <= 1200 - 8);

  const left = api.computePopoverPosition(
    { left: 0, right: 20, top: 300, bottom: 320 },
    { width: 1200, height: 800, topClearance: 0 }
  );
  assert.equal(left.left, 8 + 110);
  assert.ok(left.left - api.POPOVER_MAX_WIDTH / 2 >= 8);
});

test('pill centers itself on a narrow viewport instead of overflowing', () => {
  const position = api.computePopoverPosition(
    { left: 80, right: 120, top: 300, bottom: 320 },
    { width: 200, height: 800, topClearance: 0 }
  );
  assert.equal(position.left, 100);
  assert.equal(position.width, api.POPOVER_MAX_WIDTH);
});

test('pill stays inside the conversation column when the sidebar is open', () => {
  const position = api.computePopoverPosition(
    { left: 850, right: 890, top: 300, bottom: 320 },
    { width: 1200, height: 800, topClearance: 0, left: 300, right: 900 }
  );
  assert.equal(position.left, 900 - 8 - 110);
  assert.ok(position.left + api.POPOVER_MAX_WIDTH / 2 <= 900 - 8);
});

test('pill flips above rather than covering the composer card', () => {
  const position = api.computePopoverPosition(
    { left: 200, right: 400, top: 500, bottom: 520 },
    { width: 1200, height: 800, topClearance: 0, bottom: 560 }
  );
  assert.equal(position.placement, 'above');
  assert.equal(position.top, 500 - 8 - 30);
});

test('pill respects the desktop top-chrome clearance', () => {
  const position = api.computePopoverPosition(
    { left: 200, right: 400, top: 760, bottom: 780 },
    { width: 1200, height: 800, topClearance: 48 }
  );
  assert.equal(position.placement, 'above');
  assert.ok(position.top >= 48 + 8);
});

test('pill remains visible when neither side has its full preferred space', () => {
  const position = api.computePopoverPosition(
    { left: 50, right: 70, top: 70, bottom: 90 },
    { width: 200, height: 100, topClearance: 48 }
  );
  assert.equal(position.placement, 'above');
  assert.equal(position.top, 48 + 8);
});

test('bridge inserts at a freshly captured composer caret', () => {
  const calls = [];
  const span = { draftRev: 7, anchor: 3, focus: 3 };
  const bridge = api.createBridge({
    captureInsertion() {
      return span;
    },
    insertText(text, received) {
      calls.push([text, received]);
      return true;
    }
  }, { current: null });
  assert.equal(bridge.insert('selected\ncopy'), true);
  assert.deepEqual(calls, [['selected\ncopy', span]]);
});

test('bridge reports a refused insertion instead of throwing', () => {
  const refused = api.createBridge({
    captureInsertion: () => ({ draftRev: 1 }),
    insertText: () => false
  }, { current: null });
  assert.equal(refused.insert('text'), false);

  const throwing = api.createBridge({
    captureInsertion() {
      throw new Error('locked');
    },
    insertText: () => true
  }, { current: null });
  assert.equal(throwing.insert('text'), false);

  const missing = api.createBridge({}, { current: null });
  assert.equal(missing.insert('text'), false);
});

test('bridge selection follows the conversation that owns the selected text', () => {
  const mainScope = { name: 'main' };
  const sideScope = { name: 'sidebar' };
  const rootFor = (scope) => ({
    parentElement: null,
    contains(node) {
      return node === scope;
    }
  });
  const mainBridge = { rootOf: () => rootFor(mainScope), insert: () => true };
  const sideBridge = { rootOf: () => rootFor(sideScope), insert: () => true };
  assert.equal(api.resolveBridge([mainBridge, sideBridge], mainScope), mainBridge);
  assert.equal(api.resolveBridge([mainBridge, sideBridge], sideScope), sideBridge);
  assert.equal(api.resolveBridge([mainBridge], null), null);

  const unknownRoot = { rootOf: () => null, insert: () => true };
  assert.equal(api.resolveBridge([unknownRoot], mainScope), unknownRoot);
  assert.equal(api.resolveBridge([unknownRoot, sideBridge], mainScope), null);
});

test('readSelection is inert outside a browser document', () => {
  assert.equal(api.readSelection(), null);
});

test('bundle manifest declares the patch, client, locales, icon, and tested DSH range', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.manifestVersion, 1);
  assert.match(manifest.engines.dsh, /^>=0\.2\.1/);
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/*.json']) {
    assert.ok(manifest.files.includes(file), 'files must include ' + file);
  }
});

test('patch inserts one uniquely named host row', () => {
  const patch = fs.readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*selection-to-composer/);
  assert.match(patch, /name:\s*'dsh-selection-to-composer'/);
  assert.equal((patch.match(/- insert:/g) || []).length, 1);
});

test('locale resources provide real titles and descriptions for both languages', () => {
  for (const locale of ['zh', 'en']) {
    const resource = JSON.parse(fs.readFileSync(path.join(pluginDir, 'locale', locale + '.json'), 'utf8'));
    assert.equal(typeof resource.meta.title, 'string');
    assert.equal(typeof resource.meta.description, 'string');
    assert.ok(resource.meta.title.length > 0);
    assert.ok(resource.meta.description.length > 0);
    assert.ok(!/my-decoration|template/i.test(resource.meta.title + resource.meta.description));
  }
});

test('icon is a self-contained SVG document', () => {
  const icon = fs.readFileSync(path.join(pluginDir, 'icon.svg'), 'utf8');
  assert.match(icon, /^<svg\b/);
  assert.match(icon, /viewBox="0 0 64 64"/);
  assert.match(icon, /<\/svg>\s*$/);
  assert.ok(Buffer.byteLength(icon) < 256 * 1024);
  assert.ok(!/<script/i.test(icon));
});

function writeProfile(root, name) {
  const dir = path.join(root, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: 'dsh-profile-' + name,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } }
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

test('install script checks and dry-runs both profiles without writing them', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stc-install-'));
  try {
    writeProfile(home, 'web');
    writeProfile(home, 'desktop');
    const env = Object.assign({}, process.env, { DSH_HOME: home });

    const check = spawnSync(process.execPath, [installScript, '--check'], { env, encoding: 'utf8' });
    assert.equal(check.status, 1);
    assert.match(check.stdout, /\[FAIL\] web/);
    assert.match(check.stdout, /\[FAIL\] desktop/);

    const dryRun = spawnSync(process.execPath, [installScript, '--dry-run'], { env, encoding: 'utf8' });
    assert.equal(dryRun.status, 0);
    assert.match(dryRun.stdout, /\[plan\] web/);
    assert.match(dryRun.stdout, /\[plan\] desktop/);
    assert.equal(fs.existsSync(path.join(home, 'profiles', 'web', 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(home, 'profiles', 'desktop', 'node_modules')), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'web', 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, []);
    assert.deepEqual(manifest.dependencies, {});
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install script can target one profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stc-profile-'));
  try {
    writeProfile(home, 'web');
    const result = spawnSync(process.execPath, [installScript, '--profile', 'web', '--dry-run'], {
      env: Object.assign({}, process.env, { DSH_HOME: home }),
      encoding: 'utf8'
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[plan\] web/);
    assert.doesNotMatch(result.stdout, /\[plan\] desktop/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

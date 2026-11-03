import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const clientPath = path.join(pluginDir, 'client.js');

const ReactStub = {
  createElement(type, props, children) {
    return { type, props, children };
  }
};

async function loadClient() {
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
  assert.equal(definition.id, 'dsh-dev-commands');
  return definition.factory((specifier) => {
    if (specifier === 'react') return ReactStub;
    throw new Error('unexpected require: ' + specifier);
  });
}

const client = await loadClient();

function makeContext(rows) {
  const original = async () => rows;
  const ui = { candidates: original };
  let cleanup = null;
  const ctx = {
    commandUi: ui,
    effect(run) {
      cleanup = run();
    }
  };
  return {
    ctx,
    ui,
    original,
    runCleanup() {
      if (typeof cleanup === 'function') cleanup();
    }
  };
}

test('client half declares the commandUi injection and package wiring', () => {
  assert.deepEqual(client.inject, ['commandUi']);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-commands']);
  assert.ok(manifest.files.includes('client.js'));
});

test('attaches a built-in-style label and icon to /review and /ship rows only', async () => {
  const { ctx, ui } = makeContext([
    { name: 'review', description: '代码审查：审查当前工作区未提交的改动' },
    { name: 'ship', description: '提交并推送：提交并推送全部本地未提交改动' },
    { name: 'compact', description: 'compact', icon: 'existing-icon' }
  ]);
  client.apply(ctx);
  const rows = await ui.candidates('session', { query: '' });
  assert.equal(rows[0].label, '代码审查');
  assert.equal(rows[1].label, '提交并推送');
  assert.equal(rows[0].description, '审查当前工作区未提交的改动');
  assert.equal(rows[1].description, '提交全部本地未提交改动并推送');
  assert.equal(rows[2].label, undefined);
  assert.equal(typeof rows[0].icon, 'function');
  assert.equal(typeof rows[1].icon, 'function');
  assert.equal(rows[2].icon, 'existing-icon');
  assert.notEqual(rows[0].icon, rows[1].icon);
});

test('keeps a label or icon another plugin already supplied', async () => {
  const { ctx, ui } = makeContext([
    { name: 'review', label: '自定义审查', icon: 'custom-icon' }
  ]);
  client.apply(ctx);
  const rows = await ui.candidates('session', {});
  assert.equal(rows[0].label, '自定义审查');
  assert.equal(rows[0].icon, 'custom-icon');
});

test('icon components honor size and stay decorative', () => {
  const icon = client.__internals.ReviewIcon({ size: 20, className: 'x' });
  assert.equal(icon.type, 'svg');
  assert.equal(icon.props.width, 20);
  assert.equal(icon.props.height, 20);
  assert.equal(icon.props['aria-hidden'], 'true');
  assert.equal(icon.props.focusable, 'false');
  assert.equal(icon.props.className, 'x');

  const ship = client.__internals.ShipIcon();
  assert.equal(ship.type, 'svg');
  assert.equal(ship.props.width, 16);
});

test('restores the original candidate builder on cleanup', () => {
  const { ctx, ui, original, runCleanup } = makeContext([{ name: 'review' }]);
  client.apply(ctx);
  assert.notEqual(ui.candidates, original);
  runCleanup();
  assert.equal(ui.candidates, original);
});

test('does nothing when commandUi or candidates is unavailable', () => {
  assert.doesNotThrow(() => client.apply({}));
  assert.doesNotThrow(() => client.apply({ commandUi: {} }));
});

test('leaves non-array candidate results untouched', async () => {
  const { ctx, ui } = makeContext(null);
  client.apply(ctx);
  assert.equal(await ui.candidates('session', {}), null);
});

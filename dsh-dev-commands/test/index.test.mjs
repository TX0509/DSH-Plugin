import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { apply, __internals } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const installScript = path.join(pluginDir, 'scripts', 'install.mjs');

/** Run apply against a fake registry and capture what it registers. */
function loadDefinitions(options = {}) {
  const definitions = [];
  const warnings = [];
  const disposers = [];
  const ctx = {
    commands: {
      register(definition) {
        if (options.duplicate) throw new Error('duplicate command');
        definitions.push(definition);
        return () => {};
      }
    },
    effect(run) {
      disposers.push(run());
    },
    logger: {
      warn(message) {
        warnings.push(message);
      }
    }
  };
  apply(ctx);
  return { definitions, warnings, disposers };
}

function captureAgent() {
  const messages = [];
  return {
    messages,
    agent: {
      steer(message) {
        messages.push(message);
      }
    }
  };
}

test('registers /review and /ship with discoverable descriptions', () => {
  const { definitions, disposers } = loadDefinitions();
  assert.equal(definitions.length, 2);
  assert.equal(disposers.length, 2);
  const names = definitions.map((definition) => definition.name).sort();
  assert.deepEqual(names, ['review', 'ship']);
  for (const definition of definitions) {
    assert.ok(definition.description.length > 0);
    assert.match(definition.input.hint, /^\[.+\]$/);
    assert.equal(typeof definition.handler, 'function');
  }
});

test('/review submits a review-only prompt for uncommitted changes', () => {
  const { definitions } = loadDefinitions();
  const review = definitions.find((definition) => definition.name === 'review');
  const { agent, messages } = captureAgent();
  const result = review.handler({ agent, rawInput: '', attachments: [] });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /代码审查/);
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'user');
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0);
  const text = message.content[0].text;
  assert.match(text, /git status --short/);
  assert.match(text, /git diff --cached/);
  assert.match(text, /不要修改任何文件/);
  assert.doesNotMatch(text, /额外关注点/);
});

test('/review carries an optional focus and keeps message ids unique', () => {
  const { definitions } = loadDefinitions();
  const review = definitions.find((definition) => definition.name === 'review');
  const { agent, messages } = captureAgent();
  review.handler({ agent, rawInput: '  重点看并发和错误处理  ', attachments: [] });
  review.handler({ agent, rawInput: '', attachments: [] });
  assert.match(messages[0].content[0].text, /额外关注点（优先检查）：重点看并发和错误处理/);
  assert.notEqual(messages[0].id, messages[1].id);
});

test('/ship defaults to staging everything, committing, and pushing', () => {
  const { definitions } = loadDefinitions();
  const ship = definitions.find((definition) => definition.name === 'ship');
  const { agent, messages } = captureAgent();
  const result = ship.handler({ agent, rawInput: 'fix: handle empty diff', attachments: [] });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /提交并推送/);
  const text = messages[0].content[0].text;
  assert.match(text, /所有尚未提交的改动/);
  assert.match(text, /git add -A/);
  assert.match(text, /git push -u origin <当前分支>/);
  assert.match(text, /不要 amend/);
  assert.match(text, /提交说明\/补充要求：fix: handle empty diff/);
  assert.match(text, /密钥、凭据、个人隐私数据/);
});

test('a missing or rejecting agent becomes a command error, not a crash', () => {
  const { definitions } = loadDefinitions();
  const review = definitions.find((definition) => definition.name === 'review');
  const missing = review.handler({ agent: null, rawInput: '', attachments: [] });
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /没有可用的 Agent/);

  const rejecting = review.handler({
    agent: {
      steer() {
        throw new Error('inbox locked');
      }
    },
    rawInput: '',
    attachments: []
  });
  assert.equal(rejecting.kind, 'error');
  assert.match(rejecting.text, /inbox locked/);
});

test('a duplicate command name is logged and does not block the other command', () => {
  const { definitions, warnings } = loadDefinitions({ duplicate: true });
  assert.equal(definitions.length, 0);
  assert.equal(warnings.length, 2);
  for (const warning of warnings) assert.match(warning, /cannot register/);
});

test('manifest, patch, locales, and icon are complete', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-dev-commands');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.manifestVersion, 1);
  assert.match(manifest.engines.dsh, /^>=0\.2\.1/);
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  for (const file of ['index.js', 'cordis.patch.yml', 'icon.svg', 'locale/*.json']) {
    assert.ok(manifest.files.includes(file), 'files must include ' + file);
  }

  const patch = fs.readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*dev-commands/);
  assert.match(patch, /name:\s*'dsh-dev-commands'/);
  assert.equal((patch.match(/- insert:/g) || []).length, 1);

  for (const locale of ['zh', 'en']) {
    const resource = JSON.parse(fs.readFileSync(path.join(pluginDir, 'locale', locale + '.json'), 'utf8'));
    assert.equal(typeof resource.meta.title, 'string');
    assert.equal(typeof resource.meta.description, 'string');
    assert.ok(resource.meta.title.length > 0);
    assert.ok(resource.meta.description.length > 0);
  }

  const icon = fs.readFileSync(path.join(pluginDir, 'icon.svg'), 'utf8');
  assert.match(icon, /^<svg\b/);
  assert.match(icon, /viewBox="0 0 64 64"/);
  assert.match(icon, /<\/svg>\s*$/);
  assert.ok(Buffer.byteLength(icon) < 256 * 1024);
});

test('prompt builders do not inject undefined text', () => {
  assert.doesNotMatch(__internals.reviewPrompt(''), /undefined/);
  assert.doesNotMatch(__internals.shipPrompt(''), /undefined/);
  assert.match(__internals.reviewPrompt('x'), /x/);
  assert.match(__internals.shipPrompt('y'), /y/);
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dc-install-'));
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

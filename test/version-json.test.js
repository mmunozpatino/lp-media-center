import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVersionJson } from '../scripts/version-json.mjs';

const SHA_HOLA = 'b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79';

test('version.json con novedades, tamaño y huella de cada archivo', () => {
  const data = buildVersionJson({
    version: '0.1.40',
    notes: '- Cambio\n',
    files: [
      { name: 'LP-Cine-Vault.apk', bytes: Buffer.from('hola') },
      { name: 'LP-Cine-Vault-Setup.exe', bytes: Buffer.from('chau!') },
    ],
  });
  assert.deepEqual(data, {
    version: '0.1.40',
    notes: '- Cambio',
    assets: {
      'LP-Cine-Vault.apk': { size: 4, sha256: SHA_HOLA },
      'LP-Cine-Vault-Setup.exe': { size: 5, sha256: data.assets['LP-Cine-Vault-Setup.exe'].sha256 },
    },
  });
  assert.match(data.assets['LP-Cine-Vault-Setup.exe'].sha256, /^[a-f0-9]{64}$/);
});

test('version.json rechaza versiones, nombres y archivos raros', () => {
  const file = { name: 'a.apk', bytes: Buffer.from('x') };
  assert.throws(() => buildVersionJson({ version: 'v0.1', files: [file] }), /Versión/);
  assert.throws(() => buildVersionJson({ version: '0.1.2', files: [] }), /archivo/);
  assert.throws(() => buildVersionJson({ version: '0.1.2', files: [{ name: '../a.apk', bytes: Buffer.from('x') }] }), /Nombre/);
  assert.throws(() => buildVersionJson({ version: '0.1.2', files: [file, file] }), /Nombre/);
  assert.throws(() => buildVersionJson({ version: '0.1.2', files: [{ name: 'a.apk', bytes: Buffer.alloc(0) }] }), /vacío/);
});

test('version.json desde la línea de comandos, como en el workflow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-version-'));
  fs.writeFileSync(path.join(dir, 'LP-Cine-Vault.apk'), 'hola');
  fs.writeFileSync(path.join(dir, 'novedades.md'), '- Uno\n- Dos\n');
  const script = path.join(import.meta.dirname, '..', 'scripts', 'version-json.mjs');
  execFileSync(process.execPath, [script, '0.1.41', path.join(dir, 'novedades.md'), path.join(dir, 'version.json'), path.join(dir, 'LP-Cine-Vault.apk')]);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
  assert.deepEqual(data, { version: '0.1.41', notes: '- Uno\n- Dos', assets: { 'LP-Cine-Vault.apk': { size: 4, sha256: SHA_HOLA } } });
});

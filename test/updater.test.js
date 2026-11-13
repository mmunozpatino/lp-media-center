import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { INSTALLER_ARGS, downloadInstaller, installLatest, isNewerVersion, pickInstaller } = require('../electron/updater.cjs');

const BYTES = Buffer.from('instalador de ejemplo '.repeat(1000));
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');
const URL_OK = 'https://github.com/mmunozpatino/lp-media-center/releases/download/v0.1.9/LP-Cine-Vault-Setup.exe';

function release({ tag = 'v0.1.9', url = URL_OK, digest = 'sha256:' + SHA, size = BYTES.length } = {}) {
  return {
    tag_name: tag,
    assets: [
      { name: 'LP-Cine-Vault.apk', browser_download_url: URL_OK.replace('Setup.exe', '.apk'), digest: 'sha256:' + SHA, size: 10 },
      { name: 'LP-Cine-Vault-Setup.exe', browser_download_url: url, digest, size },
    ],
  };
}

/** Respuesta con el cuerpo en pedazos, como una descarga real. */
function streamResponse(bytes, status = 200) {
  const chunks = [bytes.subarray(0, 5000), bytes.subarray(5000)];
  const body = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(new Uint8Array(next));
      else controller.close();
    },
  });
  return new Response(body, { status });
}

function fakeFetch({ rel = release(), bytes = BYTES } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) return Response.json(rel);
    if (url === URL_OK) return streamResponse(bytes);
    return new Response('no', { status: 404 });
  };
  return { fetchImpl, calls };
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lp-act-'));

test('compara versiones número por número', () => {
  assert.equal(isNewerVersion('v0.1.10', '0.1.9'), true);
  assert.equal(isNewerVersion('0.1.9', '0.1.9'), false);
  assert.equal(isNewerVersion('0.1.8', '0.1.9'), false);
  assert.equal(isNewerVersion('0.2.0', '0.1.99'), true);
});

test('toma el instalador de Windows con su huella', () => {
  assert.deepEqual(pickInstaller(release()), { version: '0.1.9', url: URL_OK, sha256: SHA, size: BYTES.length });
});

test('rechaza instaladores de otro lado, sin huella o de tamaño raro', () => {
  assert.throws(() => pickInstaller(release({ url: 'https://example.com/LP-Cine-Vault-Setup.exe' })), /dirección/);
  assert.throws(() => pickInstaller(release({ url: URL_OK.replace('mmunozpatino', 'otra') })), /dirección/);
  assert.throws(() => pickInstaller(release({ digest: null })), /huella/);
  assert.throws(() => pickInstaller(release({ digest: 'md5:abc' })), /huella/);
  assert.throws(() => pickInstaller(release({ size: 0 })), /tamaño/);
  assert.throws(() => pickInstaller({ tag_name: 'v1', assets: [] }), /no trae/);
});

test('baja el instalador y comprueba la huella', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'setup.exe');
  const progress = [];
  await downloadInstaller(pickInstaller(release()), file, { fetchImpl: fakeFetch().fetchImpl, onProgress: (p) => progress.push(p) });
  assert.deepEqual(fs.readFileSync(file), BYTES);
  assert.equal(progress.at(-1).received, BYTES.length);
  assert.ok(progress.length >= 2);
});

test('si la huella no coincide, borra el archivo y no sigue', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'setup.exe');
  const altered = Buffer.from(BYTES);
  altered[10] ^= 1;
  await assert.rejects(downloadInstaller(pickInstaller(release()), file, { fetchImpl: fakeFetch({ bytes: altered }).fetchImpl }), /huella/);
  assert.equal(fs.existsSync(file), false);
});

test('si llega incompleto o de más, borra el archivo', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'setup.exe');
  await assert.rejects(downloadInstaller(pickInstaller(release()), file, { fetchImpl: fakeFetch({ bytes: BYTES.subarray(0, 9000) }).fetchImpl }), /incompleto/);
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(downloadInstaller(pickInstaller(release()), file, { fetchImpl: fakeFetch({ bytes: Buffer.concat([BYTES, BYTES]) }).fetchImpl }), /más grande/);
  assert.equal(fs.existsSync(file), false);
});

test('instala la versión nueva en silencio y vuelve a abrir la app', async () => {
  const launched = [];
  const result = await installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: fakeFetch().fetchImpl, launch: (file) => launched.push(file) });
  assert.deepEqual(result, { version: '0.1.9' });
  assert.equal(launched.length, 1);
  assert.deepEqual(fs.readFileSync(launched[0]), BYTES);
  assert.deepEqual(INSTALLER_ARGS, ['--updated', '/S', '--force-run']);
});

test('no instala si ya está al día, si es de desarrollo o si la huella falla', async () => {
  const launch = () => assert.fail('no debería instalar');
  await assert.rejects(installLatest({ currentVersion: '0.1.9', tempDir: tempDir(), fetchImpl: fakeFetch().fetchImpl, launch }), /última versión/);
  await assert.rejects(installLatest({ currentVersion: null, tempDir: tempDir(), fetchImpl: fakeFetch().fetchImpl, launch }), /desarrollo/);
  const altered = Buffer.from(BYTES);
  altered[0] ^= 1;
  await assert.rejects(installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: fakeFetch({ bytes: altered }).fetchImpl, launch }), /huella/);
});

test('lee la última versión de la redirección, sin seguirla ni usar la API', async () => {
  const { fetchLatestTag, tagFromLocation } = require('../electron/updater.cjs');
  assert.equal(tagFromLocation('https://github.com/mmunozpatino/lp-media-center/releases/tag/v0.1.15'), 'v0.1.15');
  assert.equal(tagFromLocation('https://github.com/otra/repo/releases/tag/v9.9.9'), null);
  const seen = [];
  const redirect = async (url, options) => (seen.push([url, options.method, options.redirect]), new Response(null, { status: 302, headers: { location: 'https://github.com/mmunozpatino/lp-media-center/releases/tag/v0.1.15' } }));
  assert.equal(await fetchLatestTag(redirect), 'v0.1.15');
  assert.deepEqual(seen, [['https://github.com/mmunozpatino/lp-media-center/releases/latest', 'HEAD', 'manual']]);
  await assert.rejects(fetchLatestTag(async () => new Response('', { status: 200 })), /no informó/);
  await assert.rejects(fetchLatestTag(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })), /no informó/);
});

test('si la API cortó por su límite, lo dice con la hora y no instala', async () => {
  const limited = async () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } });
  await assert.rejects(
    installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: limited, launch: () => assert.fail('no debería instalar') }),
    /GitHub limitó las consultas.*después de las/,
  );
  // Sin digest no se instala, aunque la versión sea nueva.
  const sinHuella = async (url) => (url.startsWith('https://api.github.com/') ? Response.json(release({ digest: null })) : new Response('', { status: 404 }));
  await assert.rejects(installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: sinHuella, launch: () => assert.fail('no debería instalar') }), /huella/);
});

test('con net de Electron: toma el destino de la redirección sin seguirla', async () => {
  const { EventEmitter } = require('node:events');
  const { latestTagWithNet } = require('../electron/updater.cjs');
  const fakeNet = (event, ...args) => ({
    request(options) {
      assert.deepEqual(options, { url: 'https://github.com/mmunozpatino/lp-media-center/releases/latest', method: 'HEAD', redirect: 'manual' });
      const request = new EventEmitter();
      request.abort = () => {};
      request.end = () => setImmediate(() => request.emit(event, ...args));
      return request;
    },
  });
  assert.equal(await latestTagWithNet(fakeNet('redirect', 302, 'HEAD', 'https://github.com/mmunozpatino/lp-media-center/releases/tag/v0.1.15')), 'v0.1.15');
  await assert.rejects(latestTagWithNet(fakeNet('redirect', 302, 'HEAD', 'https://evil.example/releases/tag/v9.0.0')), /no informó/);
  await assert.rejects(latestTagWithNet(fakeNet('response', {})), /no informó/);
  await assert.rejects(latestTagWithNet(fakeNet('error', new Error('x'))), /No se pudo/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { INSTALLER_ARGS, downloadInstaller, installLatest, isNewerVersion, latestRelease, parseManifest, pickInstaller } = require('../electron/updater.cjs');

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

const LATEST = 'https://github.com/mmunozpatino/lp-media-center/releases/latest';
const manifestUrl = (tag) => `https://github.com/mmunozpatino/lp-media-center/releases/download/${tag}/version.json`;

function manifest({ version = '0.1.9', sha256 = SHA, size = BYTES.length, notes = '- Uno\n- Dos\n' } = {}) {
  return {
    version,
    notes,
    assets: { 'LP-Cine-Vault.apk': { size: 10, sha256: SHA }, 'LP-Cine-Vault-Setup.exe': { size, sha256 } },
  };
}

/**
 * Simula a GitHub: la redirección de /releases/latest a `tag`, version.json (`man`, o 404 si es null), la API (`rel`)
 * y el instalador.
 */
function fakeFetch({ rel = release(), bytes = BYTES, tag = 'v0.1.9', man = null, manText = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    if (url === LATEST && options.method === 'HEAD') {
      return new Response(null, { status: 302, headers: { location: `https://github.com/mmunozpatino/lp-media-center/releases/tag/${tag}` } });
    }
    if (url === manifestUrl(tag)) {
      if (manText !== null) return new Response(manText);
      return man ? Response.json(man) : new Response('Not Found', { status: 404 });
    }
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
  const base = fakeFetch().fetchImpl;
  const calls = [];
  const limited = async (url, options) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } });
    }
    return base(url, options);
  };
  const apiLimit = {};
  await assert.rejects(
    installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: limited, apiLimit, launch: () => assert.fail('no debería instalar') }),
    /GitHub limitó las consultas.*después de las/,
  );
  // Mientras dura el corte, no vuelve a consultar la API.
  const apiCalls = () => calls.filter((url) => url.startsWith('https://api.github.com/')).length;
  assert.equal(apiCalls(), 1);
  await assert.rejects(installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: limited, apiLimit, launch: () => assert.fail('no') }), /limitó/);
  assert.equal(apiCalls(), 1);
  // Para el aviso, sin la API igual se sabe que hay una nueva: solo faltan las novedades.
  assert.deepEqual(await latestRelease({ currentVersion: '0.1.6', fetchImpl: limited, apiLimit }), { tag: 'v0.1.9', notes: '' });
  // Sin digest no se instala, aunque la versión sea nueva.
  const sinHuella = fakeFetch({ rel: release({ digest: null }) }).fetchImpl;
  await assert.rejects(installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: sinHuella, apiLimit: {}, launch: () => assert.fail('no debería instalar') }), /huella/);
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

test('con version.json: valida el instalador contra su tamaño y huella, sin la API', async () => {
  const { fetchImpl, calls } = fakeFetch({ man: manifest() });
  const launched = [];
  const result = await installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl, apiLimit: {}, launch: (file) => launched.push(file) });
  assert.deepEqual(result, { version: '0.1.9' });
  assert.deepEqual(fs.readFileSync(launched[0]), BYTES);
  assert.deepEqual(calls, [LATEST, manifestUrl('v0.1.9'), URL_OK]);
});

test('con version.json: no instala si la huella o el tamaño no coinciden', async () => {
  const launch = () => assert.fail('no debería instalar');
  const otherSha = crypto.createHash('sha256').update('otro').digest('hex');
  await assert.rejects(installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: fakeFetch({ man: manifest({ sha256: otherSha }) }).fetchImpl, launch }), /huella/);
  await assert.rejects(installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: fakeFetch({ man: manifest({ size: BYTES.length - 1 }) }).fetchImpl, launch }), /más grande/);
  await assert.rejects(installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: fakeFetch({ man: manifest({ size: BYTES.length + 1 }) }).fetchImpl, launch }), /incompleto/);
});

test('version.json: la versión tiene que ser la del tag y la dirección la arma la app', () => {
  const parsed = parseManifest(manifest(), 'v0.1.9');
  assert.deepEqual(parsed, { version: '0.1.9', notes: '- Uno\n- Dos', installer: { version: '0.1.9', url: URL_OK, sha256: SHA, size: BYTES.length } });
  // Una dirección dentro del archivo se ignora.
  const withUrl = { ...manifest(), assets: { 'LP-Cine-Vault-Setup.exe': { size: 5, sha256: SHA, url: 'https://evil.example/x.exe' } } };
  assert.equal(parseManifest(withUrl, 'v0.1.9').installer.url, URL_OK);
  assert.throws(() => parseManifest(manifest({ version: '0.1.8' }), 'v0.1.9'), /no coincide/);
  assert.throws(() => parseManifest(manifest(), '0.1.9'), /inválida/);
  assert.throws(() => parseManifest(manifest(), 'v0.1.9/../x'), /inválida/);
  assert.throws(() => parseManifest(manifest({ sha256: 'abc' }), 'v0.1.9'), /huella/);
  assert.throws(() => parseManifest(manifest({ size: 0 }), 'v0.1.9'), /tamaño/);
  assert.throws(() => parseManifest(manifest({ size: '12' }), 'v0.1.9'), /tamaño/);
  assert.throws(() => parseManifest({ version: '0.1.9', assets: {} }, 'v0.1.9'), /no trae/);
});

test('version.json dañado o enorme: no sigue', async () => {
  const launch = () => assert.fail('no debería instalar');
  await assert.rejects(installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: fakeFetch({ manText: '{roto' }).fetchImpl, launch }), /dañado/);
  await assert.rejects(installLatest({ currentVersion: '0.1.6', tempDir: tempDir(), fetchImpl: fakeFetch({ manText: ' '.repeat(300 * 1024) }).fetchImpl, launch }), /más grande/);
});

test('aviso: novedades de version.json, sin la API; al día, sin bajar nada más', async () => {
  const withManifest = fakeFetch({ man: manifest() });
  assert.deepEqual(await latestRelease({ currentVersion: '0.1.6', fetchImpl: withManifest.fetchImpl, apiLimit: {} }), { tag: 'v0.1.9', notes: '- Uno\n- Dos' });
  assert.deepEqual(withManifest.calls, [LATEST, manifestUrl('v0.1.9')]);
  const upToDate = fakeFetch({ man: manifest() });
  assert.deepEqual(await latestRelease({ currentVersion: '0.1.9', fetchImpl: upToDate.fetchImpl, apiLimit: {} }), { tag: 'v0.1.9', notes: '' });
  assert.deepEqual(upToDate.calls, [LATEST]);
  // Versión vieja sin version.json: las novedades salen de la API.
  const old = fakeFetch({ rel: { ...release(), body: '- Desde la API\n' } });
  assert.deepEqual(await latestRelease({ currentVersion: '0.1.6', fetchImpl: old.fetchImpl, apiLimit: {} }), { tag: 'v0.1.9', notes: '- Desde la API' });
  // Con latestTag propio (en la app, net.request): no pide la redirección por fetch.
  const own = fakeFetch({ man: manifest() });
  await latestRelease({ currentVersion: '0.1.6', fetchImpl: own.fetchImpl, latestTag: async () => 'v0.1.9', apiLimit: {} });
  assert.deepEqual(own.calls, [manifestUrl('v0.1.9')]);
});

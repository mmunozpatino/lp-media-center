// Sección Jellyfin, con un Jellyfin simulado: nunca se autoriza un código ni se desconecta nada real.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, createApp, createAuth, createJellyfin, listen } from '../backend/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-jellyfin-'));
const KEY = 'a'.repeat(32);
const config = { ...DEFAULT_CONFIG, httpTimeoutMs: 1000, services: { ...DEFAULT_CONFIG.services, jellyfin: { url: 'http://jellyfin' } } };
const ANA = 'b'.repeat(32);
const TELE = 'c'.repeat(32);
const OWN = 'd'.repeat(32);

function fakeJellyfin({ goodKey = KEY, authorize = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const { pathname, search } = new URL(url);
    const method = options.method ?? 'GET';
    calls.push({ method, path: pathname + search, auth: options.headers?.Authorization });
    if (options.headers?.Authorization !== `MediaBrowser Token="${goodKey}"`) return new Response('', { status: 401 });
    const json = (value) => Response.json(value);
    if (pathname === '/QuickConnect/Enabled') return json(true);
    if (pathname === '/Users') return json([{ Id: ANA, Name: 'Ana', Policy: { IsAdministrator: true } }]);
    if (pathname === '/Devices' && method === 'GET') {
      return json({ Items: [
        { Id: TELE, Name: 'Tele del living', AppName: 'Jellyfin Android TV', AppVersion: '0.18', LastUserName: 'Ana', DateLastActivity: '2026-11-12T20:00:00Z' },
        { Id: OWN, Name: 'PC', AppName: 'LP Cine Vault', DateLastActivity: '2026-11-13T10:00:00Z' },
      ] });
    }
    if (pathname === '/Devices' && method === 'DELETE') return new Response(null, { status: 204 });
    if (pathname === '/Sessions') {
      return json([
        { UserId: ANA, UserName: 'Ana', DeviceName: 'Tele del living', Client: 'Android TV',
          NowPlayingItem: { Name: 'Pilot', SeriesName: 'The Office', RunTimeTicks: 100 }, PlayState: { PositionTicks: 25, IsPaused: false } },
        { UserId: ANA, DeviceName: 'Celu' },
      ]);
    }
    if (pathname === '/System/ActivityLog/Entries') return json({ Items: [{ Name: 'Ana inició sesión', Date: '2026-11-12T19:00:00Z', UserId: ANA }] });
    if (pathname === '/QuickConnect/Authorize') return authorize === 404 ? new Response('', { status: 404 }) : json(authorize);
    return new Response('', { status: 404 });
  };
  return { fetchImpl, calls };
}

function withKey(name = 'clave') {
  const file = path.join(tmp, `${name}-${Math.random().toString(16).slice(2)}.key`);
  fs.writeFileSync(file, KEY + '\n');
  return file;
}

describe('Jellyfin', () => {
  test('sin clave, la sección explica cómo crearla y no consulta nada', async () => {
    const jf = fakeJellyfin();
    const jellyfin = createJellyfin(config, { fetchImpl: jf.fetchImpl, keyFile: path.join(tmp, 'no-existe.key') });
    assert.deepEqual(await jellyfin.overview(), [200, { configured: false }]);
    assert.deepEqual(jf.calls, []);
  });

  test('muestra usuarios, dispositivos, lo que se está mirando y la actividad, sin la clave', async () => {
    const jf = fakeJellyfin();
    const [status, body] = await createJellyfin(config, { fetchImpl: jf.fetchImpl, keyFile: withKey() }).overview();
    assert.equal(status, 200);
    assert.equal(body.quickConnect, true);
    assert.deepEqual(body.users, [{ id: ANA, name: 'Ana' }]);
    assert.deepEqual(body.devices.map((d) => [d.name, d.app, d.user, d.own]), [
      ['PC', 'LP Cine Vault', null, true],
      ['Tele del living', 'Jellyfin Android TV 0.18', 'Ana', false],
    ]);
    assert.deepEqual(body.playing, [{ user: 'Ana', device: 'Tele del living', app: 'Android TV', title: 'The Office · Pilot', progress: 0.25, paused: false }]);
    assert.deepEqual(body.activity.map((a) => [a.text, a.user]), [['Ana inició sesión', 'Ana']]);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(KEY));
  });

  test('una clave que Jellyfin rechaza se informa sin romper la sección', async () => {
    const jf = fakeJellyfin({ goodKey: 'otra' });
    const [, body] = await createJellyfin(config, { fetchImpl: jf.fetchImpl, keyFile: withKey() }).overview();
    assert.deepEqual(body, { configured: true, error: 'Jellyfin rechazó la clave' });
  });

  test('acceso rápido: valida el código y el usuario, y autoriza con el userId elegido', async () => {
    const jf = fakeJellyfin();
    const jellyfin = createJellyfin(config, { fetchImpl: jf.fetchImpl, keyFile: withKey() });
    assert.equal((await jellyfin.authorize({ code: '12a456', userId: ANA }))[0], 400);
    assert.equal((await jellyfin.authorize({ code: '123456', userId: 'nadie' }))[0], 400);
    assert.equal((await jellyfin.authorize({ code: '123456', userId: 'e'.repeat(32) }))[0], 400); // No existe en Jellyfin.
    const [status, body] = await jellyfin.authorize({ code: '123 456', userId: ANA });
    assert.equal(status, 200);
    assert.match(body.message, /Ana/);
    assert.ok(jf.calls.some((c) => c.method === 'POST' && c.path === `/QuickConnect/Authorize?code=123456&userId=${ANA}`));
  });

  test('acceso rápido: un código vencido o rechazado se explica', async () => {
    let jf = fakeJellyfin({ authorize: 404 });
    assert.deepEqual(await createJellyfin(config, { fetchImpl: jf.fetchImpl, keyFile: withKey() }).authorize({ code: '123456', userId: ANA }), [409, { error: 'Ese código no existe o ya venció.' }]);
    jf = fakeJellyfin({ authorize: false });
    assert.equal((await createJellyfin(config, { fetchImpl: jf.fetchImpl, keyFile: withKey() }).authorize({ code: '123456', userId: ANA }))[0], 409);
  });

  test('desconecta un dispositivo, pero nunca el de esta app ni uno inventado', async () => {
    const jf = fakeJellyfin();
    const jellyfin = createJellyfin(config, { fetchImpl: jf.fetchImpl, keyFile: withKey() });
    assert.equal((await jellyfin.removeDevice(OWN))[0], 409);
    assert.equal((await jellyfin.removeDevice('f'.repeat(32)))[0], 404);
    assert.equal((await jellyfin.removeDevice('../x'))[0], 404);
    assert.equal(jf.calls.filter((c) => c.method === 'DELETE').length, 0);
    assert.equal((await jellyfin.removeDevice(TELE))[0], 200);
    assert.deepEqual(jf.calls.filter((c) => c.method === 'DELETE').map((c) => c.path), [`/Devices?id=${TELE}`]);
  });

  test('guarda la clave solo si Jellyfin la acepta, y no la devuelve', async () => {
    const file = path.join(tmp, 'guardada.key');
    const jellyfin = createJellyfin(config, { fetchImpl: fakeJellyfin().fetchImpl, keyFile: file });
    assert.equal((await jellyfin.saveKey({ key: 'corta' }))[0], 400);
    assert.equal((await jellyfin.saveKey({ key: 'b'.repeat(32) }))[0], 400); // Jellyfin no la acepta.
    assert.equal(fs.existsSync(file), false);
    const result = await jellyfin.saveKey({ key: ` ${KEY} ` });
    assert.deepEqual(result, [200, { ok: true }]);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), KEY);
  });

  test('autorizar y desconectar piden la contraseña del panel y el origen de la app', async () => {
    const auth = createAuth({ file: path.join(tmp, 'auth.json') });
    auth.setPassword({ user: 'admin', password: 'contraseña-buena' });
    const asked = [];
    const jellyfin = {
      overview: async () => [200, { configured: false }],
      authorize: async (body) => (asked.push(['authorize', body.code]), [200, { ok: true }]),
      removeDevice: async (id) => (asked.push(['remove', id]), [200, { ok: true }]),
    };
    const server = createApp(async () => ({}), { allowedOrigins: ['app://lp-media-center'], auth, jellyfin });
    const { port } = await listen(server, '127.0.0.1', 0);
    const post = (pathname, body, origin = 'app://lp-media-center') =>
      fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(body),
      });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/jellyfin`)).status, 200);
      assert.equal((await post('/api/jellyfin/quick-connect', { password: 'mala', code: '123456' })).status, 401);
      assert.equal((await post('/api/jellyfin/quick-connect', { password: 'contraseña-buena', code: '123456' }, null)).status, 403);
      assert.equal((await post(`/api/jellyfin/devices/${TELE}/remove`, { password: 'mala' })).status, 401);
      assert.deepEqual(asked, []);
      assert.equal((await post('/api/jellyfin/quick-connect', { password: 'contraseña-buena', code: '123456' })).status, 200);
      assert.equal((await post(`/api/jellyfin/devices/${TELE}/remove`, { password: 'contraseña-buena' })).status, 200);
      assert.deepEqual(asked, [['authorize', '123456'], ['remove', TELE]]);
    } finally {
      server.close();
    }
  });
});

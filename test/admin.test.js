// Administrador de LP Cine Vault: crearlo, restablecerlo y errores claros. Siempre con un archivo temporal.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, createAuth, listen } from '../backend/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-admin-'));
const newAuth = (options = {}) => createAuth({ file: path.join(tmp, `auth-${Math.random().toString(16).slice(2)}.json`), ...options });

describe('administrador', () => {
  test('sin administrador, todo lo delicado dice que falta configurarlo en la PC', () => {
    const auth = newAuth();
    assert.deepEqual(auth.adminInfo(), { configured: false, user: null });
    const [status, body] = auth.verifyAdmin({ password: 'lo-que-sea' });
    assert.equal(status, 403);
    assert.equal(body.code, 'admin-missing');
    assert.match(body.error, /configuralo en la app de la PC/);
  });

  test('crearlo pide usuario, 8 caracteres y que la repetición coincida', () => {
    const auth = newAuth();
    assert.equal(auth.setPassword({ user: ' ', password: 'una-clave-larga' })[0], 400);
    assert.equal(auth.setPassword({ user: 'ana', password: 'corta' })[0], 400);
    assert.match(auth.setPassword({ user: 'ana', password: 'una-clave-larga', repeat: 'otra-clave' })[1].error, /no coinciden/);
    const [status, body] = auth.setPassword({ user: ' ana ', password: 'una-clave-larga', repeat: 'una-clave-larga' });
    assert.equal(status, 200);
    assert.equal(body.created, true);
    assert.deepEqual(auth.adminInfo(), { configured: true, user: 'ana' });
  });

  test('contraseña incorrecta dice cuántos intentos quedan y nombra al usuario; el quinto bloquea con los segundos', () => {
    let clock = 1_000_000;
    const auth = newAuth({ now: () => clock });
    auth.setPassword({ user: 'ana', password: 'una-clave-larga' });
    const first = auth.verifyAdmin({ password: 'mala' });
    assert.equal(first[0], 401);
    assert.equal(first[1].code, 'wrong-password');
    assert.equal(first[1].attemptsLeft, 4);
    assert.match(first[1].error, /administrador \(ana\).*Quedan 4 intentos/);
    for (let i = 0; i < 3; i++) auth.verifyAdmin({ password: 'mala' });
    const locked = auth.verifyAdmin({ password: 'mala' });
    assert.equal(locked[0], 429);
    assert.equal(locked[1].code, 'locked');
    assert.equal(locked[1].retryInSeconds, 60);
    clock += 20_000;
    const still = auth.verifyAdmin({ password: 'una-clave-larga' });
    assert.equal(still[1].retryInSeconds, 40); // Ni la buena pasa mientras dura el bloqueo.
    clock += 41_000;
    assert.equal(auth.verifyAdmin({ password: 'una-clave-larga' })[0], 200);
  });

  test('restablecer desde la PC no pide la anterior, cierra las sesiones y borra el bloqueo', () => {
    const auth = newAuth();
    auth.setPassword({ user: 'ana', password: 'una-clave-larga' });
    for (let i = 0; i < 5; i++) auth.verifyAdmin({ password: 'mala' });
    assert.equal(auth.verifyAdmin({ password: 'una-clave-larga' })[0], 429);
    const [status, body] = auth.setPassword({ user: 'ana', password: 'clave-nueva-larga', repeat: 'clave-nueva-larga' });
    assert.equal(status, 200);
    assert.equal(body.created, false);
    assert.match(body.message, /restablecida/);
    assert.equal(auth.verifyAdmin({ password: 'una-clave-larga' })[0], 401); // La anterior ya no vale.
    assert.equal(auth.verifyAdmin({ password: 'clave-nueva-larga' })[0], 200);
  });

  test('el estado dice quién es el administrador, nunca el hash', async () => {
    const auth = newAuth();
    auth.setPassword({ user: 'ana', password: 'una-clave-larga' });
    const server = createApp(async () => ({ parts: [] }), { allowedOrigins: ['app://lp-media-center'], auth });
    const { port } = await listen(server, '127.0.0.1', 0);
    try {
      const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
      assert.deepEqual(status.admin, { configured: true, user: 'ana' });
      assert.doesNotMatch(JSON.stringify(status), /salt|hash/);
    } finally {
      server.close();
    }
  });
});

// Borrar un pedido: la única excepción a no tocar la biblioteca. Todo con programas simulados: nunca se borra nada real.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, createAuth, createRequestRemover, isInsideFolder, isTitleFolder, parseRequestId } from '../backend/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-borrar-'));
const keyFile = (name) => {
  const file = path.join(tmp, `${name}.xml`);
  fs.writeFileSync(file, `<Config><ApiKey>clave-${name}</ApiKey></Config>`);
  return file;
};
const seerrFile = path.join(tmp, 'seerr.json');
fs.writeFileSync(seerrFile, JSON.stringify({ main: { apiKey: 'clave-seerr' } }));
const mailboxFile = path.join(tmp, 'buzon.json');
fs.writeFileSync(mailboxFile, JSON.stringify({ mailboxUrl: 'https://buzon.example', mailboxKey: 'clave-buzon' }));

const config = {
  ...DEFAULT_CONFIG,
  httpTimeoutMs: 1000,
  services: {
    ...DEFAULT_CONFIG.services,
    radarr: { url: 'http://radarr', keyFile: keyFile('radarr') },
    sonarr: { url: 'http://sonarr', keyFile: keyFile('sonarr') },
    seerr: { url: 'http://seerr', keyFile: seerrFile },
    jellyfin: { url: 'http://jellyfin' },
  },
};

const inboxMovie = {
  id: 7, tmdbId: 840, title: 'Metropolis', monitored: true, hasFile: true,
  path: 'F:\\Movies\\_inbox\\Metropolis (1927)', movieFile: { path: 'F:\\Movies\\_inbox\\Metropolis (1927)\\Metropolis.mkv' },
};
const libraryMovie = { ...inboxMovie, id: 8, monitored: false, path: 'F:\\Movies\\Drama\\Metropolis (1927)', movieFile: { path: 'F:\\Movies\\Drama\\Metropolis (1927)\\M.mkv' } };

/** Programas simulados: responde según método y ruta, y anota cada llamada. */
function fakePrograms(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const { host, pathname, search } = new URL(url);
    calls.push({ method, host, path: pathname + search, headers: options.headers, body: options.body });
    for (const [pattern, reply] of routes) {
      const [m, h, p] = pattern.split(' ');
      if (m === method && h === host && (p === pathname + search || p === pathname)) {
        const value = typeof reply === 'function' ? reply() : reply;
        if (value === 404) return new Response('', { status: 404 });
        if (value === 500) return new Response('', { status: 500 });
        return Response.json(value ?? {});
      }
    }
    return new Response('', { status: 404 });
  };
  const deletes = () => calls.filter((call) => call.method === 'DELETE' || call.method === 'PUT').map((call) => `${call.method} ${call.host}${call.path}`);
  return { fetchImpl, calls, deletes };
}

const remover = (programs, options = {}) =>
  createRequestRemover(config, {
    fetchImpl: programs.fetchImpl,
    sleep: async () => {},
    mailboxConfigFile: mailboxFile,
    jellyfinKeyFile: path.join(tmp, 'sin-clave-jellyfin'),
    ...options,
  });

async function planAndRemove(r, id) {
  const [status, body] = await r.plan(id);
  assert.equal(status, 200, JSON.stringify(body));
  return { plan: body.plan, result: await r.remove(id, { token: body.token }) };
}

describe('carpetas de pedidos', () => {
  test('solo la carpeta propia de un título, directamente dentro de la raíz', () => {
    assert.equal(isTitleFolder('F:\\Movies\\_inbox\\Metropolis (1927)', 'F:\\Movies\\_inbox'), true);
    assert.equal(isTitleFolder('F:\\Movies\\_inbox', 'F:\\Movies\\_inbox'), false);
    assert.equal(isTitleFolder('F:\\Movies\\Drama\\Metropolis', 'F:\\Movies\\_inbox'), false);
    assert.equal(isTitleFolder('F:\\Movies\\_inbox\\a\\b', 'F:\\Movies\\_inbox'), false);
    assert.equal(isTitleFolder('F:\\Movies\\_inbox\\..\\Drama', 'F:\\Movies\\_inbox'), false);
    assert.equal(isTitleFolder('F:\\Series\\The Office', 'F:\\Series'), true);
  });

  test('un archivo tiene que estar dentro de la carpeta del título', () => {
    assert.equal(isInsideFolder('F:\\Series\\S\\Season 1\\e1.mkv', 'F:\\Series\\S'), true);
    assert.equal(isInsideFolder('F:\\Series\\Otra\\e1.mkv', 'F:\\Series\\S'), false);
    assert.equal(isInsideFolder('F:\\Series\\S\\..\\Otra\\e1.mkv', 'F:\\Series\\S'), false);
  });

  test('reconoce los ids que lista la interfaz y nada más', () => {
    assert.deepEqual(parseRequestId('12'), { origin: 'seerr', seerrId: 12 });
    assert.deepEqual(parseRequestId('radarr-7'), { origin: 'telegram', kind: 'movie', arrId: 7 });
    assert.deepEqual(parseRequestId('buzon-tv-3-1400'), { origin: 'telegram', kind: 'tv', mailboxId: 3, tmdbId: 1400 });
    for (const bad of ['', 'radarr-', 'jellyfin-1', '../1', '1; rm']) assert.equal(parseRequestId(bad), null, bad);
  });
});

describe('contraseña de administrador', () => {
  test('una contraseña mala no deja ver ni borrar, y cinco frenan un minuto', () => {
    let clock = 1_000_000;
    const auth = createAuth({ file: path.join(tmp, 'auth.json'), now: () => clock });
    assert.equal(auth.verifyAdmin({ password: 'x' })[0], 403); // Sin contraseña creada todavía.
    auth.setPassword({ user: 'admin', password: 'contraseña-buena' });
    assert.equal(auth.verifyAdmin({ password: 'contraseña-buena' })[0], 200);
    for (let i = 0; i < 5; i++) assert.equal(auth.verifyAdmin({ password: 'mala' })[0], 401);
    assert.equal(auth.verifyAdmin({ password: 'contraseña-buena' })[0], 429);
    clock += 61_000;
    assert.equal(auth.verifyAdmin({ password: 'contraseña-buena' })[0], 200);
  });
});

describe('borrar un pedido', () => {
  test('pedido de Seerr ya bajado: borra el pedido, el torrent y la película con su archivo', async () => {
    const programs = fakePrograms([
      ['GET seerr /api/v1/request/5', { id: 5, type: 'movie', media: { tmdbId: 840 } }],
      ['GET radarr /api/v3/movie?tmdbId=840', [inboxMovie]],
      ['GET radarr /api/v3/queue', { records: [{ id: 91, movieId: 7 }, { id: 92, movieId: 99 }] }],
      ['DELETE seerr /api/v1/request/5', {}],
      ['DELETE radarr /api/v3/queue/91', {}],
      ['DELETE radarr /api/v3/movie/7', {}],
    ]);
    const { plan, result } = await planAndRemove(remover(programs), '5');
    assert.deepEqual(plan.files, ['F:\\Movies\\_inbox\\Metropolis (1927)\\Metropolis.mkv']);
    assert.equal(plan.deletesFiles, true);
    assert.equal(result[0], 200);
    assert.deepEqual(programs.deletes(), [
      'DELETE seerr/api/v1/request/5',
      'DELETE radarr/api/v3/queue/91?removeFromClient=true&blocklist=false',
      'DELETE radarr/api/v3/movie/7?deleteFiles=true&addImportExclusion=false',
    ]);
    // Sin clave de Jellyfin no se le pide nada, y se avisa.
    assert.match(result[1].results.at(-1).message, /clave de Jellyfin/);
    // Las claves solo viajan en cabeceras hacia los programas, nunca en la respuesta.
    assert.doesNotMatch(JSON.stringify(result[1]), /clave-/);
  });

  test('desde Downloads: busca por tmdbId, borra el pedido de Seerr si lo hay y el torrent', async () => {
    const programs = fakePrograms([
      ['GET seerr /api/v1/request', { results: [{ id: 9, type: 'movie', media: { tmdbId: 840 } }] }],
      ['GET radarr /api/v3/movie?tmdbId=840', [{ ...inboxMovie, hasFile: false }]],
      ['GET radarr /api/v3/queue', { records: [{ id: 31, movieId: 7 }] }],
      ['DELETE seerr /api/v1/request/9', {}],
      ['DELETE radarr /api/v3/queue/31', {}],
      ['DELETE radarr /api/v3/movie/7', {}],
    ]);
    const { result } = await planAndRemove(remover(programs), 'cola-movie-840');
    assert.equal(result[1].ok, true);
    assert.deepEqual(programs.deletes(), [
      'DELETE seerr/api/v1/request/9',
      'DELETE radarr/api/v3/queue/31?removeFromClient=true&blocklist=false',
      'DELETE radarr/api/v3/movie/7?deleteFiles=true&addImportExclusion=false',
    ]);
    // Lo de la biblioteca, tampoco desde Downloads.
    const library = fakePrograms([['GET seerr /api/v1/request', { results: [] }], ['GET radarr /api/v3/movie?tmdbId=840', [libraryMovie]]]);
    assert.equal((await remover(library).plan('cola-movie-840'))[0], 409);
  });

  test('algo importado a la biblioteca no se borra, aunque se pida por su id', async () => {
    const programs = fakePrograms([['GET radarr /api/v3/movie/8', libraryMovie]]);
    const [status, body] = await remover(programs).plan('radarr-8');
    assert.equal(status, 409);
    assert.match(body.error, /biblioteca/);
    assert.deepEqual(programs.deletes(), []);
  });

  test('un pedido de Seerr de algo que ya estaba en la biblioteca borra solo el pedido', async () => {
    const programs = fakePrograms([
      ['GET seerr /api/v1/request/6', { id: 6, type: 'movie', media: { tmdbId: 840 } }],
      ['GET radarr /api/v3/movie?tmdbId=840', [libraryMovie]],
      ['DELETE seerr /api/v1/request/6', {}],
    ]);
    const { plan, result } = await planAndRemove(remover(programs), '6');
    assert.equal(plan.deletesFiles, false);
    assert.equal(result[0], 200);
    assert.deepEqual(programs.deletes(), ['DELETE seerr/api/v1/request/6']);
  });

  test('una carpeta o un archivo fuera de las carpetas de pedidos no se borra', async () => {
    const outside = { ...inboxMovie, path: 'F:\\Movies\\_inbox\\Metropolis\\..\\..\\Drama' };
    let programs = fakePrograms([['GET radarr /api/v3/movie/7', outside]]);
    assert.equal((await remover(programs).plan('radarr-7'))[0], 409);
    const strayFile = { ...inboxMovie, movieFile: { path: 'F:\\Movies\\Drama\\Otra.mkv' } };
    programs = fakePrograms([['GET radarr /api/v3/movie/7', strayFile]]);
    const [status, body] = await remover(programs).plan('radarr-7');
    assert.equal(status, 409);
    assert.match(body.error, /carpeta/);
    assert.deepEqual(programs.deletes(), []);
  });

  test('buzón sin publicar: lo dice y no deja el pedido a medio borrar', async () => {
    const programs = fakePrograms([['POST buzon.example /api/requests/3/cancel', 404]]);
    const { result } = await planAndRemove(remover(programs), 'buzon-movie-3-840');
    assert.equal(result[1].ok, false);
    assert.match(result[1].results[0].message, /todavía no acepta cancelar/);
    assert.deepEqual(programs.deletes(), []);
    const call = programs.calls.find((c) => c.host === 'buzon.example');
    assert.equal(call.headers.Authorization, 'Bearer clave-buzon');
  });

  test('pedido ya tomado del buzón: vuelve a mirar Radarr y lo borra ahí', async () => {
    let lookups = 0;
    const programs = fakePrograms([
      ['GET radarr /api/v3/movie?tmdbId=840', () => (++lookups < 3 ? [] : [{ ...inboxMovie, hasFile: false }])],
      ['POST buzon.example /api/requests/3/cancel', { ok: true, cancelled: false, status: 'done' }],
      ['GET radarr /api/v3/queue', { records: [{ id: 5, movieId: 7 }] }],
      ['DELETE radarr /api/v3/queue/5', {}],
      ['DELETE radarr /api/v3/movie/7', {}],
    ]);
    const { result } = await planAndRemove(remover(programs), 'buzon-movie-3-840');
    assert.equal(result[1].ok, true, JSON.stringify(result[1]));
    assert.match(result[1].results[0].message, /ya lo había tomado/);
    assert.deepEqual(programs.deletes(), [
      'DELETE radarr/api/v3/queue/5?removeFromClient=true&blocklist=false',
      'DELETE radarr/api/v3/movie/7?deleteFiles=true&addImportExclusion=false',
    ]);
  });

  test('pedido cancelado en el buzón antes de que la PC lo tome', async () => {
    const programs = fakePrograms([
      ['GET radarr /api/v3/movie?tmdbId=840', []],
      ['POST buzon.example /api/series/requests/4/cancel', { ok: true, cancelled: true }],
    ]);
    const r = remover(programs);
    const [status, body] = await r.plan('buzon-tv-4-840');
    assert.equal(status, 200);
    const result = await r.remove('buzon-tv-4-840', { token: body.token });
    assert.equal(result[1].ok, true);
    assert.deepEqual(programs.deletes(), []);
  });

  test('serie con episodios de la biblioteca: borra solo los pedidos y deja de buscar los que faltan', async () => {
    const series = { id: 3, title: 'S', monitored: true, path: 'F:\\Series\\S' };
    const programs = fakePrograms([
      ['GET sonarr /api/v3/series/3', series],
      ['GET sonarr /api/v3/episode', [
        { id: 1, hasFile: true, episodeFileId: 11, monitored: false }, // De la biblioteca.
        { id: 2, hasFile: true, episodeFileId: 12, monitored: true }, // Pedido y bajado.
        { id: 3, hasFile: false, monitored: true }, // Pedido, todavía no.
      ]],
      ['GET sonarr /api/v3/episodefile', [{ id: 11, path: 'F:\\Series\\S\\Season 1\\e1.mkv' }, { id: 12, path: 'F:\\Series\\S\\Season 2\\e1.mkv' }]],
      ['GET sonarr /api/v3/history/series', [{ episodeId: 2, eventType: 'downloadFolderImported' }]],
      ['GET sonarr /api/v3/queue', { records: [] }],
      ['DELETE sonarr /api/v3/episodefile/12', {}],
      ['PUT sonarr /api/v3/episode/monitor', {}],
    ]);
    const { plan, result } = await planAndRemove(remover(programs), 'sonarr-3');
    assert.deepEqual(plan.files, ['F:\\Series\\S\\Season 2\\e1.mkv']);
    assert.ok(plan.steps.some((step) => /Se conservan 1 episodio/.test(step)));
    assert.equal(result[0], 200);
    assert.deepEqual(programs.deletes(), ['DELETE sonarr/api/v3/episodefile/12', 'PUT sonarr/api/v3/episode/monitor']);
    assert.deepEqual(JSON.parse(programs.calls.find((c) => c.method === 'PUT').body), { episodeIds: [2, 3], monitored: false });
  });

  test('serie que entró entera por el pedido: se borra completa', async () => {
    const series = { id: 4, title: 'T', monitored: true, path: 'F:\\Series\\T' };
    const programs = fakePrograms([
      ['GET sonarr /api/v3/series/4', series],
      ['GET sonarr /api/v3/episode', [{ id: 1, hasFile: true, episodeFileId: 21, monitored: true }]],
      ['GET sonarr /api/v3/episodefile', [{ id: 21, path: 'F:\\Series\\T\\Season 1\\e1.mkv' }]],
      ['GET sonarr /api/v3/history/series', [{ episodeId: 1, eventType: 'downloadFolderImported' }]],
      ['GET sonarr /api/v3/queue', { records: [] }],
      ['DELETE sonarr /api/v3/series/4', {}],
    ]);
    const { result } = await planAndRemove(remover(programs), 'sonarr-4');
    assert.equal(result[0], 200);
    assert.deepEqual(programs.deletes(), ['DELETE sonarr/api/v3/series/4?deleteFiles=true&addImportExclusion=false']);
  });

  test('sin confirmación válida, o si algo cambió desde que se confirmó, no borra', async () => {
    let hasFile = false;
    const programs = fakePrograms([
      ['GET radarr /api/v3/movie/7', () => ({ ...inboxMovie, hasFile })],
      ['GET radarr /api/v3/queue', { records: [] }],
    ]);
    let clock = 0;
    const r = remover(programs, { now: () => clock });
    assert.equal((await r.remove('radarr-7', { token: 'inventado' }))[0], 403);
    let [, body] = await r.plan('radarr-7');
    assert.equal((await r.remove('radarr-8', { token: body.token }))[0], 403); // Otro pedido.
    [, body] = await r.plan('radarr-7');
    clock += 4 * 60 * 1000;
    assert.equal((await r.remove('radarr-7', { token: body.token }))[0], 403); // Vencida.
    [, body] = await r.plan('radarr-7');
    hasFile = true; // Se terminó de bajar entre la confirmación y el borrado.
    assert.equal((await r.remove('radarr-7', { token: body.token }))[0], 409);
    assert.deepEqual(programs.deletes(), []);
  });

  test('si un paso falla, se corta y dice qué quedó hecho', async () => {
    const programs = fakePrograms([
      ['GET seerr /api/v1/request/5', { id: 5, type: 'movie', media: { tmdbId: 840 } }],
      ['GET radarr /api/v3/movie?tmdbId=840', [inboxMovie]],
      ['GET radarr /api/v3/queue', { records: [] }],
      ['DELETE seerr /api/v1/request/5', {}],
      ['DELETE radarr /api/v3/movie/7', 500],
    ]);
    const { result } = await planAndRemove(remover(programs), '5');
    assert.equal(result[1].ok, false);
    assert.equal(result[1].results[0].message, 'Pedido borrado en Seerr');
    assert.match(result[1].results[1].message, /Radarr.*Lo anterior ya quedó hecho/);
  });
});

describe('ruta de borrado', () => {
  test('con la contraseña mala ni siquiera arma el plan, y sin el origen de la app no hace nada', async () => {
    const { createApp, listen } = await import('../backend/server.js');
    const auth = createAuth({ file: path.join(tmp, 'auth-ruta.json') });
    auth.setPassword({ user: 'admin', password: 'contraseña-buena' });
    const asked = [];
    const requests = { plan: async (id) => (asked.push(id), [200, { token: 't', plan: {} }]), remove: async () => [200, { ok: true }] };
    const server = createApp(async () => ({}), { allowedOrigins: ['app://lp-media-center'], auth, requests });
    const { port } = await listen(server, '127.0.0.1', 0);
    const post = (pathname, body, origin = 'app://lp-media-center') =>
      fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify(body),
      });
    try {
      assert.equal((await post('/api/requests/radarr-7/plan', { password: 'mala' })).status, 401);
      assert.equal((await post('/api/requests/radarr-7/plan', { password: 'contraseña-buena' }, null)).status, 403);
      assert.deepEqual(asked, []);
      assert.equal((await post('/api/requests/radarr-7/plan', { password: 'contraseña-buena' })).status, 200);
      assert.deepEqual(asked, ['radarr-7']);
    } finally {
      server.close();
    }
  });
});

describe('lo que espera en el buzón', () => {
  test('lee /api/waiting una vez por minuto, nunca /api/pending, y sin publicar no muestra nada', async () => {
    const { createMailboxReader } = await import('../backend/server.js');
    let clock = 0;
    const asked = [];
    let reply = () => new Response('', { status: 404 });
    const read = createMailboxReader({
      file: mailboxFile,
      now: () => clock,
      fetchImpl: async (url, options) => (asked.push([url, options.headers.Authorization]), reply()),
    });
    assert.equal(await read(), null); // Todavía sin publicar.
    reply = () => Response.json({ movies: [{ id: 3, tmdbId: 840, title: 'Metropolis', year: 1927 }], series: [] });
    assert.equal(await read(), null); // Dentro del minuto no vuelve a preguntar.
    clock += 61_000;
    assert.deepEqual((await read()).movies.map((m) => m.id), [3]);
    assert.deepEqual(asked.map(([url]) => url), ['https://buzon.example/api/waiting', 'https://buzon.example/api/waiting']);
    assert.equal(asked[0][1], 'Bearer clave-buzon');
  });

  test('suma lo del buzón como pedido de Telegram, distinguiendo películas y series, sin repetir', async () => {
    const { waitingInMailbox } = await import('../backend/server.js');
    const requests = { items: [{ kind: 'movie', tmdbId: 1 }], total: 1, error: null };
    const waiting = {
      movies: [{ id: 3, tmdbId: 840, title: 'Metropolis', year: 1927 }, { id: 4, tmdbId: 1, title: 'Ya en Seerr' }],
      series: [{ id: 3, tmdbId: 840, tvdbId: 9, title: 'Serie', year: 2020, seasons: '2' }, { id: 5, tmdbId: 77, title: 'Toda', seasons: 'all' }],
    };
    const result = waitingInMailbox(waiting, requests, { items: [] });
    assert.deepEqual(result.items.slice(1).map((item) => [item.id, item.status, item.origin, item.seasons]), [
      ['buzon-movie-3-840', 'waiting', 'telegram', []],
      ['buzon-tv-3-840', 'waiting', 'telegram', [2]],
      ['buzon-tv-5-77', 'waiting', 'telegram', []],
    ]);
    assert.equal(result.total, 4);
    assert.equal(waitingInMailbox(null, requests, { items: [] }), requests);
  });
});

describe('importar a mano una descarga trabada', () => {
  const queue = {
    records: [
      { id: 1, downloadId: 'ABC', movieId: 283, trackedDownloadState: 'importBlocked', title: 'Obsession.2025.2026.2160p',
        movie: { title: 'Obsession', year: 2026 }, statusMessages: [{ messages: ['Manual Import required.'] }] },
      { id: 2, downloadId: 'DEF', movieId: 9, trackedDownloadState: 'downloading', movie: { title: 'Lucy', year: 2014 } },
    ],
  };
  const candidates = [
    { path: 'D:\Descargas\Obsession\Obsession.mp4', relativePath: 'Obsession.mp4', size: 10, quality: { q: 1 }, languages: [], rejections: [] },
    { path: 'D:\Descargas\Obsession\sample.mp4', relativePath: 'sample.mp4', size: 1, rejections: [{ reason: 'Sample' }] },
  ];

  test('importa como el título para el que se pidió, sin las muestras, y no toca lo que no está trabado', async () => {
    const { createImporter } = await import('../backend/server.js');
    const programs = fakePrograms([
      ['GET radarr /api/v3/queue', queue],
      ['GET radarr /api/v3/manualimport', candidates],
      ['POST radarr /api/v3/command', { id: 5 }],
    ]);
    const importer = createImporter(config, { fetchImpl: programs.fetchImpl });
    const [status, plan] = await importer.plan('radarr', 'ABC');
    assert.equal(status, 200);
    assert.equal(plan.title, 'Obsession (2026)');
    assert.deepEqual(plan.files.map((file) => file.name), ['Obsession.mp4']);
    assert.equal((await importer.run('radarr', 'ABC'))[0], 200);
    const command = JSON.parse(programs.calls.find((call) => call.method === 'POST').body);
    assert.equal(command.name, 'ManualImport');
    assert.deepEqual(command.files.map((file) => [file.path, file.movieId, file.downloadId]), [['D:\Descargas\Obsession\Obsession.mp4', 283, 'ABC']]);
    assert.equal((await importer.plan('radarr', 'DEF'))[0], 409); // Se está bajando: no se importa.
    assert.equal((await importer.plan('radarr', 'ZZZ'))[0], 409); // Ya no está.
    assert.deepEqual(programs.deletes(), []);
  });

  test('desde la red no se acepta: solo desde la app de la PC', async () => {
    const { createApp, listen } = await import('../backend/server.js');
    const asked = [];
    const imports = { plan: async (...args) => (asked.push(args), [200, {}]), run: async () => [200, {}] };
    const server = createApp(async () => ({}), { allowedOrigins: ['app://lp-media-center'], imports });
    const { port } = await listen(server, '127.0.0.1', 0);
    try {
      const sinOrigen = await fetch(`http://127.0.0.1:${port}/api/imports/radarr/ABC/plan`, { method: 'POST' });
      assert.equal(sinOrigen.status, 403);
      const local = await fetch(`http://127.0.0.1:${port}/api/imports/radarr/ABC/plan`, { method: 'POST', headers: { Origin: 'app://lp-media-center' } });
      assert.equal(local.status, 200);
      assert.deepEqual(asked, [['radarr', 'ABC']]);
    } finally {
      server.close();
    }
  });
});

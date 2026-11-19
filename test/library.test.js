// Library: lo que ya llegó a Radarr y Sonarr. Todo con programas simulados: nunca se lee ni se borra nada real.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, createApp, createAuth, createLibrary, createRequestRemover, listen } from '../backend/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-library-'));
const keyFile = (name) => {
  const file = path.join(tmp, `${name}.xml`);
  fs.writeFileSync(file, `<Config><ApiKey>clave-${name}</ApiKey></Config>`);
  return file;
};
const seerrFile = path.join(tmp, 'seerr.json');
fs.writeFileSync(seerrFile, JSON.stringify({ main: { apiKey: 'clave-seerr' } }));
const bazarrFile = path.join(tmp, 'bazarr.yaml');
fs.writeFileSync(bazarrFile, 'auth:\n  apikey: clave-bazarr\n');
const JF_KEY = 'f'.repeat(32);
const jellyfinKeyFile = path.join(tmp, 'jellyfin.key');
fs.writeFileSync(jellyfinKeyFile, JF_KEY + '\n');

const config = {
  ...DEFAULT_CONFIG,
  httpTimeoutMs: 1000,
  services: {
    ...DEFAULT_CONFIG.services,
    radarr: { url: 'http://radarr', keyFile: keyFile('radarr') },
    sonarr: { url: 'http://sonarr', keyFile: keyFile('sonarr') },
    seerr: { url: 'http://seerr', keyFile: seerrFile },
    bazarr: { url: 'http://bazarr', keyFile: bazarrFile },
    jellyfin: { url: 'http://jellyfin' },
  },
};

// "Hoy" para los tests: las fechas van al mediodía UTC, que es el mismo día en casi cualquier huso horario.
const NOW = Date.parse('2026-11-18T12:00:00Z');
const daysAgo = (days, hour = 12) => new Date(NOW - days * 86400000).toISOString().slice(0, 10) + `T${String(hour).padStart(2, '0')}:00:00Z`;
const quality = (name) => ({ quality: { name } });
const english = [{ id: 1, name: 'English' }];

// Pedido que llegó hace 3 días: monitoreado y en su carpeta de _inbox. Seerr lo tiene pedido.
const requested = {
  id: 7, tmdbId: 840, title: 'Metropolis', year: 1927, monitored: true, hasFile: true,
  path: 'F:\\Movies\\_inbox\\Metropolis (1927)',
  images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/t/p/original/poster840.jpg' }],
  movieFile: { id: 70, path: 'F:\\Movies\\_inbox\\Metropolis (1927)\\Metropolis (1927).mkv', relativePath: 'Metropolis (1927).mkv', size: 4e9,
    dateAdded: daysAgo(3), quality: quality('Bluray-1080p'), languages: [{ id: 3, name: 'Spanish' }], sceneName: 'Metropolis.1927.1080p',
    mediaInfo: { audioLanguages: 'spa/eng', subtitles: 'spa' } },
};
// Pedido del bot que llegó hace 40 días: fuera de Recientes, pero en la biblioteca y borrable.
const older = {
  id: 8, tmdbId: 841, title: 'Nosferatu', year: 1922, monitored: true, hasFile: true, path: 'F:\\Movies\\_inbox\\Nosferatu (1922)',
  movieFile: { id: 80, path: 'F:\\Movies\\_inbox\\Nosferatu (1922)\\Nosferatu (1922).mkv', size: 2e9, dateAdded: daysAgo(40), quality: quality('WEBDL-1080p'), languages: english },
};
// Biblioteca vieja: sin monitorear y en otra carpeta de F:\Movies. Nunca se borra.
const library = {
  id: 9, tmdbId: 842, title: 'Amélie', year: 2001, monitored: false, hasFile: true, path: 'F:\\Movies\\Comedia\\Amelie (2001)',
  movieFile: { id: 90, path: 'F:\\Movies\\Comedia\\Amelie (2001)\\Amelie.mkv', size: 3e9, dateAdded: daysAgo(400), quality: quality('Bluray-720p'), languages: english },
};
// Monitoreada en _inbox pero importada hace poco desde la biblioteca, sin descarga: está en la biblioteca, no en Recientes.
const missingFile = { id: 10, tmdbId: 843, title: 'Sin archivo', monitored: true, hasFile: false, path: 'F:\\Movies\\_inbox\\Sin archivo (2026)' };

const office = {
  id: 12, tmdbId: 2316, tvdbId: 73244, title: 'The Office', year: 2005, monitored: true, path: 'F:\\Series\\The Office (2005)',
  statistics: { episodeFileCount: 3, sizeOnDisk: 3e9 },
};
const oldShow = {
  id: 13, tmdbId: 1400, tvdbId: 79168, title: 'Seinfeld', year: 1989, monitored: false, path: 'F:\\Series\\Seinfeld (1989)',
  statistics: { episodeFileCount: 1, sizeOnDisk: 1e9 },
};
const emptyShow = { id: 14, tmdbId: 1500, title: 'Sin capítulos', monitored: true, path: 'F:\\Series\\Sin', statistics: { episodeFileCount: 0 } };

const episodeFile = (id, season, day, extra = {}) => ({
  id, seriesId: 12, seasonNumber: season, relativePath: `Season ${season}\\S0${season}E0${id - 100}.mkv`,
  path: `F:\\Series\\The Office (2005)\\Season ${season}\\S0${season}E0${id - 100}.mkv`, size: 1e9, dateAdded: daysAgo(day),
  quality: quality('Bluray-1080p'), languages: english, sceneName: `The.Office.S0${season}E0${id - 100}`, mediaInfo: { audioLanguages: 'eng' }, ...extra,
});
const officeFiles = [episodeFile(101, 1, 2), episodeFile(102, 1, 2), episodeFile(103, 2, 5)];
const seinfeldFiles = [{ id: 201, seriesId: 13, seasonNumber: 1, path: 'F:\\Series\\Seinfeld (1989)\\S01E01.mkv', size: 1e9, dateAdded: daysAgo(500), quality: quality('DVD'), languages: english }];
const officeEpisodes = [
  { id: 1001, seasonNumber: 1, episodeNumber: 1, title: 'Pilot', hasFile: true, episodeFileId: 101 },
  { id: 1002, seasonNumber: 1, episodeNumber: 2, title: 'Diversity Day', hasFile: true, episodeFileId: 102 },
  { id: 1003, seasonNumber: 2, episodeNumber: 1, title: 'The Dundies', hasFile: true, episodeFileId: 103 },
];

const radarrImport = (movie, fileId, days, downloadId) => ({
  eventType: 'downloadFolderImported', movieId: movie.id, date: daysAgo(days), downloadId, sourceTitle: `${movie.title}.import`, data: { fileId: String(fileId) },
});
const sonarrImport = (fileId, episode, days, downloadId = 'PACK1') => ({
  eventType: 'downloadFolderImported', seriesId: 12, episodeId: episode.id, date: daysAgo(days), downloadId, sourceTitle: `ep-${fileId}`,
  data: { fileId: String(fileId) }, episode: { seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber, title: episode.title },
});

function routes({ radarrDown = false, bazarrDown = false } = {}) {
  return {
    'radarr /api/v3/movie': radarrDown ? 500 : [requested, older, library, missingFile],
    'radarr /api/v3/history/since': [
      radarrImport(requested, 70, 3, 'DL70'),
      radarrImport(requested, 69, 4, 'DL69'), // Un archivo anterior, ya reemplazado: no se muestra.
      radarrImport(older, 80, 40, 'DL80'), // Más de 30 días: no es reciente (Radarr igual lo filtra por fecha).
    ],
    'radarr /api/v3/movie/7': requested,
    'radarr /api/v3/history/movie': [
      radarrImport(requested, 70, 3, 'DL70'),
      { eventType: 'grabbed', movieId: 7, downloadId: 'DL70', sourceTitle: 'Metropolis.1927.Restored.1080p.BluRay-GRP', date: daysAgo(3) },
    ],
    'radarr /api/v3/queue': { records: [] },
    'radarr /api/v3/movie?tmdbId=840': [requested],
    'radarr /api/v3/movie?tmdbId=842': [library],
    'radarr /api/v3/movie/9': library,
    'sonarr /api/v3/series': [office, oldShow, emptyShow],
    'sonarr /api/v3/series/12': office,
    'sonarr /api/v3/history/since': [
      sonarrImport(101, officeEpisodes[0], 2),
      sonarrImport(102, officeEpisodes[1], 2),
      sonarrImport(103, officeEpisodes[2], 5, 'PACK2'),
    ],
    'sonarr /api/v3/episodefile?seriesId=12': officeFiles,
    'sonarr /api/v3/episodefile?seriesId=13': seinfeldFiles,
    'sonarr /api/v3/episode': officeEpisodes,
    'sonarr /api/v3/history/series': [
      sonarrImport(101, officeEpisodes[0], 2),
      sonarrImport(102, officeEpisodes[1], 2),
      { eventType: 'grabbed', seriesId: 12, downloadId: 'PACK1', sourceTitle: 'The.Office.S01.1080p.BluRay.x265' },
    ],
    'seerr /api/v1/request': { results: [{ id: 5, type: 'movie', media: { tmdbId: 840 } }] },
    'jellyfin /Items': {
      Items: [
        { Id: 'a'.repeat(32), ServerId: 'serv1', Type: 'Movie', Path: 'F:\\Movies\\_inbox\\Metropolis (1927)\\Metropolis (1927).mkv', ProviderIds: { Tmdb: '1' } },
        { Id: 'b'.repeat(32), ServerId: 'serv1', Type: 'Series', Path: 'F:\\Series\\Otra carpeta', ProviderIds: { Tvdb: '73244' } },
      ],
    },
    'bazarr /api/movies': bazarrDown ? 500 : { data: [{ radarrId: 7, subtitles: [{ name: 'Spanish', code3: 'spa', path: 'F:\\x.es.srt', forced: false, hi: false }, { name: 'English', code3: 'eng', path: null, forced: false }], missing_subtitles: [] }] },
    'bazarr /api/episodes': {
      data: [
        { sonarrEpisodeId: 1001, subtitles: [{ name: 'English', code3: 'eng', path: 'a.srt' }], missing_subtitles: [{ name: 'Spanish', code3: 'spa' }] },
        { sonarrEpisodeId: 1002, subtitles: [{ name: 'English', code3: 'eng', path: 'b.srt' }, { name: 'Spanish', code3: 'spa', path: 'b.es.srt' }], missing_subtitles: [] },
        { sonarrEpisodeId: 1003, subtitles: [{ name: 'French', code3: 'fre', path: 'c.srt' }], missing_subtitles: [] },
      ],
    },
  };
}

/** Programas simulados: responde por host y ruta (con o sin query) y anota cada llamada con sus cabeceras. */
function fakePrograms(table) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const { host, pathname, search } = new URL(url);
    calls.push({ method, host, path: pathname + search, headers: options.headers ?? {} });
    const reply = table[`${host} ${pathname}${search}`] ?? table[`${host} ${pathname}`];
    if (reply === undefined) return new Response('', { status: 404 });
    if (typeof reply === 'number') return new Response('', { status: reply });
    return Response.json(reply);
  };
  return { fetchImpl, calls, gets: (host) => calls.filter((call) => call.host === host).length };
}

const makeLibrary = (programs, options = {}) =>
  createLibrary(config, { fetchImpl: programs.fetchImpl, now: () => NOW, jellyfinKeyFile, ...options });

describe('Library: lectura', () => {
  test('Recientes: lo importado en los últimos 30 días que sigue en el disco, lo más nuevo arriba', async () => {
    const programs = fakePrograms(routes());
    const [status, body] = await makeLibrary(programs).list();
    assert.equal(status, 200);
    assert.deepEqual(body.errors, []);
    assert.equal(body.recentDays, 30);
    // La película de hace 3 días, una tarjeta por cada día de capítulos de The Office, y nada más.
    assert.deepEqual(body.recent.map((entry) => `${entry.kind}-${entry.id}`), ['tv-12', 'movie-7', 'tv-12']);
    const [twoEpisodes, movie, oneEpisode] = body.recent;
    assert.equal(twoEpisodes.episodes, 2);
    assert.deepEqual(twoEpisodes.fileIds, [101, 102]);
    assert.deepEqual(twoEpisodes.episodeList.map((episode) => episode.title), ['Pilot', 'Diversity Day']);
    assert.equal(twoEpisodes.sizeBytes, 2e9);
    assert.deepEqual(oneEpisode.fileIds, [103]);
    assert.deepEqual(oneEpisode.seasons, [2]);
    assert.notEqual(twoEpisodes.key, oneEpisode.key);
    assert.equal(movie.arrivedAt, new Date(daysAgo(3)).toISOString());
    assert.equal(movie.quality, 'Bluray-1080p');
    assert.deepEqual(movie.languages, ['Spanish']);
    assert.equal(movie.posterPath, '/poster840.jpg');
    // El archivo reemplazado (69) y lo de hace 40 días no aparecen.
    assert.equal(body.recent.filter((entry) => entry.kind === 'movie').length, 1);
  });

  test('origen y papelera: Seerr, Telegram o sin pedido, con la misma regla que el borrado', async () => {
    const [, body] = await makeLibrary(fakePrograms(routes())).list();
    const byKey = Object.fromEntries(body.items.map((item) => [item.key, item]));
    assert.deepEqual(Object.keys(byKey).sort(), ['movie-7', 'movie-8', 'movie-9', 'tv-12', 'tv-13']); // Sin archivo, no está.
    assert.deepEqual([byKey['movie-7'].origin, byKey['movie-7'].deletable, byKey['movie-7'].deleteId], ['seerr', true, 'cola-movie-840']);
    assert.deepEqual([byKey['movie-8'].origin, byKey['movie-8'].deletable, byKey['movie-8'].deleteId], ['telegram', true, 'cola-movie-841']);
    assert.deepEqual([byKey['movie-9'].origin, byKey['movie-9'].deletable, byKey['movie-9'].deleteId], ['none', false, null]);
    assert.deepEqual([byKey['tv-12'].origin, byKey['tv-12'].deletable, byKey['tv-12'].deleteId], ['telegram', true, 'cola-tv-2316']);
    assert.deepEqual([byKey['tv-13'].origin, byKey['tv-13'].deletable], ['none', false]);
    // Ordenada por fecha de llegada.
    assert.deepEqual(body.items.map((item) => item.key), ['tv-12', 'movie-7', 'movie-8', 'movie-9', 'tv-13']);
    assert.equal(byKey['tv-12'].episodes, 3);
    assert.deepEqual(byKey['tv-12'].seasons, [1, 2]);
  });

  test('Jellyfin: por carpeta o por proveedor; nunca sale una clave', async () => {
    const programs = fakePrograms(routes());
    const [, body] = await makeLibrary(programs).list();
    const byKey = Object.fromEntries(body.items.map((item) => [item.key, item]));
    assert.equal(byKey['movie-7'].jellyfinId, 'a'.repeat(32)); // Por carpeta, aunque el Tmdb no coincida.
    assert.equal(byKey['tv-12'].jellyfinId, 'b'.repeat(32)); // Por TVDB.
    assert.equal(byKey['movie-9'].jellyfinId, null);
    assert.deepEqual(body.jellyfin, { serverId: 'serv1' });
    const jellyfinCall = programs.calls.find((call) => call.host === 'jellyfin');
    assert.equal(jellyfinCall.headers.Authorization, `MediaBrowser Token="${JF_KEY}"`);
    assert.doesNotMatch(JSON.stringify(body), /clave-|fffffffff/);
    // Recientes de Radarr: solo desde hace 30 días.
    const since = programs.calls.find((call) => call.host === 'radarr' && call.path.startsWith('/api/v3/history/since'));
    assert.match(decodeURIComponent(since.path), new RegExp(`date=${new Date(NOW - 30 * 86400000).toISOString()}`));
  });

  test('sin clave de Jellyfin no lo consulta, y el resto se ve igual', async () => {
    const programs = fakePrograms(routes());
    const [, body] = await makeLibrary(programs, { jellyfinKeyFile: path.join(tmp, 'no-existe.key') }).list();
    assert.equal(programs.gets('jellyfin'), 0);
    assert.equal(body.jellyfin, null);
    assert.ok(body.items.every((item) => item.jellyfinId === null));
    assert.equal(body.items.length, 5);
  });

  test('si Radarr o Seerr fallan, se avisa y lo demás se muestra', async () => {
    const table = routes({ radarrDown: true });
    table['seerr /api/v1/request'] = 500;
    const [, body] = await makeLibrary(fakePrograms(table)).list();
    assert.deepEqual(body.errors.map((error) => error.source), ['radarr', 'seerr']);
    assert.match(body.errors[1].message, /Seerr puede figurar como Telegram/);
    assert.deepEqual(body.items.map((item) => item.key), ['tv-12', 'tv-13']);
  });

  test('la foto dura 5 minutos; "actualizar" la rehace solo si tiene más de 30 s, y borrar la descarta', async () => {
    let clock = NOW;
    const programs = fakePrograms(routes());
    const lib = makeLibrary(programs, { now: () => clock });
    await Promise.all([lib.list(), lib.list()]);
    assert.equal(programs.gets('radarr'), 2); // /movie y el historial, una sola vez.
    clock += 20_000;
    await lib.list({ refresh: true });
    assert.equal(programs.gets('radarr'), 2);
    clock += 20_000;
    await lib.list();
    assert.equal(programs.gets('radarr'), 2);
    await lib.list({ refresh: true });
    assert.equal(programs.gets('radarr'), 4);
    clock += 4 * 60_000;
    await lib.list();
    assert.equal(programs.gets('radarr'), 4);
    clock += 61_000;
    await lib.list();
    assert.equal(programs.gets('radarr'), 6);
    lib.invalidate();
    await lib.list();
    assert.equal(programs.gets('radarr'), 8);
  });
});

describe('Library: detalles', () => {
  test('película: torrent, carpeta, archivo, audio y subtítulos de Bazarr', async () => {
    const programs = fakePrograms(routes());
    const [status, body] = await makeLibrary(programs).details('movie', 7);
    assert.equal(status, 200);
    assert.deepEqual(body.torrents, ['Metropolis.1927.Restored.1080p.BluRay-GRP']);
    assert.equal(body.folder, 'F:\\Movies\\_inbox\\Metropolis (1927)');
    assert.equal(body.files[0].name, 'Metropolis (1927).mkv');
    assert.deepEqual(body.files[0].audio, ['spa', 'eng']);
    assert.deepEqual(body.files[0].embeddedSubtitles, ['spa']);
    assert.equal(body.subtitles.ok, true);
    assert.deepEqual(body.subtitles.languages.map((language) => [language.code, language.external]), [['spa', true], ['eng', false]]);
    const bazarrCall = programs.calls.find((call) => call.host === 'bazarr');
    assert.equal(bazarrCall.headers['X-API-KEY'], 'clave-bazarr');
    assert.doesNotMatch(JSON.stringify(body), /clave-/);
  });

  test('si Bazarr no responde, lo dice y el resto del panel se ve', async () => {
    const [status, body] = await makeLibrary(fakePrograms(routes({ bazarrDown: true }))).details('movie', 7);
    assert.equal(status, 200);
    assert.equal(body.subtitles.ok, false);
    assert.match(body.subtitles.error, /Bazarr no respondió/);
    assert.equal(body.files.length, 1);
  });

  test('serie: solo los episodios de la tarjeta, con sus subtítulos sumados', async () => {
    const [status, body] = await makeLibrary(fakePrograms(routes())).details('tv', 12, { files: [101, 102] });
    assert.equal(status, 200);
    assert.equal(body.totalFiles, 2);
    assert.deepEqual(body.files.map((file) => file.episodes[0].title), ['Pilot', 'Diversity Day']);
    assert.deepEqual(body.torrents, ['The.Office.S01.1080p.BluRay.x265']);
    assert.equal(body.sizeBytes, 2e9);
    assert.equal(body.subtitles.of, 2);
    assert.deepEqual(body.subtitles.languages.map((language) => [language.code, language.count]), [['eng', 2], ['spa', 1]]);
    assert.deepEqual(body.subtitles.missing.map((language) => [language.code, language.count]), [['spa', 1]]);
  });

  test('lo que ya no está responde 404', async () => {
    const lib = makeLibrary(fakePrograms(routes()));
    assert.equal((await lib.details('movie', 99))[0], 404);
    assert.equal((await lib.details('tv', 12, { files: [999] }))[0], 404);
  });
});

describe('Library: borrar sigue con la regla de siempre', () => {
  const removerFor = (programs) =>
    createRequestRemover(config, {
      fetchImpl: programs.fetchImpl,
      sleep: async () => {},
      mailboxConfigFile: path.join(tmp, 'sin-buzon.json'),
      jellyfinKeyFile: path.join(tmp, 'sin-clave-jellyfin'),
    });

  test('lo que la Library ofrece borrar es un pedido para el borrado; lo viejo se rechaza aunque se pida', async () => {
    const table = routes();
    table['seerr /api/v1/request?take=100&skip=0&filter=all&sort=added'] = { results: [{ id: 5, type: 'movie', media: { tmdbId: 840 } }] };
    const programs = fakePrograms(table);
    const [, body] = await makeLibrary(programs).list();
    const remover = removerFor(programs);
    const requestedItem = body.items.find((item) => item.key === 'movie-7');
    const [status, plan] = await remover.plan(requestedItem.deleteId);
    assert.equal(status, 200, JSON.stringify(plan));
    assert.deepEqual(plan.plan.files, [requested.movieFile.path]);
    // La biblioteca vieja: la Library no da un id, y armándolo a mano el borrado lo rechaza sin tocar nada.
    assert.equal(body.items.find((item) => item.key === 'movie-9').deleteId, null);
    for (const id of ['cola-movie-842', 'radarr-9']) {
      const [rejected, verdict] = await remover.plan(id);
      assert.equal(rejected, 409, id);
      assert.match(verdict.error, /biblioteca|no figura/);
    }
    assert.equal(programs.calls.filter((call) => call.method !== 'GET').length, 0);
  });
});

describe('Library: rutas HTTP', () => {
  test('GET de la foto y de los detalles; nada más se acepta, y borrar descarta la foto', async () => {
    const asked = [];
    let invalidated = 0;
    const library = {
      list: async (options) => (asked.push(['list', options.refresh]), [200, { items: [], recent: [] }]),
      details: async (kind, id, options) => (asked.push(['details', kind, id, options.files]), [200, { ok: true }]),
      invalidate: () => (invalidated += 1),
    };
    const auth = createAuth({ file: path.join(tmp, 'auth.json') });
    auth.setPassword({ user: 'admin', password: 'contraseña-buena' });
    const requests = { plan: async () => [200, {}], remove: async () => [200, { ok: true, results: [] }] };
    const server = createApp(async () => ({}), { allowedOrigins: ['app://lp-media-center'], auth, library, requests });
    const { port } = await listen(server, '127.0.0.1', 0);
    const get = (pathname, options) => fetch(`http://127.0.0.1:${port}${pathname}`, options);
    try {
      assert.equal((await get('/api/library')).status, 200);
      assert.equal((await get('/api/library?refresh=1')).status, 200);
      assert.equal((await get('/api/library/movie/7')).status, 200);
      assert.equal((await get('/api/library/tv/12?files=101,102')).status, 200);
      assert.deepEqual(asked, [['list', false], ['list', true], ['details', 'movie', 7, []], ['details', 'tv', 12, [101, 102]]]);
      assert.equal((await get('/api/library/tv/12?files=1,x')).status, 400);
      assert.equal((await get('/api/library/otra/1')).status, 404);
      assert.equal((await get('/api/library/movie/7x')).status, 404);
      assert.equal((await get('/api/library', { method: 'POST' })).status, 405);
      assert.equal(asked.length, 4);
      assert.equal(invalidated, 0);
      const removed = await get('/api/requests/cola-movie-840/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'app://lp-media-center' },
        body: JSON.stringify({ token: 'x' }),
      });
      assert.equal(removed.status, 200);
      assert.equal(invalidated, 1);
    } finally {
      server.close();
    }
  });
});

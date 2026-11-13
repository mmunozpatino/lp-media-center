import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_CONFIG,
  createApp,
  createAuth,
  createCollector,
  createDownloadControl,
  createController,
  isTailscaleAddress,
  listen,
  normalizeRadarrQueue,
  normalizeSonarrQueue,
  pickLanIp,
  readBazarrApiKey,
  waitingInArrs,
  withoutDownloading,
} from '../backend/server.js';

const KEYS = {
  radarr: 'RADARRSECRETKEY0000',
  sonarr: 'SONARRSECRETKEY0000',
  prowlarr: 'PROWLARRSECRETKEY00',
  bazarr: 'BAZARRSECRETKEY0000',
  seerr: 'SEERRSECRETKEY00000',
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lpmc-test-'));
const servers = [];

function write(name, content) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content);
  return file;
}

/** Levanta un programa falso. `routes` mapea ruta -> fn(req) => { status, json, text } */
async function fakeService(routes, requiredKey) {
  const server = http.createServer(async (req, res) => {
    const route = routes[req.url] ?? routes[req.url.split('?')[0]];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const sentKey = req.headers['x-api-key'];
    if (route.auth !== false && requiredKey && sentKey !== requiredKey) {
      res.writeHead(401).end();
      return;
    }
    route.seen?.push(req.url);
    if (route.delayMs) await new Promise((resolve) => setTimeout(resolve, route.delayMs));
    res.writeHead(route.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(route.text ?? JSON.stringify(route.json ?? {}));
  });
  await listen(server, '127.0.0.1', 0);
  servers.push(server);
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

const NODE_LIST = JSON.stringify([
  { CommandLine: 'node C:\\otro\\server.js' },
  { CommandLine: `"C:\\Program Files\\nodejs\\node.exe" C:\\Develop\\pelis-bot\\agent.js --token ${KEYS.seerr}` },
]);
const DISK_LIST = JSON.stringify([
  { DeviceID: 'C:', VolumeName: '', Size: 1000, FreeSpace: 500 },
  { DeviceID: 'E:', VolumeName: 'Lleno', Size: 1000, FreeSpace: 20 },
]);
const TAILSCALE = JSON.stringify({
  Version: '1.90.0-abc',
  BackendState: 'Running',
  TailscaleIPs: ['100.1.2.3', 'fd7a::1'],
  Peer: { a: { Online: true }, b: { Online: false } },
});

function fakeRun({ nodes = NODE_LIST, diskList = DISK_LIST, tailscale = TAILSCALE, failTailscale = false } = {}) {
  return async (file, args) => {
    if (file.endsWith('tailscale.exe')) {
      if (failTailscale) throw new Error('no está');
      return tailscale;
    }
    return args.join(' ').includes('Win32_LogicalDisk') ? diskList : nodes;
  };
}

function arrRoutes(apiVersion, { health = [], queue } = {}) {
  const routes = {
    [`/api/${apiVersion}/system/status`]: { json: { version: '1.2.3' } },
    [`/api/${apiVersion}/health`]: { json: health },
  };
  if (queue) routes[`/api/${apiVersion}/queue`] = { json: queue };
  return routes;
}

const emptyQueue = { totalRecords: 0, records: [] };

/** Arma una configuración apuntada a programas falsos que funcionan; `overrides` reemplaza servicios. */
async function buildConfig(overrides = {}) {
  const build = async (id, routes, key) => {
    if (overrides[id]) return overrides[id];
    const service = await fakeService(routes, key);
    return { url: service.url, port: service.port };
  };
  const services = {
    radarr: {
      ...(await build('radarr', arrRoutes('v3', { queue: emptyQueue }), KEYS.radarr)),
      keyFile: overrides.radarrKeyFile ?? write('radarr.xml', `<Config><ApiKey>${KEYS.radarr}</ApiKey></Config>`),
    },
    sonarr: {
      ...(await build('sonarr', arrRoutes('v3', { queue: emptyQueue }), KEYS.sonarr)),
      keyFile: write('sonarr.xml', `<Config><ApiKey>${KEYS.sonarr}</ApiKey></Config>`),
    },
    prowlarr: {
      ...(await build('prowlarr', arrRoutes('v1'), KEYS.prowlarr)),
      keyFile: write('prowlarr.xml', `<Config><ApiKey>${KEYS.prowlarr}</ApiKey></Config>`),
    },
    bazarr: {
      ...(await build(
        'bazarr',
        {
          '/api/system/status': { json: { data: { bazarr_version: '1.6.2' } } },
          '/api/system/health': { json: { data: [] } },
          '/api/providers': { json: { data: [{ name: 'yify', status: 'Good', retry: '-' }] } },
        },
        KEYS.bazarr,
      )),
      keyFile: write('bazarr.yaml', `general:\n  apikey: otra\nauth:\n  type: null\n  apikey: ${KEYS.bazarr}\n`),
    },
    qbittorrent: await build('qbittorrent', { '/api/v2/app/version': { status: 403, text: 'Forbidden' } }),
    jellyfin: await build('jellyfin', {
      '/System/Info/Public': { json: { Version: '10.11.6', ServerName: 'SERVIDOR', Id: 'id-secreto' } },
    }),
    seerr: {
      ...(await build(
        'seerr',
        {
          '/api/v1/status': { auth: false, json: { version: '3.5.1' } },
          '/api/v1/request/count': { json: { pending: 2, processing: 1 } },
        },
        KEYS.seerr,
      )),
      keyFile: write('seerr.json', JSON.stringify({ main: { apiKey: KEYS.seerr } })),
    },
  };
  return { ...DEFAULT_CONFIG, services, httpTimeoutMs: 400, pauseFile: path.join(tmp, 'pausa-sin-usar.json') };
}

const partOf = (status, id) => status.parts.find((part) => part.id === id);
const deadService = { url: 'http://127.0.0.1:1', port: 1 };

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('estado de cada parte', () => {
  it('informa todo bien cuando todo funciona', async () => {
    const collect = createCollector(await buildConfig(), { run: fakeRun(), lanIp: async () => '192.168.1.50' });
    const status = await collect();
    assert.deepEqual(
      status.parts.map((part) => [part.id, part.state]),
      [
        ['radarr', 'ok'],
        ['sonarr', 'ok'],
        ['prowlarr', 'ok'],
        ['bazarr', 'ok'],
        ['qbittorrent', 'ok'],
        ['jellyfin', 'ok'],
        ['seerr', 'ok'],
        ['bot', 'ok'],
        ['tailscale', 'ok'],
      ],
    );
    assert.equal(partOf(status, 'radarr').version, '1.2.3');
    assert.equal(partOf(status, 'bazarr').version, '1.6.2');
    assert.equal(partOf(status, 'jellyfin').version, '10.11.6');
    assert.match(partOf(status, 'seerr').detail, /2 por aprobar, 1 en proceso/);
    assert.match(partOf(status, 'tailscale').detail, /1 de 2/);
    assert.deepEqual(status.network, { lanIp: '192.168.1.50', tailscaleIp: '100.1.2.3' });
  });

  it('nunca incluye claves, IDs ni líneas de comando en la respuesta', async () => {
    const collect = createCollector(await buildConfig(), { run: fakeRun(), lanIp: async () => null });
    const body = JSON.stringify(await collect());
    for (const key of Object.values(KEYS)) assert.ok(!body.includes(key), 'se filtró una clave');
    assert.ok(!body.includes('id-secreto'));
    assert.ok(!body.includes('agent.js'));
    assert.ok(!body.includes('ip":"100'), 'la IP de Tailscale queda solo en network');
  });

  it('si un programa no responde, informa esa parte y el resto sigue', async () => {
    const config = await buildConfig({ jellyfin: deadService, radarr: deadService });
    const collect = createCollector(config, { run: fakeRun(), lanIp: async () => null });
    const status = await collect();
    assert.equal(partOf(status, 'jellyfin').state, 'down');
    assert.equal(partOf(status, 'radarr').state, 'down');
    assert.equal(partOf(status, 'sonarr').state, 'ok');
    assert.equal(partOf(status, 'qbittorrent').state, 'ok');
    assert.deepEqual(status.downloads.errors.map((error) => error.source), ['radarr']);
  });

  it('un programa colgado se corta por timeout sin frenar a los demás', async () => {
    const slow = await fakeService({ '/System/Info/Public': { delayMs: 3000, json: {} } });
    const config = await buildConfig({ jellyfin: { url: slow.url, port: slow.port } });
    const collect = createCollector(config, { run: fakeRun(), lanIp: async () => null });
    const started = Date.now();
    const status = await collect();
    assert.equal(partOf(status, 'jellyfin').state, 'down');
    assert.equal(partOf(status, 'sonarr').state, 'ok');
    assert.ok(Date.now() - started < 2000);
  });

  it('una clave ausente o rechazada es error, no caída', async () => {
    const config = await buildConfig({ radarrKeyFile: path.join(tmp, 'no-existe.xml') });
    config.services.sonarr.keyFile = write('mala.xml', '<Config><ApiKey>MALA</ApiKey></Config>');
    const collect = createCollector(config, { run: fakeRun(), lanIp: async () => null });
    const status = await collect();
    assert.equal(partOf(status, 'radarr').state, 'error');
    assert.match(partOf(status, 'radarr').detail, /configuración/);
    assert.equal(partOf(status, 'sonarr').state, 'error');
    assert.match(partOf(status, 'sonarr').detail, /clave/);
  });

  it('los avisos de salud ponen la parte en advertencia; las notas no', async () => {
    const warned = await fakeService(
      arrRoutes('v3', { health: [{ type: 'warning', message: 'Sin espacio' }], queue: emptyQueue }),
      KEYS.radarr,
    );
    const noted = await fakeService(
      arrRoutes('v3', { health: [{ type: 'notice', message: 'Nota' }], queue: emptyQueue }),
      KEYS.sonarr,
    );
    const config = await buildConfig({
      radarr: { url: warned.url, port: warned.port },
      sonarr: { url: noted.url, port: noted.port },
    });
    const status = await createCollector(config, { run: fakeRun(), lanIp: async () => null })();
    assert.equal(partOf(status, 'radarr').state, 'warning');
    assert.equal(partOf(status, 'radarr').issues[0].message, 'Sin espacio');
    assert.equal(partOf(status, 'sonarr').state, 'ok');
    assert.equal(partOf(status, 'sonarr').issues.length, 1);
  });

  it('un proveedor de subtítulos limitado pone a Bazarr en advertencia', async () => {
    const bazarr = await fakeService(
      {
        '/api/system/status': { json: { data: { bazarr_version: '1.6.2' } } },
        '/api/system/health': { json: { data: [] } },
        '/api/providers': {
          json: { data: [{ name: 'opensubtitlescom', status: 'DownloadLimitExceeded', retry: 'in 6 hours' }] },
        },
      },
      KEYS.bazarr,
    );
    const config = await buildConfig({ bazarr: { url: bazarr.url, port: bazarr.port } });
    const status = await createCollector(config, { run: fakeRun(), lanIp: async () => null })();
    assert.equal(partOf(status, 'bazarr').state, 'warning');
    assert.match(partOf(status, 'bazarr').issues[0].message, /opensubtitlescom.*in 6 hours/);
  });

  it('qBittorrent: 403 es vivo, 200 trae versión y 500 es error', async () => {
    const version = await fakeService({ '/api/v2/app/version': { text: 'v5.1.0' } });
    const broken = await fakeService({ '/api/v2/app/version': { status: 500 } });
    const statusWith = async (service) => {
      const config = await buildConfig({ qbittorrent: { url: service.url, port: service.port } });
      return partOf(await createCollector(config, { run: fakeRun(), lanIp: async () => null })(), 'qbittorrent');
    };
    assert.equal((await statusWith(version)).version, 'v5.1.0');
    assert.equal((await statusWith(broken)).state, 'error');
  });

  it('Seerr sigue vivo aunque no se puedan leer los pedidos', async () => {
    const config = await buildConfig();
    config.services.seerr.keyFile = path.join(tmp, 'no-existe.json');
    const status = await createCollector(config, { run: fakeRun(), lanIp: async () => null })();
    assert.equal(partOf(status, 'seerr').state, 'warning');
    assert.equal(partOf(status, 'seerr').version, '3.5.1');
  });

  it('el bot se detecta por agent.js y su ausencia es caída', async () => {
    const config = await buildConfig();
    const without = JSON.stringify({ CommandLine: 'node C:\\x\\my-agent.js.bak' });
    const status = await createCollector(config, { run: fakeRun({ nodes: without }), lanIp: async () => null })();
    assert.equal(partOf(status, 'bot').state, 'down');
    const empty = await createCollector(config, { run: fakeRun({ nodes: '' }), lanIp: async () => null })();
    assert.equal(partOf(empty, 'bot').state, 'down');
  });

  it('Tailscale detenido o ausente se informa sin romper el resto', async () => {
    const config = await buildConfig();
    const stopped = JSON.stringify({ BackendState: 'Stopped', TailscaleIPs: [] });
    let status = await createCollector(config, { run: fakeRun({ tailscale: stopped }), lanIp: async () => null })();
    assert.equal(partOf(status, 'tailscale').state, 'down');
    assert.equal(partOf(status, 'tailscale').stateText, 'Desconectado');
    assert.equal(status.network.tailscaleIp, null);
    status = await createCollector(config, { run: fakeRun({ failTailscale: true }), lanIp: async () => null })();
    assert.equal(partOf(status, 'tailscale').state, 'down');
    assert.equal(partOf(status, 'radarr').state, 'ok');
  });

  it('un comando que falla deja sin datos solo a esa parte', async () => {
    const config = await buildConfig();
    const run = async (file) => {
      if (file === 'powershell.exe') throw new Error('falló');
      return TAILSCALE;
    };
    const status = await createCollector(config, { run, lanIp: async () => null })();
    assert.equal(partOf(status, 'bot').state, 'error');
    assert.equal(status.disks.state, 'error');
    assert.deepEqual(status.disks.items, []);
    assert.equal(partOf(status, 'tailscale').state, 'ok');
  });
});

describe('discos', () => {
  it('marca los discos con poco espacio y acepta un solo disco', async () => {
    const config = await buildConfig();
    let status = await createCollector(config, { run: fakeRun(), lanIp: async () => null })();
    assert.equal(status.disks.state, 'warning');
    assert.deepEqual(status.disks.items.map((disk) => [disk.id, disk.low]), [['C:', false], ['E:', true]]);

    const one = JSON.stringify({ DeviceID: 'C:', VolumeName: 'Único', Size: 1000, FreeSpace: 900 });
    status = await createCollector(config, { run: fakeRun({ diskList: one }), lanIp: async () => null })();
    assert.equal(status.disks.state, 'ok');
    assert.equal(status.disks.items[0].label, 'Único');
  });
});

describe('colas', () => {
  it('normaliza Radarr', () => {
    const [item] = normalizeRadarrQueue([
      {
        id: 7,
        title: 'Peli.2026.1080p',
        size: 1000,
        sizeleft: 250,
        timeleft: '00:10:00',
        status: 'downloading',
        trackedDownloadState: 'downloading',
        trackedDownloadStatus: 'ok',
        movie: { title: 'Peli', year: 2026 },
        quality: { quality: { name: 'Bluray-1080p' } },
        outputPath: 'D:\\Media\\Descargas\\Peli',
        statusMessages: [],
      },
    ]);
    assert.equal(item.id, 'radarr-7');
    assert.equal(item.title, 'Peli');
    assert.equal(item.subtitle, '2026');
    assert.equal(item.progress, 0.75);
    assert.equal(item.quality, 'Bluray-1080p');
    assert.ok(!JSON.stringify(item).includes('Descargas'), 'no se expone la ruta');
  });

  it('agrupa un pack de temporada de Sonarr y deja suelto un episodio', () => {
    const shared = { downloadId: 'pack', size: 100, sizeleft: 50, series: { title: 'Serie' }, status: 'downloading' };
    const items = normalizeSonarrQueue([
      { ...shared, id: 1, episode: { seasonNumber: 1, episodeNumber: 1 } },
      { ...shared, id: 2, episode: { seasonNumber: 1, episodeNumber: 2 } },
      {
        id: 3,
        downloadId: 'solo',
        size: 10,
        sizeleft: 10,
        series: { title: 'Otra' },
        episode: { seasonNumber: 2, episodeNumber: 5, title: 'Piloto' },
      },
    ]);
    assert.equal(items.length, 2);
    assert.equal(items[0].subtitle, 'Temporada 1 · 2 episodios');
    assert.equal(items[1].subtitle, 'T02E05 · Piloto');
    assert.equal(items[1].progress, 0);
  });

  it('junta mensajes de error y tolera campos ausentes', () => {
    const [item] = normalizeRadarrQueue([
      {
        id: 9,
        errorMessage: 'Falló',
        statusMessages: [{ title: 'x', messages: ['Sin archivos', 'Falló'] }, { title: 'Solo título', messages: [] }],
      },
    ]);
    assert.deepEqual(item.problems, ['Falló', 'Sin archivos', 'Solo título']);
    assert.equal(item.title, 'Sin título');
    assert.equal(item.progress, null);
  });

  it('avisa si la cola tiene más de lo que se pidió', async () => {
    const big = await fakeService(
      arrRoutes('v3', { queue: { totalRecords: 500, records: [{ id: 1, title: 'x' }] } }),
      KEYS.radarr,
    );
    const config = await buildConfig({ radarr: { url: big.url, port: big.port } });
    const status = await createCollector(config, { run: fakeRun(), lanIp: async () => null })();
    assert.equal(status.downloads.truncated, true);
    assert.equal(status.downloads.items.length, 1);
  });
});

describe('claves e IP de LAN', () => {
  it('lee la clave de Bazarr solo dentro de auth, con y sin comillas ni CRLF', async () => {
    const file = write('b1.yaml', "general:\n  apikey: general\nauth:\r\n  password: ''\r\n  apikey: 'de-auth'\r\nbackup:\n  x: 1\n");
    assert.equal(await readBazarrApiKey(file), 'de-auth');
    const none = write('b2.yaml', 'auth:\n  type: null\nsonarr:\n  apikey: otra\n');
    await assert.rejects(readBazarrApiKey(none), /no tiene clave/);
  });

  const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });
  const interfaces = {
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    Tailscale: [v4('100.101.102.103')],
    'vEthernet (WSL)': [v4('172.20.0.1')],
    Ethernet: [{ family: 'IPv6', address: 'fe80::1', internal: false }, v4('192.168.1.20')],
    'Wi-Fi': [v4('10.0.0.5')],
  };

  it('elige la IP de la ruta por defecto entre las reales', () => {
    assert.equal(pickLanIp(interfaces, '10.0.0.5'), '10.0.0.5');
  });

  it('ignora Tailscale y adaptadores virtuales aunque sean la ruta', () => {
    assert.equal(pickLanIp(interfaces, '100.101.102.103'), '192.168.1.20');
    assert.equal(pickLanIp(interfaces, '172.20.0.1'), '192.168.1.20');
    assert.equal(pickLanIp(interfaces, null), '192.168.1.20');
  });

  it('devuelve null sin red local', () => {
    assert.equal(pickLanIp({ Tailscale: [v4('100.101.102.103')] }, null), null);
  });
});

describe('servidor HTTP', () => {
  const ORIGIN = 'app://lp-media-center';
  let server;
  let base;
  let calls = 0;

  before(async () => {
    server = createApp(
      async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true };
      },
      { allowedOrigins: [ORIGIN] },
    );
    const address = await listen(server, '127.0.0.1', 0);
    base = `http://127.0.0.1:${address.port}`;
    servers.push(server);
  });

  /** fetch no deja fijar Host u Origin de forma confiable: se usa http.request. */
  const request = (pathname, { method = 'GET', headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('escucha solo en 127.0.0.1', () => {
    assert.equal(server.address().address, '127.0.0.1');
  });

  it('entrega el estado sin CORS a quien no manda Origin', async () => {
    const response = await request('/api/status');
    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  it('solo permite leer al origen de la app', async () => {
    const allowed = await request('/api/status', { headers: { Origin: ORIGIN } });
    assert.equal(allowed.headers['access-control-allow-origin'], ORIGIN);
    for (const origin of ['https://evil.example', 'null', 'http://localhost:3000']) {
      const denied = await request('/api/status', { headers: { Origin: origin } });
      assert.equal(denied.status, 403, origin);
      assert.equal(denied.headers['access-control-allow-origin'], undefined);
    }
  });

  it('rechaza un Host ajeno (DNS rebinding)', async () => {
    const response = await request('/api/status', { headers: { Host: 'evil.example:8787' } });
    assert.equal(response.status, 403);
  });

  it('es de solo lectura y no expone otras rutas', async () => {
    assert.equal((await request('/api/status', { method: 'POST' })).status, 405);
    assert.equal((await request('/api/otra')).status, 404);
  });

  it('dos pedidos simultáneos comparten una sola consulta', async () => {
    calls = 0;
    await Promise.all([request('/api/status'), request('/api/status')]);
    assert.equal(calls, 1);
  });

  it('un fallo interno responde 500 sin detalles', async () => {
    const failing = createApp(
      async () => {
        throw new Error('detalle-interno');
      },
      { allowedOrigins: [] },
    );
    const { port } = await listen(failing, '127.0.0.1', 0);
    servers.push(failing);
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('detalle-interno'));
  });
});

describe('frenar y levantar', () => {
  const failing = (code) => Object.assign(new Error('falló'), { code });
  const ids = ['radarr', 'sonarr', 'prowlarr', 'bazarr', 'qbittorrent', 'jellyfin', 'seerr', 'bot'];

  /** Simula el comando y lo que responde el programa: arranca vivo y cae al frenarlo. */
  function recorder({ alive = true, error = null, changes = true } = {}) {
    const state = { alive, calls: [] };
    state.run = async (file, args) => {
      state.calls.push([file, ...args]);
      if (file === 'sc.exe' || file === 'explorer.exe' || args.join(' ').match(/Start-ScheduledTask|Stop-Process/)) {
        if (error) throw error;
        if (changes) state.alive = file === 'explorer.exe' || args[0] === 'start' || args.join(' ').includes('Start-ScheduledTask');
        return '';
      }
      if (file.endsWith('tailscale.exe')) return TAILSCALE;
      if (args.join(' ').includes('Win32_LogicalDisk')) return DISK_LIST;
      return state.alive ? NODE_LIST : '';
    };
    return state;
  }

  const options = (state) => ({ run: state.run, waitMs: 60, pollMs: 5 });

  it('frena un servicio de Windows y comprueba que no responda', async () => {
    const service = await fakeService(arrRoutes('v3'), KEYS.radarr);
    const config = await buildConfig({ radarr: { url: service.url, port: service.port } });
    const state = recorder();
    const act = createController(config, options(state));
    const closing = new Promise((resolve) => service.server.close(resolve));
    service.server.closeAllConnections();
    await closing;
    const result = await act('radarr', 'stop');
    assert.deepEqual(state.calls[0], ['sc.exe', 'stop', 'Radarr']);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'down');
    assert.match(result.message, /Radarr quedó frenado/);
  });

  it('frena y levanta el bot por su proceso y su tarea', async () => {
    const config = await buildConfig();
    const state = recorder();
    const act = createController(config, options(state));
    const stopped = await act('bot', 'stop');
    assert.equal(stopped.ok, true);
    // El bot vive en el repo media-bot; la ruta vieja de pelis-bot sigue valiendo, y ningún otro agent.js.
    assert.match(state.calls[0].at(-1), /-like '\*\\media-bot\\agent\\agent\.js\*' -or \$_\.CommandLine -like '\*\\pelis-bot\\agent\\agent\.js\*'/);
    assert.doesNotMatch(state.calls[0].at(-1), /-like '\*agent\.js\*'/);
    assert.match(state.calls[0].at(-1), /Stop-Process/);
    const started = await act('bot', 'start');
    assert.equal(started.ok, true);
    assert.ok(state.calls.some((call) => call.at(-1).includes("Start-ScheduledTask -TaskName 'Pelis Bot Agent'")));
  });

  it('levanta Seerr por su tarea y qBittorrent por Explorer', async () => {
    const config = await buildConfig();
    const state = recorder();
    const act = createController(config, options(state));
    await act('seerr', 'start');
    await act('qbittorrent', 'start');
    assert.ok(state.calls.some((call) => call.at(-1).includes("Start-ScheduledTask -TaskName 'Seerr'")));
    assert.ok(state.calls.some((call) => call[0] === 'explorer.exe' && call[1].endsWith('qbittorrent.exe')));
  });

  it('un servicio que ya estaba frenado o levantado no es un error', async () => {
    const config = await buildConfig();
    for (const code of [1056, 1062]) {
      const state = recorder({ error: failing(code) });
      const result = await createController(config, options(state))('radarr', 'start');
      assert.equal(result.ok, true);
    }
  });

  it('sin permiso de Windows, lo dice claro', async () => {
    const config = await buildConfig();
    const state = recorder({ error: failing(5) });
    const result = await createController(config, options(state))('bazarr', 'stop');
    assert.equal(result.ok, false);
    assert.match(result.message, /Bazarr: .*administrador/);
  });

  it('no dice que quedó hecho si el programa no cambió', async () => {
    const config = await buildConfig();
    const state = recorder({ changes: false });
    const result = await createController(config, options(state))('bot', 'stop');
    assert.equal(result.ok, false);
    assert.match(result.message, /sigue respondiendo/);
  });

  it('rechaza partes o acciones inventadas, sin ejecutar nada', async () => {
    const config = await buildConfig();
    const state = recorder();
    const act = createController(config, options(state));
    for (const [id, action] of [['nada', 'stop'], ['radarr', 'borrar'], ['__proto__', 'stop']]) {
      assert.equal((await act(id, action)).status, 404, `${id} ${action}`);
    }
    assert.equal(state.calls.length, 0);
  });

  it('no acepta dos acciones a la vez sobre el mismo programa', async () => {
    const config = await buildConfig();
    const state = recorder();
    const act = createController(config, options(state));
    const [first, second] = await Promise.all([act('bot', 'stop'), act('bot', 'stop')]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
  });

  it('cada parte dice si se puede controlar, y Tailscale queda fuera de lo general', async () => {
    const status = await createCollector(await buildConfig(), { run: fakeRun(), lanIp: async () => null })();
    for (const id of ids) {
      assert.ok(partOf(status, id).control?.stopWarning, id);
      assert.equal(partOf(status, id).control.bulk, true, id);
    }
    assert.equal(partOf(status, 'tailscale').control.bulk, false);
    assert.equal(partOf(status, 'tailscale').control.kind, 'connection');
  });

  describe('por HTTP', () => {
    const ORIGIN = 'app://lp-media-center';
    let base;
    const asked = [];

    before(async () => {
      const server = createApp(async () => ({}), {
        allowedOrigins: [ORIGIN],
        act: async (id, action) => {
          asked.push([id, action]);
          return { status: 200, ok: true, message: 'hecho' };
        },
      });
      const address = await listen(server, '127.0.0.1', 0);
      base = `127.0.0.1:${address.port}`;
      servers.push(server);
    });

    const post = (pathname, headers = {}, method = 'POST') =>
      new Promise((resolve, reject) => {
        const req = http.request(`http://${base}${pathname}`, { method, headers }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });

    it('ejecuta solo con POST y desde el origen de la app', async () => {
      asked.length = 0;
      assert.equal(await post('/api/parts/radarr/stop', { Origin: ORIGIN }), 200);
      assert.deepEqual(asked, [['radarr', 'stop']]);
      asked.length = 0;
      assert.equal(await post('/api/parts/radarr/stop'), 403, 'sin Origin');
      assert.equal(await post('/api/parts/radarr/stop', { Origin: 'https://evil.example' }), 403);
      assert.equal(await post('/api/parts/radarr/stop', { Origin: 'null' }), 403);
      assert.equal(await post('/api/parts/radarr/stop', { Origin: ORIGIN, Host: 'evil.example' }), 403);
      assert.equal(await post('/api/parts/radarr/stop', { Origin: ORIGIN }, 'GET'), 405);
      assert.equal(await post('/api/parts/radarr/borrar', { Origin: ORIGIN }), 404);
      assert.deepEqual(asked, []);
    });
  });
});

describe('pedidos pendientes', () => {
  const pending = (results, total = results.length) => ({
    '/api/v1/status': { auth: false, json: { version: '3.5.1' } },
    '/api/v1/request/count': { json: { pending: total, processing: 0 } },
    '/api/v1/request?filter=pending&sort=added&take=50': { json: { pageInfo: { results: total }, results } },
    '/api/v1/request': { json: { pageInfo: { results: 0 }, results: [] } },
    '/api/v1/movie/603': { json: { title: 'Matrix', releaseDate: '1999-03-31' } },
    '/api/v1/tv/2316': { json: { name: 'The Office', firstAirDate: '2005-03-24' } },
  });

  async function statusWith(routes) {
    const seerr = await fakeService(routes, KEYS.seerr);
    const config = await buildConfig({ seerr: { url: seerr.url, port: seerr.port } });
    return createCollector(config, { run: fakeRun(), lanIp: async () => null })();
  }

  it('trae título, año, temporadas y quién pidió, sin datos personales', async () => {
    const status = await statusWith(
      pending(
        [
          { id: 1, type: 'movie', media: { tmdbId: 603 }, requestedBy: { displayName: 'Ana', email: 'ana@correo.example' }, createdAt: '2026-11-05T10:00:00.000Z', rootFolder: 'F:\\Movies' },
          { id: 2, type: 'tv', media: { tmdbId: 2316 }, seasons: [{ seasonNumber: 1 }, { seasonNumber: 3 }], requestedBy: { displayName: 'Ana' } },
        ],
        60,
      ),
    );
    const [movie, show] = status.requests.items;
    assert.deepEqual([movie.title, movie.year, movie.kind, movie.requestedBy, movie.origin], ['Matrix', '1999', 'movie', 'Ana', 'seerr']);
    assert.deepEqual([show.title, show.year, show.kind, show.seasons], ['The Office', '2005', 'tv', [1, 3]]);
    assert.equal(status.requests.total, 60);
    const body = JSON.stringify(status.requests);
    assert.ok(!body.includes('ana@correo.example'));
    assert.ok(!body.includes('Movies'));
  });

  it('incluye lo aprobado sin bajar y lo que falló, sin repetir', async () => {
    const approved = { id: 7, status: 2, type: 'movie', media: { tmdbId: 603 } };
    const status = await statusWith({
      '/api/v1/status': { auth: false, json: { version: '3.5.1' } },
      '/api/v1/request/count': { json: {} },
      '/api/v1/request?filter=pending&sort=added&take=50': { json: { pageInfo: { results: 1 }, results: [{ id: 8, status: 1, type: 'tv', media: { tmdbId: 2316 } }] } },
      '/api/v1/request?filter=processing&sort=added&take=50': { json: { pageInfo: { results: 1 }, results: [approved] } },
      '/api/v1/request?filter=failed&sort=added&take=50': { json: { pageInfo: { results: 2 }, results: [approved, { id: 9, status: 4, type: 'movie', media: { tmdbId: 603 } }] } },
      '/api/v1/movie/603': { json: { title: 'Matrix' } },
      '/api/v1/tv/2316': { json: { name: 'The Office' } },
    });
    assert.deepEqual(status.requests.items.map((item) => [item.id, item.status]), [[8, 'approval'], [7, 'approved'], [9, 'failed']]);
  });

  it('un título que no se puede leer no rompe la lista', async () => {
    const status = await statusWith(pending([{ id: 3, type: 'movie', media: { tmdbId: 999 } }]));
    assert.equal(status.requests.items[0].title, 'TMDB 999');
    assert.equal(status.requests.error, null);
  });

  it('si Seerr no responde, se informa solo esa sección', async () => {
    const config = await buildConfig({ seerr: { url: 'http://127.0.0.1:1', port: 1 } });
    const status = await createCollector(config, { run: fakeRun(), lanIp: async () => null })();
    assert.equal(status.requests.error, 'No responde');
    assert.deepEqual(status.requests.items, []);
    assert.equal(partOf(status, 'radarr').state, 'ok');
  });
});

describe('datos del rediseño', () => {
  const STARTED = '2026-11-06T00:30:31Z';
  const STARTED_ISO = '2026-11-06T00:30:31.000Z';
  const collectWith = async (overrides, runOptions) => {
    const config = await buildConfig(overrides);
    return createCollector(config, { run: fakeRun(runOptions), lanIp: async () => null })();
  };
  const serviceOf = ({ url, port }) => ({ url, port });

  async function arrWithStart(apiVersion, key, extra = {}) {
    const routes = arrRoutes(apiVersion, { queue: emptyQueue });
    routes[`/api/${apiVersion}/system/status`] = { json: { version: '1.2.3', startTime: STARTED } };
    return serviceOf(await fakeService({ ...routes, ...extra }, key));
  }

  async function arrWithHistory(key, history) {
    const routes = { ...arrRoutes('v3', { queue: emptyQueue }), '/api/v3/history/since': history };
    return serviceOf(await fakeService(routes, key));
  }

  const imported = (date = '2026-11-06T12:00:00Z') => ({ eventType: 'downloadFolderImported', date });

  describe('startedAt', () => {
    it('sale de Radarr, Sonarr, Prowlarr, Bazarr y el proceso del bot; el resto queda en null', async () => {
      const bazarr = await fakeService(
        {
          '/api/system/status': { json: { data: { bazarr_version: '1.6.2', start_time: 1793928574.5 } } },
          '/api/system/health': { json: { data: [] } },
          '/api/providers': { json: { data: [] } },
        },
        KEYS.bazarr,
      );
      const nodes = JSON.stringify([
        { CommandLine: 'node C:\\otro\\server.js', CreationDate: '/Date(1000)/' },
        { CommandLine: 'node C:\\Develop\\pelis-bot\\agent.js', CreationDate: '/Date(1793973142539)/' },
      ]);
      const status = await collectWith(
        {
          radarr: await arrWithStart('v3', KEYS.radarr),
          sonarr: await arrWithStart('v3', KEYS.sonarr),
          prowlarr: await arrWithStart('v1', KEYS.prowlarr),
          bazarr: serviceOf(bazarr),
        },
        { nodes },
      );
      for (const id of ['radarr', 'sonarr', 'prowlarr']) assert.equal(partOf(status, id).startedAt, STARTED_ISO, id);
      assert.equal(partOf(status, 'bazarr').startedAt, new Date(1793928574500).toISOString());
      assert.equal(partOf(status, 'bot').startedAt, new Date(1793973142539).toISOString());
      for (const id of ['qbittorrent', 'jellyfin', 'seerr', 'tailscale']) {
        assert.strictEqual(partOf(status, id).startedAt, null, id);
      }
    });

    it('una fecha ausente o ilegible es null, y una parte caída también', async () => {
      const routes = arrRoutes('v3', { queue: emptyQueue });
      routes['/api/v3/system/status'] = { json: { version: '1', startTime: 'ayer' } };
      const garbled = await fakeService(routes, KEYS.sonarr);
      const status = await collectWith({ radarr: deadService, sonarr: serviceOf(garbled) });
      assert.strictEqual(partOf(status, 'radarr').startedAt, null);
      assert.strictEqual(partOf(status, 'sonarr').startedAt, null);
      assert.strictEqual(partOf(status, 'prowlarr').startedAt, null);
      assert.strictEqual(partOf(status, 'bazarr').startedAt, null);
      assert.strictEqual(partOf(status, 'bot').startedAt, null, 'el proceso no trae CreationDate');
    });

    it('sin datos de salud conserva la fecha', async () => {
      const service = await arrWithStart('v3', KEYS.radarr, { '/api/v3/health': { status: 500 } });
      const status = await collectWith({ radarr: service });
      assert.equal(partOf(status, 'radarr').state, 'warning');
      assert.equal(partOf(status, 'radarr').startedAt, STARTED_ISO);
    });
  });

  describe('posterPath de los pedidos', () => {
    it('viene de Seerr, y sin dato o sin título es null', async () => {
      const results = [
        { id: 1, type: 'movie', media: { tmdbId: 603 } },
        { id: 2, type: 'tv', media: { tmdbId: 2316 } },
        { id: 3, type: 'movie', media: { tmdbId: 999 } },
      ];
      const seerr = await fakeService(
        {
          '/api/v1/status': { auth: false, json: { version: '3.5.1' } },
          '/api/v1/request/count': { json: {} },
          '/api/v1/request?filter=pending&sort=added&take=50': { json: { pageInfo: { results: 3 }, results } },
          '/api/v1/request': { json: { pageInfo: { results: 0 }, results: [] } },
          '/api/v1/movie/603': { json: { title: 'Matrix', posterPath: '/matrix.jpg' } },
          '/api/v1/tv/2316': { json: { name: 'The Office' } },
        },
        KEYS.seerr,
      );
      const status = await collectWith({ seerr: serviceOf(seerr) });
      assert.deepEqual(status.requests.items.map((item) => item.posterPath), ['/matrix.jpg', null, null]);
    });
  });

  describe('downloads.today', () => {
    it('suma solo las importaciones de Radarr y Sonarr desde la medianoche local', async () => {
      const seen = [];
      const status = await collectWith({
        radarr: await arrWithHistory(KEYS.radarr, { seen, json: [imported(), imported(), { eventType: 'grabbed' }] }),
        sonarr: await arrWithHistory(KEYS.sonarr, { seen, json: [imported()] }),
      });
      assert.equal(status.downloads.today, 3);
      assert.equal('todayPartial' in status.downloads, false);
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      assert.equal(seen.length, 2);
      for (const url of seen) {
        const query = new URL(url, 'http://x').searchParams;
        assert.equal(query.get('eventType'), 'downloadFolderImported');
        assert.equal(new Date(query.get('date')).getTime(), midnight.getTime());
      }
      assert.ok(!seen.join().includes(KEYS.radarr), 'la clave no viaja en la URL');
    });

    it('sin importaciones es 0, no null', async () => {
      const status = await collectWith({
        radarr: await arrWithHistory(KEYS.radarr, { json: [] }),
        sonarr: await arrWithHistory(KEYS.sonarr, { json: [] }),
      });
      assert.strictEqual(status.downloads.today, 0);
    });

    it('si falla uno, suma el otro y avisa que es parcial', async () => {
      const status = await collectWith({
        radarr: deadService,
        sonarr: await arrWithHistory(KEYS.sonarr, { json: [imported(), imported()] }),
      });
      assert.equal(status.downloads.today, 2);
      assert.equal(status.downloads.todayPartial, true);
      assert.deepEqual(status.downloads.errors.map((error) => error.source), ['radarr']);
    });

    it('si fallan los dos es null, y una respuesta rara cuenta como falla', async () => {
      const status = await collectWith({
        radarr: await arrWithHistory(KEYS.radarr, { status: 500 }),
        sonarr: await arrWithHistory(KEYS.sonarr, { json: { records: [] } }),
      });
      assert.strictEqual(status.downloads.today, null);
      assert.equal('todayPartial' in status.downloads, false);
      assert.equal(partOf(status, 'radarr').state, 'ok');
    });
  });

  describe('transfer', () => {
    const qbit = async (route) =>
      serviceOf(await fakeService({ '/api/v2/app/version': { text: 'v5.1.0' }, '/api/v2/transfer/info': route }));

    it('entrega las velocidades cuando qBittorrent responde', async () => {
      const service = await qbit({ json: { dl_info_speed: 1500, up_info_speed: 0, dht_nodes: 300 } });
      const status = await collectWith({ qbittorrent: service });
      assert.deepEqual(status.transfer, { downloadBps: 1500, uploadBps: 0 });
      assert.equal('transferBlocked' in status, false);
    });

    it('con 403 avisa que está bloqueado, y la parte sigue viva', async () => {
      const service = await qbit({ status: 403, text: 'Forbidden' });
      const status = await collectWith({ qbittorrent: service });
      assert.strictEqual(status.transfer, null);
      assert.equal(status.transferBlocked, true);
      assert.equal(partOf(status, 'qbittorrent').state, 'ok');
    });

    it('caído, con error o con una respuesta rara es null, sin decir que está bloqueado', async () => {
      const cases = [deadService, await qbit({ status: 500 }), await qbit({ text: 'no es JSON' }), await qbit({ json: { dl_info_speed: 'x' } })];
      for (const service of cases) {
        const status = await collectWith({ qbittorrent: service });
        assert.strictEqual(status.transfer, null);
        assert.equal('transferBlocked' in status, false);
      }
    });
  });

  it('un historial y un qBittorrent colgados se cortan por timeout sin afectar al resto', async () => {
    const slow = { delayMs: 3000, json: [] };
    const started = Date.now();
    const status = await collectWith({
      radarr: await arrWithHistory(KEYS.radarr, slow),
      sonarr: await arrWithHistory(KEYS.sonarr, { json: [imported()] }),
      qbittorrent: serviceOf(
        await fakeService({ '/api/v2/app/version': { status: 403 }, '/api/v2/transfer/info': { delayMs: 3000, json: {} } }),
      ),
    });
    assert.ok(Date.now() - started < 2000);
    assert.equal(status.downloads.today, 1);
    assert.equal(status.downloads.todayPartial, true);
    assert.strictEqual(status.transfer, null);
    assert.equal(partOf(status, 'radarr').state, 'ok');
  });

  it('los datos nuevos no filtran claves', async () => {
    const status = await collectWith({
      radarr: await arrWithHistory(KEYS.radarr, { json: [imported()] }),
      sonarr: await arrWithHistory(KEYS.sonarr, { json: [imported()] }),
    });
    const body = JSON.stringify(status);
    for (const key of Object.values(KEYS)) assert.ok(!body.includes(key), 'se filtró una clave');
  });
});

describe('conectar y desconectar Tailscale', () => {
  const stopped = JSON.stringify({ BackendState: 'Stopped', TailscaleIPs: [] });

  function tailscaleRun(initial = 'Running', { fail = false, changes = true } = {}) {
    const state = { backend: initial, calls: [] };
    state.run = async (file, args) => {
      if (args[0] === 'down' || args[0] === 'up') {
        state.calls.push(args[0]);
        if (fail) throw new Error('falló');
        if (changes) state.backend = args[0] === 'down' ? 'Stopped' : 'Running';
        return '';
      }
      return state.backend === 'Running' ? TAILSCALE : stopped;
    };
    return state;
  }

  const controller = async (state) => createController(await buildConfig(), { run: state.run, waitMs: 60, pollMs: 5 });

  it('desconecta con tailscale down y lo comprueba', async () => {
    const state = tailscaleRun();
    const result = await (await controller(state))('tailscale', 'stop', { remoteAddress: '127.0.0.1' });
    assert.deepEqual(state.calls, ['down']);
    assert.equal(result.ok, true);
    assert.equal(result.message, 'Tailscale quedó desconectado');
  });

  it('conecta con tailscale up, sin opciones que cambien su configuración', async () => {
    const state = tailscaleRun('Stopped');
    const result = await (await controller(state))('tailscale', 'start');
    assert.deepEqual(state.calls, ['up']);
    assert.equal(result.message, 'Tailscale quedó conectado');
  });

  it('no dice que quedó hecho si no cambió, y dice si falló', async () => {
    let result = await (await controller(tailscaleRun('Running', { changes: false })))('tailscale', 'stop');
    assert.equal(result.ok, false);
    assert.match(result.message, /sigue conectado/);
    result = await (await controller(tailscaleRun('Running', { fail: true })))('tailscale', 'stop');
    assert.equal(result.ok, false);
    assert.match(result.message, /no pudo hacerlo/);
  });

  it('no se puede desconectar por el propio Tailscale, pero sí conectar', async () => {
    for (const remoteAddress of ['100.101.102.103', '::ffff:100.64.0.1', 'fd7a:115c:a1e0::1']) {
      const state = tailscaleRun();
      const result = await (await controller(state))('tailscale', 'stop', { remoteAddress });
      assert.equal(result.ok, false, remoteAddress);
      assert.match(result.message, /perderías el acceso/);
      assert.deepEqual(state.calls, [], remoteAddress);
    }
    const state = tailscaleRun('Stopped');
    assert.equal((await (await controller(state))('tailscale', 'start', { remoteAddress: '100.101.102.103' })).ok, true);
  });

  it('reconoce las direcciones de Tailscale', () => {
    for (const address of ['100.64.0.0', '100.127.255.255', '::ffff:100.101.102.103', 'FD7A:115C:A1E0::1']) {
      assert.equal(isTailscaleAddress(address), true, address);
    }
    for (const address of ['127.0.0.1', '192.168.1.20', '100.63.0.1', '100.128.0.1', '::1', undefined]) {
      assert.equal(isTailscaleAddress(address), false, String(address));
    }
  });
});

describe('pedidos que ya se están bajando', () => {
  const requests = (...items) => ({ items, total: items.length, error: null });
  const movie = { kind: 'movie', tmdbId: 36955, title: 'True Lies' };
  const other = { kind: 'movie', tmdbId: 1, title: 'Wildwood' };

  it('saca de los pedidos lo que está en la cola, con la forma real de Radarr', () => {
    const items = normalizeRadarrQueue([{ id: 1, title: 'x', movie: { title: 'True Lies', year: 1994, tmdbId: 36955 } }]);
    const result = withoutDownloading(requests(movie, other), { items });
    assert.deepEqual(result.items.map((item) => item.title), ['Wildwood']);
    assert.equal(result.total, 1);
  });

  it('cruza series por su tmdbId, sin confundirlas con una película del mismo número', () => {
    const items = normalizeSonarrQueue([{ id: 2, series: { title: 'S', tmdbId: 36955 } }]);
    assert.equal(withoutDownloading(requests(movie), { items }).items.length, 1);
    const show = { kind: 'tv', tmdbId: 36955, title: 'S' };
    assert.equal(withoutDownloading(requests(show), { items }).items.length, 0);
  });

  it('una cola que falla no borra pedidos', () => {
    assert.equal(withoutDownloading(requests(movie), { items: [] }).items.length, 1);
  });
});

describe('login y emparejamiento', () => {
  const ORIGIN = 'http://localhost';
  const hmacHex = (key, message) => createHmac('sha256', key).update(message).digest('hex');
  const nonce = () => randomBytes(16).toString('hex');
  const newAuth = (options = {}) => createAuth({ file: path.join(tmp, `auth-${randomBytes(4).toString('hex')}.json`), ...options });
  const plain = (code) => code.replaceAll('-', '');

  function pair(auth, code = auth.newPairing().code) {
    const key = plain(code);
    const clientNonce = nonce();
    const [startStatus, start] = auth.pairStart({ clientNonce });
    assert.equal(startStatus, 200);
    assert.equal(start.proof, hmacHex(key, `pc|${clientNonce}|${start.serverNonce}`));
    const nonces = `${clientNonce}|${start.serverNonce}`;
    const [status, body] = auth.pairFinish({ clientNonce, serverNonce: start.serverNonce, proof: hmacHex(key, `device|${nonces}`), name: 'Celu' });
    assert.equal(status, 200);
    const seal = Buffer.from(hmacHex(key, `seal|${nonces}`), 'hex');
    const secret = Buffer.from(body.sealedSecret, 'hex').map((byte, index) => byte ^ seal[index]);
    return { deviceId: body.deviceId, secret: Buffer.from(secret).toString('hex') };
  }

  it('empareja, y la PC demuestra quién es sin mandar el secreto', () => {
    const auth = newAuth();
    const { deviceId, secret } = pair(auth);
    const clientNonce = nonce();
    const [status, body] = auth.identify({ deviceId, clientNonce });
    assert.equal(status, 200);
    assert.equal(body.proof, hmacHex(secret, `pc|${clientNonce}`));
    assert.ok(!JSON.stringify(body).includes(secret));
    assert.equal(auth.identify({ deviceId: 'otro', clientNonce })[0], 404);
    const status2 = auth.setupStatus();
    assert.equal(status2.devices.length, 1);
    assert.ok(!JSON.stringify(status2).includes(secret));
  });

  it('el código es de un solo uso, vence, y se anula tras varios errores', () => {
    let clock = 1000;
    const auth = newAuth({ now: () => clock });
    const { code } = auth.newPairing();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    pair(auth, code);
    assert.equal(auth.pairStart({ clientNonce: nonce() })[0], 404);

    auth.newPairing();
    clock += 11 * 60 * 1000;
    assert.equal(auth.pairStart({ clientNonce: nonce() })[0], 404);

    auth.newPairing();
    for (let i = 0; i < 5; i += 1) {
      const clientNonce = nonce();
      const [, start] = auth.pairStart({ clientNonce });
      assert.equal(auth.pairFinish({ clientNonce, serverNonce: start.serverNonce, proof: 'mala' })[0], 403);
    }
    assert.equal(auth.pairStart({ clientNonce: nonce() })[0], 404);
    assert.equal(auth.setupStatus().devices.length, 1);
  });

  it('el login exige dispositivo y contraseña, y frena los intentos', () => {
    let clock = 1000;
    const auth = newAuth({ now: () => clock });
    const { deviceId } = pair(auth);
    assert.equal(auth.login({ deviceId, user: 'a', password: 'x' })[0], 403);
    assert.equal(auth.setPassword({ user: 'mechi', password: 'corta' })[0], 400);
    assert.equal(auth.setPassword({ user: 'mechi', password: 'una-clave-larga' })[0], 200);
    assert.equal(auth.login({ deviceId: 'otro', user: 'mechi', password: 'una-clave-larga' })[0], 403);
    for (let i = 0; i < 4; i += 1) assert.equal(auth.login({ deviceId, user: 'mechi', password: 'mala-clave' })[0], 401);
    assert.equal(auth.login({ deviceId, user: 'mechi', password: 'mala-clave' })[0], 429); // El quinto ya avisa el bloqueo.
    assert.equal(auth.login({ deviceId, user: 'mechi', password: 'una-clave-larga' })[0], 429);
    clock += 61 * 1000;
    const [status, { token }] = auth.login({ deviceId, user: 'mechi', password: 'una-clave-larga' });
    assert.equal(status, 200);
    assert.equal(auth.isValidToken(token), true);
    assert.equal(auth.isValidToken('otro'), false);
    clock += 31 * 24 * 60 * 60 * 1000;
    assert.equal(auth.isValidToken(token), false);
  });

  it('cambiar la contraseña o quitar el dispositivo corta las sesiones', () => {
    const auth = newAuth();
    const { deviceId } = pair(auth);
    auth.setPassword({ user: 'm', password: 'una-clave-larga' });
    let [, { token }] = auth.login({ deviceId, user: 'm', password: 'una-clave-larga' });
    auth.setPassword({ user: 'm', password: 'otra-clave-larga' });
    assert.equal(auth.isValidToken(token), false);
    [, { token }] = auth.login({ deviceId, user: 'm', password: 'otra-clave-larga' });
    assert.equal(auth.removeDevice(deviceId)[0], 200);
    assert.equal(auth.isValidToken(token), false);
  });

  it('le cambia el nombre a un dispositivo, sin caracteres de control', () => {
    const auth = newAuth();
    const { deviceId } = pair(auth);
    assert.deepEqual(auth.renameDevice(deviceId, { name: '  Tablet\n del living  ' }), [200, { ok: true, name: 'Tablet del living' }]);
    assert.equal(auth.setupStatus().devices[0].name, 'Tablet del living');
    assert.equal(auth.renameDevice(deviceId, { name: '   ' })[0], 400);
    assert.equal(auth.renameDevice(deviceId, {})[0], 400);
    assert.equal(auth.renameDevice('abc', { name: 'Otra' })[0], 404);
    assert.equal(auth.renameDevice(deviceId, { name: 'x'.repeat(80) })[1].name.length, 60);
  });

  it('sobrevive a un reinicio, sin guardar la contraseña ni el token en claro', () => {
    const file = path.join(tmp, 'auth-persist.json');
    const first = createAuth({ file });
    const { deviceId } = pair(first);
    first.setPassword({ user: 'm', password: 'una-clave-larga' });
    const [, { token }] = first.login({ deviceId, user: 'm', password: 'una-clave-larga' });
    const stored = fs.readFileSync(file, 'utf8');
    assert.ok(!stored.includes('una-clave-larga'));
    assert.ok(!stored.includes(token));
    assert.equal(createAuth({ file }).isValidToken(token), true);
  });

  describe('por HTTP, desde la red', () => {
    let lan;
    let server;
    let auth;
    let acted = 0;
    let token;
    let deviceId;

    // Una IP de la PC que no sea loopback hace que el pedido cuente como "desde la red".
    const lanIp = Object.values(os.networkInterfaces()).flat().find((entry) => entry.family === 'IPv4' && !entry.internal && /^(192\.168|10\.)/.test(entry.address))?.address;

    before(async () => {
      if (!lanIp) return;
      auth = newAuth();
      server = createApp(async () => ({ ok: true }), {
        allowedOrigins: [ORIGIN],
        auth,
        act: async () => {
          acted += 1;
          return { status: 200, ok: true, message: 'hecho' };
        },
      });
      const address = await listen(server, '0.0.0.0', 0);
      lan = `${lanIp}:${address.port}`;
      servers.push(server);
      ({ deviceId } = pair(auth));
      auth.setPassword({ user: 'm', password: 'una-clave-larga' });
    });

    const call = (host, pathname, { method = 'GET', headers = {}, body } = {}) =>
      new Promise((resolve, reject) => {
        const req = http.request(`http://${host}${pathname}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null }));
        });
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });

    it('sin sesión no se ve el estado ni se puede actuar', { skip: !lanIp }, async () => {
      assert.equal((await call(lan, '/api/status')).status, 401);
      assert.equal((await call(lan, '/api/parts/radarr/stop', { method: 'POST', headers: { Origin: ORIGIN } })).status, 401);
      assert.equal(acted, 0);
    });

    it('un token inventado tampoco sirve', { skip: !lanIp }, async () => {
      const response = await call(lan, '/api/status', { headers: { Authorization: 'Bearer inventado' } });
      assert.equal(response.status, 401);
    });

    it('la configuración no se toca desde la red', { skip: !lanIp }, async () => {
      for (const pathname of ['/api/setup', '/api/setup/pairing', '/api/setup/password']) {
        assert.equal((await call(lan, pathname, { method: 'POST', headers: { Origin: ORIGIN }, body: {} })).status, 403, pathname);
      }
    });

    it('con sesión funciona, y cerrarla la corta', { skip: !lanIp }, async () => {
      const login = await call(lan, '/api/login', { method: 'POST', headers: { Origin: ORIGIN }, body: { deviceId, user: 'm', password: 'una-clave-larga' } });
      assert.equal(login.status, 200);
      ({ token } = login.json);
      const Authorization = `Bearer ${token}`;
      assert.equal((await call(lan, '/api/status', { headers: { Authorization } })).status, 200);
      assert.equal((await call(lan, '/api/parts/radarr/stop', { method: 'POST', headers: { Authorization, Origin: ORIGIN } })).status, 200);
      assert.equal(acted, 1);
      assert.equal((await call(lan, '/api/logout', { method: 'POST', headers: { Authorization } })).status, 200);
      assert.equal((await call(lan, '/api/status', { headers: { Authorization } })).status, 401);
    });

    it('responde el preflight solo al origen de la app', { skip: !lanIp }, async () => {
      const good = await call(lan, '/api/status', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Headers': 'authorization' } });
      assert.equal(good.status, 204);
      assert.equal(good.headers['access-control-allow-origin'], ORIGIN);
      assert.match(good.headers['access-control-allow-headers'], /Authorization/);
      assert.equal((await call(lan, '/api/status', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
    });

    it('rechaza un nombre de host ajeno y JSON roto', { skip: !lanIp }, async () => {
      assert.equal((await call(lan, '/api/status', { headers: { Host: `evil.example:${lan.split(':')[1]}` } })).status, 403);
      assert.equal((await call(lan, '/api/status', { headers: { Host: `8.8.8.8:${lan.split(':')[1]}` } })).status, 403);
      const broken = await new Promise((resolve) => {
        const req = http.request(`http://${lan}/api/login`, { method: 'POST' }, resolve);
        req.end('{roto');
      });
      assert.equal(broken.statusCode, 400);
    });

    it('desde esta PC sigue sin pedir sesión', { skip: !lanIp }, async () => {
      const loop = `127.0.0.1:${lan.split(':')[1]}`;
      assert.equal((await call(loop, '/api/status')).status, 200);
      assert.equal((await call(loop, '/api/setup', { headers: { Origin: ORIGIN } })).status, 200);
      assert.equal((await call(loop, '/api/setup')).status, 403, 'sin Origin no');
    });
  });
});

describe('pausar descargas', () => {
  /** qBittorrent falso que recuerda qué le pidieron. */
  async function fakeQbit({ status = 200, torrents = [], oldApi = false } = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const name = req.url.split('?')[0];
        if (status !== 200) return res.writeHead(status).end();
        if (name === '/api/v2/torrents/info') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(torrents));
        }
        if (oldApi && /torrents\/(stop|start)$/.test(name)) return res.writeHead(404).end();
        calls.push([name, new URLSearchParams(body).get('hashes')]);
        return res.writeHead(200).end();
      });
    });
    await listen(server, '127.0.0.1', 0);
    servers.push(server);
    return { calls, url: `http://127.0.0.1:${server.address().port}` };
  }

  const setup = async (options) => {
    const qbit = await fakeQbit(options);
    const pauseFile = path.join(tmp, `pausa-${randomBytes(4).toString('hex')}.json`);
    const config = { ...DEFAULT_CONFIG, httpTimeoutMs: 400, pauseFile, services: { ...DEFAULT_CONFIG.services, qbittorrent: { url: qbit.url, port: 1 } } };
    return { ...qbit, control: createDownloadControl(config), pauseFile };
  };

  const torrents = [
    { hash: 'aaa', state: 'downloading' },
    { hash: 'bbb', state: 'uploading' },
    { hash: 'ccc', state: 'stoppedDL' },
  ];

  it('frena lo activo y al reanudar no arranca lo que ya estaba frenado', async () => {
    const { calls, control, pauseFile } = await setup({ torrents });
    const paused = await control('pause');
    assert.equal(paused.ok, true);
    assert.match(paused.message, /2 torrents/);
    assert.deepEqual(calls[0], ['/api/v2/torrents/stop', 'aaa|bbb']);
    assert.deepEqual(JSON.parse(fs.readFileSync(pauseFile, 'utf8')), ['aaa', 'bbb']);
    const resumed = await control('resume');
    assert.equal(resumed.ok, true);
    assert.deepEqual(calls[1], ['/api/v2/torrents/start', 'aaa|bbb']);
    assert.deepEqual(JSON.parse(fs.readFileSync(pauseFile, 'utf8')), []);
  });

  it('funciona con la API vieja de qBittorrent', async () => {
    const { calls, control } = await setup({ torrents, oldApi: true });
    await control('pause');
    assert.deepEqual(calls[0], ['/api/v2/torrents/pause', 'aaa|bbb']);
  });

  it('si pide contraseña, explica qué activar, sin recordar nada', async () => {
    const { control, pauseFile } = await setup({ status: 403 });
    const result = await control('pause');
    assert.equal(result.ok, false);
    assert.match(result.message, /Omitir autenticación/);
    assert.equal(fs.existsSync(pauseFile), false);
  });

  it('si qBittorrent está caído lo dice, y acción inventada no ejecuta nada', async () => {
    const config = { ...DEFAULT_CONFIG, httpTimeoutMs: 300, pauseFile: path.join(tmp, 'p.json'), services: { ...DEFAULT_CONFIG.services, qbittorrent: { url: 'http://127.0.0.1:1', port: 1 } } };
    const control = createDownloadControl(config);
    assert.match((await control('pause')).message, /no responde/);
    assert.equal((await control('borrar')).status, 404);
    assert.equal((await control('__proto__')).status, 404);
  });

  it('el estado informa si hay descargas en pausa', async () => {
    const config = await buildConfig();
    config.pauseFile = path.join(tmp, 'estado.json');
    const collect = createCollector(config, { run: fakeRun(), lanIp: async () => null });
    assert.equal((await collect()).paused, false);
    fs.writeFileSync(config.pauseFile, JSON.stringify(['aaa']));
    assert.equal((await collect()).paused, true);
  });
});

describe('pedidos que no pasaron por Seerr', () => {
  const none = { items: [], total: 0, error: null };
  const encounters = { id: 269, tmdbId: 840, title: 'Close Encounters of the Third Kind', year: 1977,
    monitored: true, hasFile: false, isAvailable: true, added: '2026-11-07T18:29:04Z' };

  it('muestra una película del bot que Radarr no pudo mandar a qBittorrent', () => {
    const result = waitingInArrs({ movies: [encounters] }, none, { items: [] });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].title, 'Close Encounters of the Third Kind');
    assert.equal(result.items[0].status, 'notGrabbed');
    assert.equal(result.items[0].kind, 'movie');
    assert.equal(result.items[0].origin, 'telegram');
  });

  it('no repite lo que ya está en Seerr ni lo que se está bajando', () => {
    const seerr = { items: [{ kind: 'movie', tmdbId: 840 }], total: 1, error: null };
    assert.equal(waitingInArrs({ movies: [encounters] }, seerr, { items: [] }).total, 1);
    const queue = { items: [{ mediaType: 'movie', tmdbId: 840 }] };
    assert.equal(waitingInArrs({ movies: [encounters] }, none, queue).total, 0);
  });

  it('ignora la biblioteca sin monitorear y lo que ya tiene archivo', () => {
    const movies = [{ ...encounters, monitored: false }, { ...encounters, id: 2, tmdbId: 2, hasFile: true }];
    assert.equal(waitingInArrs({ movies }, none, { items: [] }).total, 0);
  });

  it('suma series con episodios monitoreados que faltan, sin confundirlas con películas', () => {
    const series = [{ id: 12, tmdbId: 840, title: 'S', monitored: true, statistics: { episodeFileCount: 6, episodeCount: 28 },
      seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: false }] }];
    const result = waitingInArrs({ series }, none, { items: [{ mediaType: 'movie', tmdbId: 840 }] });
    assert.equal(result.items[0].kind, 'tv');
    assert.deepEqual(result.items[0].seasons, [1]);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

// La interfaz es un solo HTML: se prueba la sección de textos, que no toca el DOM.
const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const textos = /--- Textos ---([\s\S]*)\/\/ --- Fin de textos ---/.exec(html)[1];
const { isNewerVersion, pickReleaseAsset, tagFromReleaseUrl, releaseDownloadUrl, rateLimitedUntil, changeCount, changelogDate, changelogVersions, newsTitle, newsToShow, releaseTitles, PART_PURPOSE, PRODUCT_NAME, actionLabel, addSample, availableAction, brandParts, describeChange, deviceKind, diskName, diskPercent, disksMeta, downloadLabel, downloadsMeta, downloadsToday, formatBytes, formatSpeed, formatTimeLeft, formatUptime, globalStatus, lastUpdateText, partUptime, partsForAction, partsMeta, posterUrl, requestFacts, requestsMeta, servicesHealth, servicesMonitored, servicesOnline, sparkPath, sparkPoints, stateLabel, statusWord, storageUsage, summarize, timeAgo, transferNote } =
  new Function(
    `${textos}; return { isNewerVersion, pickReleaseAsset, tagFromReleaseUrl, releaseDownloadUrl, rateLimitedUntil, changeCount, changelogDate, changelogVersions, newsTitle, newsToShow, releaseTitles, PART_PURPOSE, PRODUCT_NAME, actionLabel, addSample, availableAction, brandParts, describeChange, deviceKind, diskName, diskPercent, disksMeta, downloadLabel, downloadsMeta, downloadsToday, formatBytes, formatSpeed, formatTimeLeft, formatUptime, globalStatus, lastUpdateText, partUptime, partsForAction, partsMeta, posterUrl, requestFacts, requestsMeta, servicesHealth, servicesMonitored, servicesOnline, sparkPath, sparkPoints, stateLabel, statusWord, storageUsage, summarize, timeAgo, transferNote };`,
  )();

const require = createRequire(import.meta.url);
const protocolo = /--- Protocolo ---([\s\S]*)\/\/ --- Fin de protocolo ---/.exec(html)[1];
const { findFirst, hmacHex, isAllowedPcHost, isPrivateLan, isTailscaleHost, normalizeCode, normalizeHost, pairLink, parsePairLink, randomHex, subnetHosts, subnetOf, xorHex } = new Function(
  `${protocolo}; return { findFirst, hmacHex, isAllowedPcHost, isPrivateLan, isTailscaleHost, normalizeCode, normalizeHost, pairLink, parsePairLink, randomHex, subnetHosts, subnetOf, xorHex };`,
)();
const qrSection = /--- QR ---([\s\S]*)\/\/ --- Fin de QR ---/.exec(html)[1];
const { qrMatrix, qrSvgPath } = new Function(`${qrSection}; return { qrMatrix, qrSvgPath };`)();

const { isReleaseUrl, isSeerrUrl, isServiceUrl } = require('../electron/seerr-url.cjs');
const { backendScriptPath } = require('../electron/backend.cjs');
const { releaseNotes } = await import('../scripts/changelog.mjs');

describe('textos de la interfaz', () => {
  it('formatea tamaños', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1,5 KB');
    assert.equal(formatBytes(43878146048), '40,9 GB');
    assert.equal(formatBytes(2000395694080), '1,8 TB');
    assert.equal(formatBytes(null), '?');
  });

  it('formatea el tiempo restante de Radarr y Sonarr', () => {
    assert.equal(formatTimeLeft('00:00:30'), 'menos de 1 min');
    assert.equal(formatTimeLeft('00:12:30'), '12 min');
    assert.equal(formatTimeLeft('02:05:00'), '2 h 5 min');
    assert.equal(formatTimeLeft('1.03:00:00'), '1 d 3 h');
    assert.equal(formatTimeLeft(null), null);
  });

  it('prioriza el estado de importación sobre el de descarga', () => {
    assert.equal(downloadLabel({ status: 'completed', trackedState: 'importBlocked' }), 'Importación trabada');
    assert.equal(downloadLabel({ status: 'downloading', trackedState: 'downloading' }), 'Bajando');
    assert.equal(downloadLabel({ status: 'algoNuevo', trackedState: null }), 'algoNuevo');
    assert.equal(stateLabel('raro'), 'Sin datos');
  });

  it('resume los programas', () => {
    assert.equal(summarize([{ state: 'ok' }, { state: 'ok' }]), 'Los 2 programas funcionan');
    assert.equal(
      summarize([{ state: 'ok' }, { state: 'warning' }, { state: 'down' }]),
      '1 de 3 funcionan bien · 1 sin responder o sin datos · 1 con avisos',
    );
  });
});

describe('tablero', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  const MIN = 60000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('calcula el uptime y deja una raya si no hay dato', () => {
    assert.equal(formatUptime(ago(5 * MIN), now), '5m');
    assert.equal(formatUptime(ago(3 * HOUR + 12 * MIN), now), '3h 12m');
    assert.equal(formatUptime(ago(14 * DAY + 8 * HOUR), now), '14d 08h');
    for (const missing of [null, undefined, '', 'cualquiera', ago(-HOUR)]) assert.equal(formatUptime(missing, now), '—');
  });

  it('un programa caído no tiene uptime, aunque quede un dato', () => {
    assert.equal(partUptime({ state: 'down', startedAt: ago(DAY) }, now), '—');
    assert.equal(partUptime({ state: 'ok', startedAt: ago(DAY) }, now), '1d 00h');
    assert.equal(partUptime({ state: 'ok' }, now), '—');
  });

  it('calcula el porcentaje de almacenamiento de todos los discos', () => {
    const usage = storageUsage([
      { totalBytes: 1000, freeBytes: 500 },
      { totalBytes: 3000, freeBytes: 500 },
    ]);
    assert.deepEqual(usage, { totalBytes: 4000, freeBytes: 1000, usedBytes: 3000, percent: 75 });
    assert.equal(storageUsage([]), null);
    assert.equal(storageUsage(undefined), null);
    assert.equal(storageUsage([{ totalBytes: 0, freeBytes: 0 }]), null);
    assert.equal(diskPercent({ totalBytes: 200, freeBytes: 50 }), 75);
    assert.equal(diskName({ id: 'C:', label: null }), 'Drive C:');
    assert.equal(diskName({ id: 'D:', label: 'Datos' }), 'D: Datos');
  });

  it('el estado global refleja el estado real', () => {
    const ok = (name) => ({ name, state: 'ok' });
    assert.deepEqual(globalStatus([ok('A')], { items: [{ low: false }] }), {
      level: 'ok',
      title: 'All systems operational',
      text: 'Your media center is running smoothly',
    });
    const warned = globalStatus([ok('A'), { name: 'Bazarr', state: 'warning' }], { items: [] });
    assert.equal(warned.level, 'warning');
    assert.match(warned.text, /Bazarr/);
    const lowDisk = globalStatus([ok('A')], { items: [{ id: 'E:', low: true }] });
    assert.equal(lowDisk.level, 'warning');
    assert.match(lowDisk.text, /E:/);
    const down = globalStatus([ok('A'), { name: 'Radarr', state: 'down' }], { items: [{ id: 'E:', low: true }] });
    assert.equal(down.level, 'down');
    assert.match(down.title, /Radarr/);
    assert.equal(globalStatus([{ name: 'A', state: 'error' }, { name: 'B', state: 'down' }]).level, 'down');
  });

  it('cuenta los servicios online y nombra su estado', () => {
    assert.equal(servicesOnline([{ state: 'ok' }, { state: 'warning' }, { state: 'error' }, { state: 'down' }]), 3);
    assert.equal(servicesMonitored([{}, {}]), '2 SERVICES MONITORED');
    assert.equal(statusWord('ok'), 'Online');
    assert.equal(statusWord('warning'), 'Warning');
    assert.equal(statusWord('error'), 'Warning');
    assert.equal(statusWord('down'), 'Offline');
  });

  it('muestra las velocidades en MB/s', () => {
    assert.equal(formatSpeed(26004275), '24,8 MB/s');
    assert.equal(formatSpeed(0), '0 MB/s');
    assert.equal(formatSpeed(1000), '<0,1 MB/s');
    assert.equal(formatSpeed(null), '—');
    assert.equal(formatSpeed(undefined), '—');
    assert.equal(transferNote({ transfer: { downloadBps: 1, uploadBps: 1 } }), null);
    assert.match(transferNote({ transfer: null, transferBlocked: true }), /Omitir autenticación para clientes en localhost/);
    assert.equal(transferNote({}), 'Sin datos de velocidad.');
  });

  it('las descargas de hoy no se inventan', () => {
    assert.deepEqual(downloadsToday({ today: 7 }), { value: '7', note: null });
    assert.deepEqual(downloadsToday({ today: 0 }), { value: '0', note: null });
    assert.equal(downloadsToday({ today: 3, todayPartial: true }).value, '3');
    assert.match(downloadsToday({ today: 3, todayPartial: true }).note, /Parcial/);
    assert.equal(downloadsToday({ today: null }).value, '—');
    assert.equal(downloadsToday({}).value, '—');
  });

  it('dice hace cuánto', () => {
    assert.equal(timeAgo(ago(10000), now), 'now');
    assert.equal(timeAgo(ago(5 * MIN), now), '5m ago');
    assert.equal(timeAgo(ago(2 * HOUR), now), '2h ago');
    assert.equal(timeAgo(ago(3 * DAY), now), '3d ago');
    assert.equal(timeAgo(null, now), '');
    assert.equal(lastUpdateText(now - 1000, now), 'Last update: just now');
    assert.equal(lastUpdateText(now - 2 * MIN, now), 'Last update: 2 min ago');
    assert.equal(lastUpdateText(null, now), 'Last update: —');
  });

  it('solo arma miniaturas de TMDB con una ruta simple', () => {
    assert.equal(posterUrl('/abc123.jpg'), 'https://image.tmdb.org/t/p/w92/abc123.jpg');
    for (const bad of [null, undefined, '', 'abc.jpg', '//evil.example/x.jpg', '/../x', 'javascript:alert(1)', '/a b.jpg']) {
      assert.equal(posterUrl(bad), null, String(bad));
    }
  });

  it('avisa solo cuando un programa cambia de estado', () => {
    assert.equal(describeChange({ name: 'Radarr', state: 'ok' }, undefined), null);
    assert.equal(describeChange({ name: 'Radarr', state: 'ok' }, 'ok'), null);
    assert.equal(describeChange({ name: 'Radarr', state: 'down' }, 'ok'), 'Radarr dejó de responder');
    assert.equal(describeChange({ name: 'Radarr', state: 'ok' }, 'down'), 'Radarr volvió a funcionar');
    assert.match(describeChange({ name: 'Radarr', state: 'warning' }, 'ok'), /avisos/);
  });

  it('el nombre del producto sale de una sola constante', () => {
    assert.deepEqual(brandParts('CineVault'), ['Cine', 'Vault']);
    assert.deepEqual(brandParts('LP Cine Vault'), ['LP ', 'Cine Vault']);
    assert.deepEqual(brandParts('nombre'), ['nombre', '']);
    const outside = html.replace(textos, '');
    assert.equal(outside.includes(PRODUCT_NAME), false);
    assert.equal(textos.split(PRODUCT_NAME).length, 2);
  });
});

describe('muestras para las gráficas', () => {
  it('guarda muestras reales con un tope y un mínimo de tiempo entre ellas', () => {
    const history = {};
    addSample(history, 'a', 1, 1000, 500, 3);
    addSample(history, 'a', 2, 1200, 500, 3);
    assert.deepEqual(history.a.values, [1], 'muy pronto');
    addSample(history, 'a', 2, 2000, 500, 3);
    addSample(history, 'a', 3, 3000, 500, 3);
    addSample(history, 'a', 4, 4000, 500, 3);
    assert.deepEqual(history.a.values, [2, 3, 4], 'tope');
  });

  it('sin dato no guarda nada: un hueco nunca se rellena', () => {
    const history = {};
    for (const value of [null, undefined, NaN, Infinity, 'x']) addSample(history, 'a', value, 1000, 0, 3);
    assert.deepEqual(history, {});
  });

  it('con pocas muestras dibuja menos, alineado a la derecha', () => {
    assert.deepEqual(sparkPoints([]), []);
    assert.equal(sparkPath(sparkPoints([5])), '', 'un punto no es una línea');
    const few = sparkPoints([1, 2], { width: 110, height: 30 });
    assert.equal(few.at(-1).x, 110);
    assert.equal(few[0].x, 100, 'ocupa solo la parte derecha');
    const many = sparkPoints(Array.from({ length: 48 }, (_, i) => i), { width: 100 });
    assert.ok(Math.abs(many[0].x) < 1e-9, 'con 48 muestras ocupa todo el ancho');
  });

  it('respeta la escala y no se sale del alto', () => {
    const points = sparkPoints([0, 0.5, 1], { width: 100, height: 30, min: 0, max: 1, pad: 2 });
    assert.equal(points[0].y, 28);
    assert.equal(points[2].y, 2);
    for (const point of sparkPoints([7, 7, 7], { height: 30 })) assert.ok(point.y > 0 && point.y < 30);
    assert.match(sparkPath(points), /^M[\d.]+ [\d.]+Q.*L100 2$/);
  });
});

describe('estructura de la interfaz', () => {
  it('permite miniaturas solo de TMDB y nada más de afuera', () => {
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)[1];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /img-src https:\/\/image\.tmdb\.org data:/);
    assert.doesNotMatch(html, /fonts\.googleapis|<link /);
  });

  it('tiene las vistas y conserva los botones de acción', () => {
    for (const view of ['overview', 'services', 'downloads', 'requests', 'storage', 'network', 'jellyfin', 'devices', 'settings']) {
      assert.ok(html.includes(`id="view-${view}"`), view);
      assert.ok(html.includes(`data-view="${view}"`), view);
    }
    for (const id of ['stop-all', 'start-all', 'open-seerr', 'refresh', 'theme', 'banner', 'gate', 'devices', 'connection']) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
  });

  it('Celulares es una vista propia, antes de Settings y solo en la app de Windows', () => {
    const view = (name) => new RegExp(`<section id="view-${name}"[\\s\\S]*?</section>`).exec(html)[0];
    assert.match(view('devices'), /id="devices-meta"/);
    assert.match(view('devices'), /id="devices"/);
    assert.match(view('devices'), /<h2>Celulares<\/h2>/);
    assert.doesNotMatch(view('devices'), /view-head/);
    assert.doesNotMatch(view('settings'), /devices|Celulares/);
    // Barra lateral y menú "Más": ocultas al cargar, justo antes de Settings.
    const entries = html.match(/<button[^>]*data-view="devices"[^>]*>.*<\/button>\s*<button[^>]*data-view="settings"/g);
    assert.equal(entries?.length, 2);
    for (const entry of entries) {
      assert.match(entry, /data-desktop-only hidden/);
      assert.match(entry, /data-icon="smartphone"/);
      assert.match(entry, />Celulares</);
    }
    assert.match(html, /const MORE_VIEWS = \[[^\]]*'devices'/);
    assert.match(html, /if \(name === 'devices' && !isMobile\) loadDevices\(\);/);
    // Solo la rama de Windows las muestra.
    const start = /if \(isMobile\) \{\s*startMobile\(\);\s*\} else \{([\s\S]*?)\}\s*<\/script>/.exec(html);
    assert.match(start[1], /querySelectorAll\('\[data-desktop-only\]'\)\) node\.hidden = false/);
    assert.equal(html.match(/data-desktop-only\]'\)\) node\.hidden = false/g).length, 1);
    assert.doesNotMatch(html, /devices-section/);
  });
});

describe('Overview del celu', () => {
  it('resume los servicios: todo bien, o cuáles tienen problemas', () => {
    const part = (name, state) => ({ name, state });
    assert.deepEqual(servicesHealth([part('Radarr', 'ok'), part('Sonarr', 'ok')]), {
      level: 'ok',
      title: 'Todo funcionando',
      text: 'Los 2 servicios responden bien',
    });
    assert.deepEqual(servicesHealth([part('Radarr', 'down'), part('Sonarr', 'ok'), part('Bazarr', 'warning')]), {
      level: 'down',
      title: '2 servicios con problemas: Radarr, Bazarr',
      text: 'Radarr: no responde · Bazarr: con avisos',
    });
    const one = servicesHealth([part('Seerr', 'error'), part('Sonarr', 'ok')]);
    assert.equal(one.level, 'warning');
    assert.equal(one.title, '1 servicio con problemas: Seerr');
    assert.equal(servicesHealth([]).level, 'error');
  });

  it('se distingue por la plataforma y no por el ancho, para que Windows no cambie', () => {
    assert.match(html, /if \(isMobile\) document\.documentElement\.classList\.add\('app-android'\)/);
    assert.match(html, /\.app-android #view-overview > \.room-head,\s*\.app-android #room \{\s*display: none;/);
    assert.match(html, /<div id="health" class="health-wrap" hidden><\/div>/);
    // Las reglas del Overview del celu no viven dentro de una media query de ancho.
    const block = /\/\* --- Overview del celu[\s\S]*?\.quick-message\.failed/.exec(html)[0];
    assert.doesNotMatch(block, /@media/);
  });

  it('el acceso rápido de Jellyfin se arma con el mismo código en la vista Jellyfin y en el Overview', () => {
    assert.equal(html.match(/\/api\/jellyfin\/quick-connect/g).length, 1);
    assert.match(html, /jellyfinQuick = createQuickConnect\(\)/);
    assert.match(html, /homeQuick = createQuickConnect\(\)/);
  });
});

describe('para qué sirve cada programa', () => {
  it('tiene un texto para las 9 partes', () => {
    const ids = ['radarr', 'sonarr', 'prowlarr', 'bazarr', 'qbittorrent', 'jellyfin', 'seerr', 'bot', 'tailscale'];
    assert.deepEqual(Object.keys(PART_PURPOSE).sort(), [...ids].sort());
    for (const id of ids) assert.ok(PART_PURPOSE[id].length > 0, id);
  });
});

describe('secciones y acciones', () => {
  it('resume cada sección para verla aunque esté cerrada', () => {
    assert.equal(downloadsMeta({ items: [], errors: [] }), 'Nada');
    assert.equal(downloadsMeta({ items: [], errors: [{}] }), 'No se pudo leer todo');
    assert.equal(downloadsMeta({ items: [{}, {}], errors: [] }), '2 descargas');
    assert.equal(partsMeta([{ state: 'ok' }]), 'Todo bien');
    assert.equal(partsMeta([{ state: 'ok' }, { state: 'down' }]), '1 con problemas');
    assert.equal(disksMeta({ items: [] }), 'Sin datos');
    assert.equal(disksMeta({ items: [{ low: true }, { low: false }] }), '1 con poco espacio');
  });

  it('ofrece levantar solo lo que no responde', () => {
    assert.equal(availableAction({ state: 'down' }), 'start');
    for (const state of ['ok', 'warning', 'error']) assert.equal(availableAction({ state }), 'stop');
  });
});

describe('apagar y prender todo', () => {
  const control = { stopWarning: 'x' };
  const parts = [
    { id: 'radarr', state: 'ok', control },
    { id: 'bazarr', state: 'warning', control },
    { id: 'jellyfin', state: 'error', control },
    { id: 'seerr', state: 'down', control },
    { id: 'tailscale', state: 'ok', control: { stopWarning: 'x', kind: 'connection', bulk: false } },
    { id: 'tailscale-caido', state: 'down', control: { stopWarning: 'x', kind: 'connection', bulk: false } },
    { id: 'otro', state: 'down', control: null },
  ];

  it('nombra la acción según el tipo de control', () => {
    assert.equal(actionLabel('stop', false), 'Frenar');
    assert.equal(actionLabel('start', true), 'Levantando…');
    assert.equal(actionLabel('stop', false, 'connection'), 'Desconectar');
    assert.equal(actionLabel('start', false, 'connection'), 'Conectar');
    assert.equal(actionLabel('start', true, 'connection'), 'Conectando…');
  });

  it('elige solo lo que corresponde y nunca Tailscale', () => {
    assert.deepEqual(partsForAction(parts, 'stop').map((part) => part.id), ['radarr', 'bazarr', 'jellyfin']);
    assert.deepEqual(partsForAction(parts, 'start').map((part) => part.id), ['seerr']);
  });
});

describe('pedidos pendientes', () => {
  it('resume y describe cada pedido', () => {
    assert.equal(requestsMeta({ total: 0, error: null }), 'Ninguno');
    assert.equal(requestsMeta({ total: 1, error: null }), '1 pedido');
    assert.equal(requestsMeta({ total: 3, error: null }), '3 pedidos');
    assert.equal(requestsMeta({ total: 0, error: 'No responde' }), 'Sin datos');
    assert.equal(
      requestFacts({ status: 'approval', kind: 'tv', seasons: [1, 2], requestedBy: 'Ana', createdAt: null }),
      'Espera aprobación · Serie · temporadas 1, 2 · pedido por Ana',
    );
    assert.equal(
      requestFacts({ status: 'approved', kind: 'movie', seasons: [], requestedBy: null, createdAt: null }),
      'Aprobado, todavía sin bajar · Película',
    );
    assert.equal(requestFacts({ status: 'failed', kind: 'movie', seasons: [], requestedBy: null, createdAt: null }), 'Falló · Película');
  });
});

describe('abrir un programa en el navegador', () => {
  it('acepta solo los puertos de los programas, en direcciones privadas', () => {
    for (const port of [7878, 8989, 9696, 6767, 8080, 8096, 5055]) {
      assert.equal(isServiceUrl(`http://127.0.0.1:${port}`), true, String(port));
      assert.equal(isServiceUrl(`http://100.101.102.103:${port}`), true, String(port));
    }
    for (const url of ['http://127.0.0.1:8787', 'http://8.8.8.8:7878', 'https://127.0.0.1:7878', 'file:///C:/x', 'javascript:alert(1)', 'http://evil.example:7878']) {
      assert.equal(isServiceUrl(url), false, url);
    }
  });

  it('Seerr dentro de la app sigue aceptando solo su puerto', () => {
    assert.equal(isSeerrUrl('http://127.0.0.1:7878'), false);
  });
});

describe('backend de la app instalada', () => {
  it('lo busca fuera del asar, donde Node puede ejecutarlo', () => {
    assert.equal(
      backendScriptPath(String.raw`C:\Apps\LP\resources\app.asar`),
      String.raw`C:\Apps\LP\resources\app.asar.unpacked\backend\server.js`,
    );
  });
});

describe('dirección de Seerr', () => {
  it('acepta el puerto de Seerr en la PC, la LAN y Tailscale', () => {
    for (const host of ['127.0.0.1', 'localhost', '192.168.1.20', '10.0.0.5', '172.16.0.1', '100.101.102.103']) {
      assert.equal(isSeerrUrl(`http://${host}:5055`), true, host);
    }
  });

  it('rechaza cualquier otra', () => {
    for (const url of [
      'http://8.8.8.8:5055',
      'http://192.168.1.20:7878',
      'https://192.168.1.20:5055',
      'file:///C:/x',
      'http://192.168.1.20.evil.example:5055',
      'http://100.128.0.1:5055',
      'nada',
    ]) {
      assert.equal(isSeerrUrl(url), false, url);
    }
  });
});

describe('protocolo y búsqueda del celular', () => {
  it('calcula el mismo HMAC que el backend', async () => {
    const expected = createHmac('sha256', 'clave').update('pc|abc').digest('hex');
    assert.equal(await hmacHex('clave', 'pc|abc'), expected);
  });

  it('normaliza el código y descifra el secreto', () => {
    assert.equal(normalizeCode(' abcd-ef23 4567 '), 'ABCDEF234567');
    assert.equal(xorHex(xorHex('00ff10', 'a1b2c3'), 'a1b2c3'), '00ff10');
    assert.match(randomHex(16), /^[a-f0-9]{32}$/);
  });

  it('solo usa HTTP hacia esta PC, redes privadas y Tailscale', () => {
    for (const host of ['127.0.0.1', '192.168.1.20', '10.0.0.5', '172.16.0.1', '100.101.102.103']) {
      assert.equal(isAllowedPcHost(host), true, host);
    }
    for (const host of ['8.8.8.8', 'evil.example', '192.168.1.20.evil.example', '100.128.0.1', '172.32.0.1', '192.168.1.999', '', null]) {
      assert.equal(isAllowedPcHost(host), false, String(host));
    }
    assert.equal(isTailscaleHost('100.101.102.103'), true);
    assert.equal(isPrivateLan('100.101.102.103'), false);
  });

  it('recorre solo las 254 direcciones de una subred privada', () => {
    assert.equal(subnetOf('192.168.1.50'), '192.168.1');
    assert.equal(subnetOf('100.101.102.103'), null, 'nunca Tailscale');
    assert.equal(subnetOf('8.8.8.8'), null, 'nunca una pública');
    assert.equal(subnetOf(null), null);
    const hosts = subnetHosts('192.168.1');
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], '192.168.1.1');
    assert.equal(hosts[253], '192.168.1.254');
  });

  it('busca de a pocos y frena al encontrar', async () => {
    let active = 0;
    let peak = 0;
    let tried = 0;
    const found = await findFirst(subnetHosts('192.168.1'), async (host) => {
      tried += 1;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return host === '192.168.1.40' ? 'sí' : null;
    }, 8);
    assert.equal(found.host, '192.168.1.40');
    assert.equal(found.value, 'sí');
    assert.ok(peak <= 8);
    assert.ok(tried < 60, 'no siguió recorriendo');
    assert.equal(await findFirst(['a', 'b'], async () => null, 2), null);
  });
});

describe('escribir la dirección de la PC', () => {
  it('acepta la IP como se la escriba, sin dejar pasar otra cosa', () => {
    for (const text of ['100.101.102.103', ' 100.101.102.103 ', '100.101.102.103:8787', 'http://100.101.102.103:8787/', 'HTTP://100.101.102.103/api']) {
      assert.equal(normalizeHost(text), '100.101.102.103', text);
    }
    assert.equal(normalizeHost('192.168.1.20:8787'), '192.168.1.20');
    assert.equal(normalizeHost(''), '');
    assert.equal(normalizeHost(null), '');
    assert.equal(isAllowedPcHost(normalizeHost('http://evil.example:8787/')), false);
    assert.equal(isAllowedPcHost(normalizeHost('8.8.8.8:8787')), false);
  });
});

describe('actualizaciones', () => {
  it('compara versiones numéricamente', () => {
    assert.equal(isNewerVersion('v0.1.12', '0.1.9'), true);
    assert.equal(isNewerVersion('0.1.9', '0.1.12'), false);
    assert.equal(isNewerVersion('v0.1.9', '0.1.9'), false);
    assert.equal(isNewerVersion('v0.2.0', '0.1.99'), true);
    assert.equal(isNewerVersion('v1.0', '0.9.9'), true);
    assert.equal(isNewerVersion(null, '0.1.0'), false);
  });

  it('elige el APK en Android y el instalador en Windows', () => {
    const assets = [{ name: 'LP-Cine-Vault.apk' }, { name: 'LP-Cine-Vault-Setup.exe' }, { name: 'otro.blockmap' }];
    assert.equal(pickReleaseAsset(assets, true).name, 'LP-Cine-Vault.apk');
    assert.equal(pickReleaseAsset(assets, false).name, 'LP-Cine-Vault-Setup.exe');
    assert.equal(pickReleaseAsset([], true), null);
    assert.equal(pickReleaseAsset(undefined, false), null);
  });

  it('lee la última versión de la redirección de github.com, sin la API', () => {
    assert.equal(tagFromReleaseUrl('https://github.com/mmunozpatino/lp-media-center/releases/tag/v0.1.15'), 'v0.1.15');
    assert.equal(tagFromReleaseUrl('/mmunozpatino/lp-media-center/releases/tag/v0.1.15'), 'v0.1.15');
    for (const bad of [null, '', 'https://github.com/otra/lp-media-center/releases/tag/v1.0', 'https://evil.example/mmunozpatino/lp-media-center/releases/tag/v1.0', 'https://github.com/mmunozpatino/lp-media-center/releases']) {
      assert.equal(tagFromReleaseUrl(bad), null, String(bad));
    }
    assert.equal(releaseDownloadUrl('v0.1.15', true), 'https://github.com/mmunozpatino/lp-media-center/releases/download/v0.1.15/LP-Cine-Vault.apk');
    assert.equal(releaseDownloadUrl('v0.1.15', false), 'https://github.com/mmunozpatino/lp-media-center/releases/download/v0.1.15/LP-Cine-Vault-Setup.exe');
  });

  it('reconoce el corte por el límite de la API y hasta cuándo dura', () => {
    const headers = (values) => ({ get: (name) => values[name] ?? null });
    assert.equal(rateLimitedUntil(403, headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' })), 1800000000 * 1000);
    assert.equal(rateLimitedUntil(429, headers({ 'retry-after': '60' }), 1000), 61000);
    assert.equal(rateLimitedUntil(429, headers({}), 0), 3600000);
    assert.equal(rateLimitedUntil(403, headers({ 'x-ratelimit-remaining': '12' })), null); // Otro 403: no es el límite.
    assert.equal(rateLimitedUntil(200, headers({})), null);
  });
});

describe('novedades', () => {
  const change = (title, body = '') => ({ title, body });
  const versions = changelogVersions({
    versions: [
      { version: '0.1.3', date: '2026-11-06', changes: [change('Tercera')] },
      { version: '0.1.5', date: '2026-11-08', changes: [change('Quinta', 'Con detalle')] },
      { version: '0.1.4', date: '2026-11-07', changes: [] },
      { version: '0.1.10', date: '2026-11-09', changes: [change('Décima')] },
      { version: 'cualquiera', changes: [change('No')] },
      { version: '0.1.2', changes: [{ title: '  ' }, { title: 5 }, change('Segunda')] },
    ],
  });

  it('limpia y ordena el changelog de la más nueva a la más vieja', () => {
    assert.deepEqual(versions.map((entry) => entry.version), ['0.1.10', '0.1.5', '0.1.4', '0.1.3', '0.1.2']);
    assert.deepEqual(versions.at(-1), { version: '0.1.2', date: null, changes: [change('Segunda')] });
    assert.deepEqual(changelogVersions(null), []);
    assert.deepEqual(changelogVersions({ versions: 'x' }), []);
  });

  it('muestra las versiones nuevas desde la última vista, sin las vacías ni las futuras', () => {
    const shown = (current, lastSeen) => newsToShow(versions, current, lastSeen).map((entry) => entry.version);
    assert.deepEqual(shown('0.1.5', '0.1.2'), ['0.1.5', '0.1.3']);
    assert.deepEqual(shown('0.1.10', '0.1.5'), ['0.1.10']);
    assert.deepEqual(shown('0.1.5', '0.1.5'), []);
    assert.deepEqual(shown('0.1.3', '0.1.5'), []);
    assert.deepEqual(shown('0.1.4', '0.1.3'), []);
  });

  it('la primera vez muestra solo la versión actual, y en desarrollo nada', () => {
    assert.deepEqual(newsToShow(versions, '0.1.5', null).map((entry) => entry.version), ['0.1.5']);
    assert.deepEqual(newsToShow(versions, '0.1.4', null), []);
    assert.deepEqual(newsToShow(versions, null, null), []);
    assert.deepEqual(newsToShow(versions, undefined, '0.1.2'), []);
  });

  it('titula el diálogo según cuántas versiones junta', () => {
    assert.equal(newsTitle([versions[0]]), 'Novedades de la versión 0.1.10');
    assert.equal(newsTitle(versions.slice(1, 4)), 'Novedades desde la versión 0.1.3');
    assert.equal(changeCount(1), '1 cambio');
    assert.equal(changeCount(3), '3 cambios');
  });

  it('muestra la fecha del commit sin correrla por la zona horaria', () => {
    assert.match(changelogDate('2026-11-07'), /^7 (de )?nov\.? (de )?2026$/);
    assert.equal(changelogDate(null), null);
    assert.equal(changelogDate('ayer'), null);
  });

  it('lee los títulos del texto que arma el workflow para la release', () => {
    const notes = releaseNotes({ changes: [change('Uno', 'Explicación\n\nOtro párrafo'), change('Dos'), change('Tres'), change('Cuatro'), change('Cinco')] });
    assert.deepEqual(releaseTitles(notes), { titles: ['Uno', 'Dos', 'Tres', 'Cuatro'], more: 1 });
    assert.deepEqual(releaseTitles('- **Negrita** y `código`\n* Otra\nTexto suelto\n  - sangrado'), { titles: ['Negrita y código', 'Otra'], more: 0 });
    assert.deepEqual(releaseTitles(null), { titles: [], more: 0 });
  });
});

describe('enlaces de actualización', () => {
  it('solo abre descargas de las versiones de este repo', () => {
    assert.equal(isReleaseUrl('https://github.com/mmunozpatino/lp-media-center/releases/download/v0.1.3/LP-Cine-Vault-Setup.exe'), true);
    assert.equal(isReleaseUrl('https://github.com/mmunozpatino/lp-media-center/releases'), true);
    for (const url of [
      'https://github.com/mmunozpatino/lp-media-center/releases-falsas',
      'http://github.com/mmunozpatino/lp-media-center/releases/download/v1/x.exe',
      'https://github.com/otra/lp-media-center/releases/download/v1/x.exe',
      'https://github.com.evil.example/mmunozpatino/lp-media-center/releases/x',
      'https://github.com/mmunozpatino/lp-media-center/blob/main/x',
      'file:///C:/x.exe',
    ]) {
      assert.equal(isReleaseUrl(url), false, url);
    }
  });
});

describe('QR de emparejamiento', () => {
  it('arma y lee el enlace, y descarta lo que no es nuestro', () => {
    const link = pairLink('ABCD-EFGH-JK23', '192.168.1.20');
    assert.equal(link, 'lpcinevault://emparejar?codigo=ABCD-EFGH-JK23&pc=192.168.1.20');
    assert.deepEqual(parsePairLink(link), { code: 'ABCD-EFGH-JK23', host: '192.168.1.20' });
    assert.deepEqual(parsePairLink(pairLink('ABCD-EFGH-JK23', null)), { code: 'ABCD-EFGH-JK23', host: '' });
    assert.deepEqual(parsePairLink(pairLink('ABCD-EFGH-JK23', '8.8.8.8')), { code: 'ABCD-EFGH-JK23', host: '' });
    assert.equal(parsePairLink('lpcinevault://emparejar?codigo=CORTO'), null);
    assert.equal(parsePairLink('https://example.com/?codigo=ABCD-EFGH-JK23'), null);
    assert.equal(parsePairLink(null), null);
  });

  it('elige la versión según el largo y respeta los patrones fijos', () => {
    const small = qrMatrix('hola');
    assert.equal(small.length, 21);
    const link = qrMatrix(pairLink('ABCD-EFGH-JK23', '100.101.102.103'));
    assert.equal(link.length, 37); // Versión 5.
    for (const matrix of [small, link]) {
      const n = matrix.length;
      // Esquinas de los tres buscadores y el módulo oscuro fijo.
      for (const [x, y] of [[0, 0], [6, 6], [n - 1, 0], [0, n - 1], [8, n - 8]]) assert.equal(matrix[y][x], true);
      for (const [x, y] of [[7, 7], [n - 8, 7], [7, n - 8]]) assert.equal(matrix[y][x], false);
      // Línea de tiempo alternada.
      for (let i = 8; i < n - 8; i++) assert.equal(matrix[6][i], i % 2 === 0);
    }
    assert.equal(qrMatrix('x'.repeat(200)).length, 57); // Versión 10.
    assert.throws(() => qrMatrix('x'.repeat(400)), /demasiado largo/);
  });

  it('dibuja solo los módulos oscuros, con margen', () => {
    const { path, size } = qrSvgPath([[true, false], [false, true]]);
    assert.equal(size, 10);
    assert.equal(path, 'M4 4h1v1h-1zM5 5h1v1h-1z');
  });
});

describe('celulares', () => {
  it('elige el ícono de cada dispositivo por su nombre, y si no dice nada usa uno genérico', () => {
    assert.equal(deviceKind('Celular Android'), 'android');
    assert.equal(deviceKind('Celu de ejemplo'), 'android');
    assert.equal(deviceKind('Pixel 9'), 'android');
    assert.equal(deviceKind('Tablet de ejemplo'), 'tablet');
    assert.equal(deviceKind('Galaxy Tab S9'), 'tablet');
    assert.equal(deviceKind('Equipo de ejemplo'), 'other');
    assert.equal(deviceKind(''), 'other');
    assert.equal(deviceKind(null), 'other');
  });
});

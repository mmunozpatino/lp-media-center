// Backend de LP Media Center: un solo script, solo con módulos nativos de Node.
// Consulta los programas de esta PC y entrega el estado en GET /api/status. Frena o levanta un programa
// con POST /api/parts/<id>/stop o /start. Las claves se leen en cada consulta, viajan solo en cabeceras
// hacia 127.0.0.1 y nunca salen en una respuesta.
// Escucha en IPv4 para que llegue el celular. Desde esta PC no pide login; desde afuera exige un dispositivo
// emparejado y la contraseña del panel, y solo acepta direcciones privadas y de Tailscale. El firewall
// limita además quién llega. Nunca en IPv6: la PC tiene IPv6 público.

import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import dgram from 'node:dgram';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Configuración: solo rutas y puertos, nunca claves ---

const HOST = '0.0.0.0';
const PORT = 8787;

// La interfaz de Electron se sirve desde este origen. Nadie más puede leer el backend desde un
// navegador: sin esto, cualquier página abierta en la PC podría pedirle el estado a 127.0.0.1.
// http://localhost, sin puerto, es el origen fijo de la app de Android.
const ALLOWED_ORIGINS = ['app://lp-media-center', 'http://localhost'];

// Fuera de AppData, que en esta PC está virtualizado para las herramientas de la app de Claude.
const AUTH_FILE = path.join(os.homedir(), '.lp-media-center', 'auth.json');

export const DEFAULT_CONFIG = {
  services: {
    radarr: { url: 'http://127.0.0.1:7878', port: 7878, keyFile: 'C:\\ProgramData\\Radarr\\config.xml' },
    sonarr: { url: 'http://127.0.0.1:8989', port: 8989, keyFile: 'C:\\ProgramData\\Sonarr\\config.xml' },
    prowlarr: { url: 'http://127.0.0.1:9696', port: 9696, keyFile: 'C:\\ProgramData\\Prowlarr\\config.xml' },
    bazarr: { url: 'http://127.0.0.1:6767', port: 6767, keyFile: 'C:\\ProgramData\\Bazarr\\config\\config.yaml' },
    qbittorrent: { url: 'http://127.0.0.1:8080', port: 8080 },
    jellyfin: { url: 'http://127.0.0.1:8096', port: 8096 },
    seerr: { url: 'http://127.0.0.1:5055', port: 5055, keyFile: 'C:\\Develop\\seerr\\app\\config\\settings.json' },
  },
  tailscaleExe: 'C:\\Program Files\\Tailscale\\tailscale.exe',
  httpTimeoutMs: 4000,
  commandTimeoutMs: 15000,
  actionCommandTimeoutMs: 30000,
  lowDiskRatio: 0.1,
  queuePageSize: 100,
  pauseFile: path.join(os.homedir(), '.lp-media-center', 'pausa.json'),
  requestsPageSize: 50,
};

// --- Consultas y claves ---

/** Falla de una parte. `state` es lo que se le informa a la interfaz: 'down' o 'error'. */
class ProbeError extends Error {
  constructor(state, message) {
    super(message);
    this.state = state;
  }
}

async function httpGet(url, { headers = {}, timeoutMs }) {
  try {
    return await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ProbeError('down', 'No responde');
  }
}

async function getJson(url, options) {
  const response = await httpGet(url, options);
  if (response.status === 401 || response.status === 403) throw new ProbeError('error', 'Rechazó la clave');
  if (!response.ok) throw new ProbeError('error', `Respondió HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new ProbeError('error', 'Respondió algo que no se pudo leer');
  }
}

async function readKeyFile(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new ProbeError('error', 'No se pudo leer su configuración');
  }
}

function requireKey(key) {
  if (!key) throw new ProbeError('error', 'Su configuración no tiene clave');
  return key;
}

async function readXmlApiKey(file) {
  const text = await readKeyFile(file);
  return requireKey(/<ApiKey>\s*([^<\s]+)\s*<\/ApiKey>/i.exec(text)?.[1]);
}

/** Lee `auth.apikey` del YAML de Bazarr: la clave `apikey` dentro del bloque indentado de `auth:`. */
export async function readBazarrApiKey(file) {
  const text = await readKeyFile(file);
  const block = /^auth:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(text)?.[1] ?? '';
  return requireKey(/^[ \t]+apikey:[ \t]*['"]?([^'"\s]+)/m.exec(block)?.[1]);
}

async function readSeerrApiKey(file) {
  const text = await readKeyFile(file);
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new ProbeError('error', 'No se pudo leer su configuración');
  }
  return requireKey(settings.main?.apiKey);
}

function runCommand(file, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function runPowerShell(run, script, options) {
  const prefix = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;";
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', prefix + script], options);
}

/** Devuelve una lista: ConvertTo-Json da un objeto suelto con un resultado, y nada sin resultados. */
async function powerShellList(run, script, options) {
  const stdout = await runPowerShell(run, script, options);
  const text = stdout.trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

// --- Una función por programa. Devuelven solo lo que la interfaz puede ver ---

const stateFromIssues = (issues) => (issues.length ? 'warning' : 'ok');

/** Fecha en ISO 8601, o null si no se puede leer. PowerShell 5.1 serializa las fechas como /Date(ms)/. */
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const legacy = /^\/Date\((\d+)/.exec(value)?.[1];
  const date = new Date(legacy ? Number(legacy) : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function arrPart(service, apiVersion, config) {
  const options = {
    headers: { 'X-Api-Key': await readXmlApiKey(service.keyFile) },
    timeoutMs: config.httpTimeoutMs,
  };
  const base = `${service.url}/api/${apiVersion}`;
  const status = await getJson(`${base}/system/status`, options);
  const version = status.version ?? null;
  const startedAt = toIso(status.startTime);
  try {
    const health = await getJson(`${base}/health`, options);
    const issues = health.map((item) => ({ level: item.type ?? 'warning', message: item.message ?? '' }));
    const serious = issues.filter((issue) => issue.level !== 'notice' && issue.level !== 'ok');
    return { state: stateFromIssues(serious), version, startedAt, detail: null, issues };
  } catch (error) {
    return { state: 'warning', version, startedAt, detail: `Sin datos de salud: ${error.message}`, issues: [] };
  }
}

const PROBES = {
  radarr: (config) => arrPart(config.services.radarr, 'v3', config),
  sonarr: (config) => arrPart(config.services.sonarr, 'v3', config),
  prowlarr: (config) => arrPart(config.services.prowlarr, 'v1', config),

  async bazarr(config) {
    const service = config.services.bazarr;
    const options = {
      headers: { 'X-API-KEY': await readBazarrApiKey(service.keyFile) },
      timeoutMs: config.httpTimeoutMs,
    };
    const status = await getJson(`${service.url}/api/system/status`, options);
    const [health, providers] = await Promise.allSettled([
      getJson(`${service.url}/api/system/health`, options),
      getJson(`${service.url}/api/providers`, options),
    ]);
    const issues = [];
    for (const item of health.value?.data ?? []) {
      issues.push({ level: 'warning', message: [item.object, item.issue].filter(Boolean).join(': ') });
    }
    for (const provider of providers.value?.data ?? []) {
      if (provider.status && provider.status !== 'Good') {
        const retry = provider.retry && provider.retry !== '-' ? ` (reintento: ${provider.retry})` : '';
        issues.push({ level: 'warning', message: `Subtítulos, ${provider.name}: ${provider.status}${retry}` });
      }
    }
    const missing = [health, providers].some((result) => result.status === 'rejected');
    return {
      state: missing ? 'warning' : stateFromIssues(issues),
      version: status.data?.bazarr_version ?? null,
      startedAt: Number.isFinite(status.data?.start_time) ? toIso(status.data.start_time * 1000) : null,
      detail: missing ? 'Sin datos completos de salud' : null,
      issues,
    };
  },

  /** Sin sesión responde 403: alcanza para saber que está vivo. Los torrents requieren su contraseña. */
  async qbittorrent(config) {
    const url = `${config.services.qbittorrent.url}/api/v2/app/version`;
    const response = await httpGet(url, { timeoutMs: config.httpTimeoutMs });
    if (response.status === 403) {
      return { state: 'ok', version: null, detail: 'Vivo. Velocidades y torrents requieren su contraseña', issues: [] };
    }
    if (!response.ok) throw new ProbeError('error', `Respondió HTTP ${response.status}`);
    const version = (await response.text()).trim().slice(0, 40);
    return { state: 'ok', version: version || null, detail: null, issues: [] };
  },

  async jellyfin(config) {
    const info = await getJson(`${config.services.jellyfin.url}/System/Info/Public`, {
      timeoutMs: config.httpTimeoutMs,
    });
    return {
      state: 'ok',
      version: info.Version ?? null,
      detail: info.ServerName ? `Servidor ${info.ServerName}` : null,
      issues: [],
    };
  },

  async seerr(config) {
    const service = config.services.seerr;
    const options = { timeoutMs: config.httpTimeoutMs };
    const status = await getJson(`${service.url}/api/v1/status`, options);
    const version = status.version ?? null;
    const issues = status.restartRequired ? [{ level: 'warning', message: 'Pide reiniciarse' }] : [];
    try {
      const key = await readSeerrApiKey(service.keyFile);
      const count = await getJson(`${service.url}/api/v1/request/count`, { ...options, headers: { 'X-Api-Key': key } });
      return {
        state: stateFromIssues(issues),
        version,
        detail: `Pedidos: ${count.pending ?? 0} por aprobar, ${count.processing ?? 0} en proceso`,
        issues,
      };
    } catch (error) {
      return { state: 'warning', version, detail: `Sin datos de pedidos: ${error.message}`, issues };
    }
  },

  /** Solo se comprueba el proceso: el bot no tiene latido, así que no se sabe si atiende pedidos. */
  async bot(config, run) {
    const processes = await powerShellList(
      run,
      "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Select-Object CommandLine,CreationDate | ConvertTo-Json -Compress",
      { timeoutMs: config.commandTimeoutMs },
    );
    const agent = processes.find((process) => /(?:^|[\s"\\/])agent\.js(?:["\s]|$)/i.test(process.CommandLine ?? ''));
    if (!agent) throw new ProbeError('down', 'No encontré el proceso');
    return {
      state: 'ok',
      version: null,
      startedAt: toIso(agent.CreationDate),
      detail: 'Proceso activo. No indica si atiende pedidos',
      issues: [],
    };
  },

  async tailscale(config, run) {
    let stdout;
    try {
      stdout = await run(config.tailscaleExe, ['status', '--json'], { timeoutMs: config.commandTimeoutMs });
    } catch {
      throw new ProbeError('down', 'No responde');
    }
    let status;
    try {
      status = JSON.parse(stdout);
    } catch {
      throw new ProbeError('error', 'Respondió algo que no se pudo leer');
    }
    const ip = status.TailscaleIPs?.find((address) => address.includes('.')) ?? null;
    const version = status.Version?.split('-')[0] ?? null;
    if (status.BackendState === 'Stopped') {
      return { state: 'down', stateText: 'Desconectado', version, detail: null, issues: [], ip };
    }
    if (status.BackendState !== 'Running') {
      return { state: 'warning', version, detail: `Estado: ${status.BackendState ?? 'desconocido'}`, issues: [], ip };
    }
    const peers = Object.values(status.Peer ?? {});
    const online = peers.filter((peer) => peer.Online).length;
    return {
      state: 'ok',
      version,
      detail: `${online} de ${peers.length} equipos conectados`,
      issues: [],
      ip,
    };
  },
};

const PARTS = [
  { id: 'radarr', name: 'Radarr' },
  { id: 'sonarr', name: 'Sonarr' },
  { id: 'prowlarr', name: 'Prowlarr' },
  { id: 'bazarr', name: 'Bazarr' },
  { id: 'qbittorrent', name: 'qBittorrent' },
  { id: 'jellyfin', name: 'Jellyfin' },
  { id: 'seerr', name: 'Seerr' },
  { id: 'bot', name: 'Bot de Telegram' },
  { id: 'tailscale', name: 'Tailscale' },
];

async function readDisks(config, run) {
  const disks = await powerShellList(
    run,
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress",
    { timeoutMs: config.commandTimeoutMs },
  );
  const items = disks
    .filter((disk) => disk.Size > 0)
    .map((disk) => ({
      id: disk.DeviceID,
      label: disk.VolumeName || null,
      totalBytes: disk.Size,
      freeBytes: disk.FreeSpace,
      low: disk.FreeSpace / disk.Size < config.lowDiskRatio,
    }));
  return { state: items.some((disk) => disk.low) ? 'warning' : 'ok', detail: null, items };
}

// --- Colas de Radarr y Sonarr. Los campos salen del openapi.json oficial; cualquiera puede faltar ---

function progressOf(size, left) {
  if (!(size > 0) || typeof left !== 'number') return null;
  return Math.min(1, Math.max(0, (size - left) / size));
}

function problemsOf(records) {
  const messages = new Set();
  for (const record of records) {
    if (record.errorMessage) messages.add(record.errorMessage);
    for (const status of record.statusMessages ?? []) {
      for (const message of status.messages ?? []) messages.add(message);
      if (!status.messages?.length && status.title) messages.add(status.title);
    }
  }
  return [...messages];
}

function normalizeDownload(source, records, { id, title, subtitle }) {
  const first = records[0];
  return {
    id: `${source}-${id}`,
    source,
    tmdbId: first.movie?.tmdbId ?? first.series?.tmdbId ?? null,
    mediaType: source === 'radarr' ? 'movie' : 'tv',
    title,
    subtitle,
    releaseTitle: first.title ?? null,
    downloadId: first.downloadId ?? null,
    status: first.status ?? null,
    trackedState: first.trackedDownloadState ?? null,
    trackedStatus: first.trackedDownloadStatus ?? null,
    progress: progressOf(first.size, first.sizeleft),
    sizeBytes: first.size ?? null,
    leftBytes: first.sizeleft ?? null,
    timeLeft: first.timeleft ?? null,
    quality: first.quality?.quality?.name ?? null,
    problems: problemsOf(records),
  };
}

export function normalizeRadarrQueue(records) {
  return records.map((record) =>
    normalizeDownload('radarr', [record], {
      id: record.id,
      title: record.movie?.title ?? record.title ?? 'Sin título',
      subtitle: record.movie?.year ? String(record.movie.year) : null,
    }),
  );
}

const pad = (number) => String(number).padStart(2, '0');

/** Un pack de temporada trae un registro por episodio con el mismo `downloadId`: se muestra uno solo. */
export function normalizeSonarrQueue(records) {
  const groups = new Map();
  for (const record of records) {
    const key = record.downloadId ?? `id-${record.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.values()].map((group) => {
    const [first] = group;
    const season = first.episode?.seasonNumber ?? first.seasonNumber;
    let subtitle = null;
    if (group.length > 1) {
      subtitle = `Temporada ${season ?? '?'} · ${group.length} episodios`;
    } else if (first.episode) {
      subtitle = `T${pad(season)}E${pad(first.episode.episodeNumber)}`;
      if (first.episode.title) subtitle += ` · ${first.episode.title}`;
    }
    return normalizeDownload('sonarr', group, {
      id: first.id,
      title: first.series?.title ?? first.title ?? 'Sin título',
      subtitle,
    });
  });
}

const QUEUES = [
  { source: 'radarr', name: 'Radarr', query: 'includeMovie=true', normalizeQueue: normalizeRadarrQueue },
  { source: 'sonarr', name: 'Sonarr', query: 'includeSeries=true&includeEpisode=true', normalizeQueue: normalizeSonarrQueue },
];

async function fetchQueue({ source, query }, config) {
  const service = config.services[source];
  const key = await readXmlApiKey(service.keyFile);
  const url = `${service.url}/api/v3/queue?page=1&pageSize=${config.queuePageSize}&${query}`;
  return getJson(url, { headers: { 'X-Api-Key': key }, timeoutMs: config.httpTimeoutMs });
}

/** Si una cola falla, se informa esa cola y la otra se muestra igual. */
async function collectDownloads(config) {
  const results = await Promise.allSettled(QUEUES.map((queue) => fetchQueue(queue, config)));
  const items = [];
  const errors = [];
  let truncated = false;
  results.forEach((result, index) => {
    const queue = QUEUES[index];
    if (result.status === 'rejected') {
      errors.push({ source: queue.source, name: queue.name, message: result.reason.message });
      return;
    }
    const records = result.value.records ?? [];
    items.push(...queue.normalizeQueue(records));
    if ((result.value.totalRecords ?? 0) > records.length) truncated = true;
  });
  return { items, errors, truncated };
}

// --- Importaciones de hoy. Cuenta cada archivo importado: un pack de temporada suma un episodio por vez ---

const IMPORTED_EVENT = 'downloadFolderImported';

async function countImportsSince(source, date, config) {
  const service = config.services[source];
  const key = await readXmlApiKey(service.keyFile);
  const url = `${service.url}/api/v3/history/since?date=${encodeURIComponent(date)}&eventType=${IMPORTED_EVENT}`;
  const records = await getJson(url, { headers: { 'X-Api-Key': key }, timeoutMs: config.httpTimeoutMs });
  if (!Array.isArray(records)) throw new ProbeError('error', 'Respondió algo que no se pudo leer');
  return records.filter((record) => record.eventType === IMPORTED_EVENT).length;
}

/** Si falla un programa, suma el otro y lo avisa. Sin ninguno, no hay número. */
async function collectToday(config) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const results = await Promise.allSettled(
    QUEUES.map(({ source }) => countImportsSince(source, midnight.toISOString(), config)),
  );
  const counts = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  if (!counts.length) return { today: null };
  const today = counts.reduce((sum, count) => sum + count, 0);
  return counts.length < results.length ? { today, todayPartial: true } : { today };
}

// --- Velocidad de qBittorrent. Sin la opción de omitir su contraseña desde esta PC, responde 403 ---

async function collectTransfer(config) {
  try {
    const url = `${config.services.qbittorrent.url}/api/v2/transfer/info`;
    const response = await httpGet(url, { timeoutMs: config.httpTimeoutMs });
    if (response.status === 403) return { transfer: null, transferBlocked: true };
    if (!response.ok) return { transfer: null };
    const { dl_info_speed: downloadBps, up_info_speed: uploadBps } = await response.json();
    if (typeof downloadBps !== 'number' || typeof uploadBps !== 'number') return { transfer: null };
    return { transfer: { downloadBps, uploadBps } };
  } catch {
    return { transfer: null };
  }
}

// --- Pedidos que todavía no llegaron. Para Seerr, "pending" es solo lo que espera aprobación: lo aprobado
// que todavía no se bajó está en "processing", y lo que falló en "failed". Solo sale el nombre de quien
// pidió, nunca su mail ---

const REQUEST_FILTERS = ['pending', 'processing', 'failed'];
const REQUEST_STATUS = { 1: 'approval', 2: 'approved', 4: 'failed' };

async function requestTitle(request, service, options) {
  const tmdbId = request.media?.tmdbId;
  const fallback = { title: tmdbId ? `TMDB ${tmdbId}` : 'Sin título', year: null, posterPath: null };
  if (!tmdbId) return fallback;
  try {
    const path = request.type === 'tv' ? 'tv' : 'movie';
    const info = await getJson(`${service.url}/api/v1/${path}/${tmdbId}`, options);
    const date = info.releaseDate ?? info.firstAirDate ?? '';
    return {
      title: info.title ?? info.name ?? fallback.title,
      year: date.slice(0, 4) || null,
      posterPath: info.posterPath ?? null,
    };
  } catch {
    return fallback;
  }
}

async function collectRequests(config) {
  const service = config.services.seerr;
  try {
    const key = await readSeerrApiKey(service.keyFile);
    const options = { headers: { 'X-Api-Key': key }, timeoutMs: config.httpTimeoutMs };
    const pages = await Promise.all(
      REQUEST_FILTERS.map((filter) =>
        getJson(`${service.url}/api/v1/request?filter=${filter}&sort=added&take=${config.requestsPageSize}`, options),
      ),
    );
    // Un pedido puede entrar en más de un filtro.
    const results = [...new Map(pages.flatMap((page) => page.results ?? []).map((request) => [request.id, request])).values()];
    const total = Math.max(results.length, pages.reduce((sum, page) => sum + (page.pageInfo?.results ?? 0), 0));
    const items = await Promise.all(
      results.map(async (request) => ({
        id: request.id,
        kind: request.type === 'tv' ? 'tv' : 'movie',
        tmdbId: request.media?.tmdbId ?? null,
        status: REQUEST_STATUS[request.status] ?? 'approved',
        ...(await requestTitle(request, service, options)),
        seasons: (request.seasons ?? []).map((season) => season.seasonNumber),
        requestedBy: request.requestedBy?.displayName ?? null,
        createdAt: request.createdAt ?? null,
        origin: 'seerr',
      })),
    );
    return { items, total, error: null };
  } catch (error) {
    return { items: [], total: 0, error: describeFailure(error).detail };
  }
}

/** Para Seerr, lo que ya se está bajando sigue "aprobado": se saca de los pedidos si está en una cola. */
export function withoutDownloading(requests, downloads) {
  const inQueue = new Set(downloads.items.map((item) => `${item.mediaType}-${item.tmdbId}`));
  const items = requests.items.filter((request) => !inQueue.has(`${request.kind}-${request.tmdbId}`));
  return { ...requests, items, total: requests.total - (requests.items.length - items.length) };
}

// --- Lo que Radarr y Sonarr esperan sin que haya pasado por Seerr, como lo pedido por el bot ---
// Su origen se informa como 'telegram': fuera de Seerr, los pedidos entran por el bot. El bot no los marca, así que
// algo agregado a mano en Radarr o Sonarr también sale así.

/** Monitoreado, sin archivo y fuera de la cola. Lo de Seerr gana si está en los dos lados. */
export function waitingInArrs({ movies = [], series = [] }, requests, downloads) {
  const known = new Set([
    ...requests.items.map((item) => `${item.kind}-${item.tmdbId}`),
    ...downloads.items.map((item) => `${item.mediaType}-${item.tmdbId}`),
  ]);
  const items = [];
  for (const movie of movies) {
    if (!movie.monitored || movie.hasFile || !movie.tmdbId || known.has(`movie-${movie.tmdbId}`)) continue;
    items.push({
      id: `radarr-${movie.id}`,
      kind: 'movie',
      tmdbId: movie.tmdbId,
      status: movie.isAvailable ? 'notGrabbed' : 'notReleased',
      title: movie.title ?? 'Sin título',
      year: movie.year > 0 ? String(movie.year) : null,
      posterPath: null,
      seasons: [],
      requestedBy: null,
      createdAt: movie.added ?? null,
      source: 'radarr',
      origin: 'telegram',
    });
  }
  for (const show of series) {
    const stats = show.statistics ?? {};
    if (!show.monitored || !(stats.episodeFileCount < stats.episodeCount)) continue;
    if (!show.tmdbId || known.has(`tv-${show.tmdbId}`)) continue;
    items.push({
      id: `sonarr-${show.id}`,
      kind: 'tv',
      tmdbId: show.tmdbId,
      status: 'notGrabbed',
      title: show.title ?? 'Sin título',
      year: show.year > 0 ? String(show.year) : null,
      posterPath: null,
      seasons: (show.seasons ?? []).filter((season) => season.monitored).map((season) => season.seasonNumber),
      requestedBy: null,
      createdAt: show.added ?? null,
      source: 'sonarr',
      origin: 'telegram',
    });
  }
  return { ...requests, items: [...requests.items, ...items], total: requests.total + items.length };
}

/** Si uno no responde, se usa lo que haya: esto solo suma pedidos, nunca los saca. */
async function collectLibraries(config) {
  const get = async (source, path) => {
    const service = config.services[source];
    const key = await readXmlApiKey(service.keyFile);
    return getJson(`${service.url}/api/v3/${path}`, { headers: { 'X-Api-Key': key }, timeoutMs: config.httpTimeoutMs });
  };
  const [movies, series] = await Promise.allSettled([
    get('radarr', 'wanted/missing?page=1&pageSize=100&monitored=true'),
    get('sonarr', 'series'),
  ]);
  return {
    movies: movies.status === 'fulfilled' && Array.isArray(movies.value?.records) ? movies.value.records : [],
    series: series.status === 'fulfilled' && Array.isArray(series.value) ? series.value : [],
  };
}

// --- IP de LAN: se detecta en cada consulta, porque la PC la toma por DHCP y puede cambiar ---

const VIRTUAL_ADAPTER = /vethernet|hyper-v|virtualbox|vmware|wsl|docker|loopback|tailscale|zerotier|wireguard|vpn/i;

function isPrivateIpv4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Elige la IP de LAN entre las interfaces. Prefiere la de la ruta por defecto, si es una candidata: con
 * un nodo de salida de Tailscale esa ruta no es la LAN, y entonces vale la primera que quede.
 */
export function pickLanIp(interfaces, routeIp) {
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const entry of addresses ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address)) {
        candidates.push(entry.address);
      }
    }
  }
  return candidates.includes(routeIp) ? routeIp : (candidates[0] ?? null);
}

/** Pregunta qué IP de origen usaría Windows para salir. Un `connect` UDP no manda ningún paquete. */
function defaultRouteIp() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const finish = (value) => {
      socket.close();
      resolve(value);
    };
    socket.on('error', () => finish(null));
    socket.connect(53, '192.0.2.1', () => finish(socket.address().address));
  });
}

async function detectLanIp() {
  return pickLanIp(os.networkInterfaces(), await defaultRouteIp());
}

// --- Estado completo: si una parte falla, se informa esa parte y las demás siguen ---

function describeFailure(error) {
  if (error instanceof ProbeError) return { state: error.state, detail: error.message };
  return { state: 'error', detail: 'No se pudo comprobar' };
}

async function probePart({ id, name }, config, run) {
  const port = config.services[id]?.port ?? null;
  const control = CONTROLS[id]
    ? { stopWarning: CONTROLS[id].stopWarning, kind: CONTROLS[id].kind ?? 'program', bulk: CONTROLS[id].bulk ?? true }
    : null;
  try {
    return { id, name, port, control, startedAt: null, ...(await PROBES[id](config, run)) };
  } catch (error) {
    return { id, name, port, control, startedAt: null, version: null, issues: [], ...describeFailure(error) };
  }
}

// --- Lo que espera en el buzón del bot, todavía sin llegar a la PC ---
// GET /api/waiting solo lee: /api/pending y /api/series/pending no se usan, porque además guardan la señal de vida del
// programa de la PC. Es una consulta a internet, así que se repite como mucho una vez por minuto. Si el buzón no
// responde o todavía no tiene /api/waiting publicado, no se muestra nada de ahí.

export function createMailboxReader({ file = MAILBOX_CONFIG, fetchImpl = fetch, now = Date.now, everyMs = 60_000, timeoutMs = 5000 } = {}) {
  let cache = null;
  let cachedAt = -Infinity;
  return async function readWaiting() {
    if (now() - cachedAt < everyMs) return cache;
    cachedAt = now();
    cache = null;
    try {
      const { mailboxUrl, mailboxKey } = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof mailboxUrl !== 'string' || !/^https:\/\//.test(mailboxUrl) || !mailboxKey) return null;
      const response = await fetchImpl(`${mailboxUrl.replace(/\/+$/, '')}/api/waiting`, {
        headers: { Authorization: `Bearer ${mailboxKey}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const body = await response.json();
      cache = { movies: Array.isArray(body?.movies) ? body.movies : [], series: Array.isArray(body?.series) ? body.series : [] };
    } catch {
      cache = null;
    }
    return cache;
  };
}

/** Suma lo que espera en el buzón, salvo lo que ya aparece por otro lado. */
export function waitingInMailbox(waiting, requests, downloads) {
  if (!waiting) return requests;
  const known = new Set([
    ...requests.items.map((item) => `${item.kind}-${item.tmdbId}`),
    ...downloads.items.map((item) => `${item.mediaType}-${item.tmdbId}`),
  ]);
  const items = [];
  const add = (kind, entry) => {
    const id = Number(entry?.id);
    const tmdbId = Number(entry?.tmdbId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(tmdbId) || tmdbId <= 0 || known.has(`${kind}-${tmdbId}`)) return;
    known.add(`${kind}-${tmdbId}`);
    const season = Number(entry.seasons);
    items.push({
      id: `buzon-${kind}-${id}-${tmdbId}`,
      kind,
      tmdbId,
      status: 'waiting',
      title: typeof entry.title === 'string' && entry.title ? entry.title : 'Sin título',
      year: entry.year ? String(entry.year) : null,
      posterPath: null,
      seasons: kind === 'tv' && Number.isInteger(season) && season >= 0 ? [season] : [],
      requestedBy: null,
      createdAt: null,
      origin: 'telegram',
    });
  };
  for (const movie of waiting.movies) add('movie', movie);
  for (const show of waiting.series) add('tv', show);
  return { ...requests, items: [...requests.items, ...items], total: requests.total + items.length };
}

export function createCollector(config, { run = runCommand, lanIp = detectLanIp, mailbox = null } = {}) {
  return async function collect() {
    const [parts, downloads, today, transfer, requests, disks, lan, libraries, waiting] = await Promise.all([
      Promise.all(PARTS.map((part) => probePart(part, config, run))),
      collectDownloads(config),
      collectToday(config),
      collectTransfer(config),
      collectRequests(config),
      readDisks(config, run).catch((error) => ({ items: [], ...describeFailure(error) })),
      lanIp().catch(() => null),
      collectLibraries(config),
      mailbox ? mailbox().catch(() => null) : null,
    ]);
    const tailscale = parts.find((part) => part.id === 'tailscale');
    const { ip: tailscaleIp = null } = tailscale;
    delete tailscale.ip;
    return {
      generatedAt: new Date().toISOString(),
      network: { lanIp: lan, tailscaleIp },
      parts,
      downloads: { ...downloads, ...today },
      ...transfer,
      requests: requests.error
        ? requests
        : waitingInMailbox(waiting, waitingInArrs(libraries, withoutDownloading(requests, downloads), downloads), downloads),
      paused: readPausedHashes(config.pauseFile).length > 0,
      disks,
    };
  };
}

// --- Frenar y levantar. Los comandos son fijos: del pedido solo se usa para elegir de esta lista ---

const QBITTORRENT_EXE = 'C:\\Program Files\\qBittorrent\\qbittorrent.exe';
const JELLYFIN_TRAY_EXE = 'C:\\Program Files\\Jellyfin\\Server\\jellyfin-windows-tray\\Jellyfin.Windows.Tray.exe';

const stopNodeProcess = (pathPart) =>
  `Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -like '*${pathPart}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;

// Pide cerrar qBittorrent, y solo lo fuerza si sigue abierto: puede estar configurado para ir a la bandeja.
const STOP_QBITTORRENT =
  "$p = Get-Process qbittorrent -ErrorAction SilentlyContinue; if ($p) { $p | ForEach-Object { [void]$_.CloseMainWindow() }; $p | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue; Get-Process qbittorrent -ErrorAction SilentlyContinue | Stop-Process -Force }";

const STOP_JELLYFIN =
  "Get-Process 'Jellyfin.Windows.Tray','jellyfin' -ErrorAction SilentlyContinue | Stop-Process -Force";

async function powerShellAction(run, script, config) {
  try {
    await runPowerShell(run, script, { timeoutMs: config.actionCommandTimeoutMs });
  } catch {
    throw new ProbeError('error', 'Windows no pudo hacerlo');
  }
}

async function windowsService(verb, service, run, config) {
  try {
    await run('sc.exe', [verb, service], { timeoutMs: config.actionCommandTimeoutMs });
  } catch (error) {
    if (error.code === 1056 || error.code === 1062) return; // Ya estaba levantado o frenado.
    if (error.code === 5) {
      throw new ProbeError('error', 'Windows no da permiso: hay que otorgarlo una vez como administrador');
    }
    throw new ProbeError('error', 'Windows no pudo hacerlo');
  }
}

/** Abre un programa de la sesión por medio de Explorer, para que no quede como hijo del backend. */
async function openProgram(file, run, config) {
  try {
    await run('explorer.exe', [file], { timeoutMs: config.actionCommandTimeoutMs });
  } catch {
    // Explorer termina con código 1 aunque haya funcionado. El resultado se comprueba después.
  }
}

const serviceControl = (service, stopWarning) => ({
  stopWarning,
  start: (run, config) => windowsService('start', service, run, config),
  stop: (run, config) => windowsService('stop', service, run, config),
});

const taskControl = (task, stopPathPart, stopWarning) => ({
  stopWarning,
  start: (run, config) => powerShellAction(run, `Start-ScheduledTask -TaskName '${task}'`, config),
  stop: (run, config) => powerShellAction(run, stopNodeProcess(stopPathPart), config),
});

async function tailscaleCommand(verb, run, config) {
  try {
    await run(config.tailscaleExe, [verb], { timeoutMs: config.actionCommandTimeoutMs });
  } catch {
    throw new ProbeError('error', 'Tailscale no pudo hacerlo');
  }
}

const CONTROLS = {
  // No entra en "apagar todo", y no se puede desconectar por el propio Tailscale: se perdería el acceso.
  tailscale: {
    kind: 'connection',
    bulk: false,
    stopWarning:
      'Si estás fuera de casa, perdés el acceso a la PC y desde acá no vas a poder reconectarla. Solo vas a poder conectar de nuevo desde la red de casa.',
    done: { stop: 'desconectado', start: 'conectado' },
    pending: { stop: 'sigue conectado', start: 'todavía no se conecta' },
    start: (run, config) => tailscaleCommand('up', run, config),
    stop: (run, config) => tailscaleCommand('down', run, config),
  },
  radarr: serviceControl('Radarr', 'Deja de buscar e importar películas hasta que lo levantes.'),
  sonarr: serviceControl('Sonarr', 'Deja de buscar e importar series hasta que lo levantes.'),
  prowlarr: serviceControl('Prowlarr', 'Radarr y Sonarr se quedan sin indexadores hasta que lo levantes.'),
  bazarr: serviceControl('Bazarr', 'Deja de buscar subtítulos hasta que lo levantes.'),
  qbittorrent: {
    stopWarning: 'Se cortan todas las descargas. Si no cierra solo, se fuerza el cierre.',
    start: (run, config) => openProgram(QBITTORRENT_EXE, run, config),
    stop: (run, config) => powerShellAction(run, STOP_QBITTORRENT, config),
  },
  jellyfin: {
    stopWarning: 'Se corta lo que se esté viendo. Se fuerza el cierre, porque no tiene otra forma sin su clave.',
    start: (run, config) => openProgram(JELLYFIN_TRAY_EXE, run, config),
    stop: (run, config) => powerShellAction(run, STOP_JELLYFIN, config),
  },
  seerr: taskControl('Seerr', '\\seerr\\node\\node.exe', 'No se podrán hacer pedidos hasta que lo levantes.'),
  bot: taskControl(
    'Pelis Bot Agent',
    '\\pelis-bot\\agent\\agent.js',
    'El bot de Telegram deja de atender pedidos hasta que lo levantes.',
  ),
};

/** Si el pedido entró por Tailscale. Cubre IPv4 (100.64.0.0/10), IPv4 mapeada a IPv6 e IPv6 de Tailscale. */
export function isTailscaleAddress(address = '') {
  const plain = address.toLowerCase().replace(/^::ffff:/, '');
  if (plain.startsWith('fd7a:115c:a1e0:')) return true;
  const [a, b] = plain.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function createController(
  config,
  { run = runCommand, waitMs = 45000, pollMs = 1500 } = {},
) {
  const busy = new Set();

  /** Hace la acción y espera hasta comprobarla: "levantado" significa que volvió a responder. */
  return async function act(id, action, { remoteAddress } = {}) {
    const part = PARTS.find((candidate) => candidate.id === id);
    const control = CONTROLS[id];
    if (!part || !control || (action !== 'start' && action !== 'stop')) return { status: 404 };
    if (id === 'tailscale' && action === 'stop' && isTailscaleAddress(remoteAddress)) {
      return { status: 200, ok: false, message: 'No se puede desconectar Tailscale por el propio Tailscale: perderías el acceso' };
    }
    if (busy.has(id)) return { status: 409, ok: false, message: `${part.name} ya tiene una acción en curso` };

    busy.add(id);
    try {
      await control[action](run, config);
      const reached = (state) => (action === 'stop' ? state === 'down' : state !== 'down');
      const deadline = Date.now() + waitMs;
      let state;
      do {
        ({ state } = await probePart(part, config, run));
        if (reached(state)) {
          const done = control.done?.[action] ?? (action === 'stop' ? 'frenado' : 'levantado');
          return { status: 200, ok: true, state, message: `${part.name} quedó ${done}` };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      } while (Date.now() < deadline);
      const pending = control.pending?.[action] ?? (action === 'stop' ? 'sigue respondiendo' : 'todavía no responde');
      return { status: 200, ok: false, state, message: `Se pidió a Windows, pero ${part.name} ${pending}` };
    } catch (error) {
      const message = error instanceof ProbeError ? error.message : 'No se pudo hacer';
      return { status: 200, ok: false, message: `${part.name}: ${message}` };
    } finally {
      busy.delete(id);
    }
  };
}

// --- Login y emparejamiento. El protocolo de la app está en ui/index.html, sección "Protocolo" ---

const hmac = (key, message) => createHmac('sha256', key).update(message).digest();
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function sameBytes(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

const isNonce = (value) => typeof value === 'string' && /^[a-f0-9]{32,64}$/.test(value);

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PAIRING_MS = 10 * 60 * 1000;
const PAIRING_MAX_FAILURES = 5;
const PAIRING_MAX_STARTS = 20;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 60 * 1000;
/** Nombre que se muestra de un dispositivo: sin caracteres de control y de hasta 60 letras. */
export function cleanDeviceName(name) {
  return typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

/**
 * Guarda hash de contraseña, dispositivos y sesiones en un archivo privado del usuario, fuera del repo.
 */
export function createAuth({ file = AUTH_FILE, now = Date.now } = {}) {
  let data = { user: null, salt: null, hash: null, devices: [], sessions: [] };
  try {
    data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    // Sin archivo todavía: no hay contraseña ni dispositivos.
  }
  let pairing = null;
  const loginFailures = new Map();

  function save() {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, file);
  }

  const activePairing = () => (pairing && now() < pairing.expires ? pairing : null);

  function failPairing() {
    pairing.failures += 1;
    if (pairing.failures >= PAIRING_MAX_FAILURES) pairing = null;
  }

  return {
    setupStatus() {
      const active = activePairing();
      return {
        hasPassword: Boolean(data.hash),
        user: data.user,
        devices: data.devices.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
        pairing: active ? { expiresAt: new Date(active.expires).toISOString() } : null,
      };
    },

    setPassword({ user, password }) {
      if (typeof user !== 'string' || !user.trim()) return [400, { error: 'Falta el usuario' }];
      if (typeof password !== 'string' || password.length < 8) {
        return [400, { error: 'La contraseña necesita al menos 8 caracteres' }];
      }
      data.user = user.trim();
      data.salt = randomBytes(16).toString('hex');
      data.hash = hashPassword(password, data.salt);
      data.sessions = []; // Cambiar la contraseña cierra todas las sesiones.
      save();
      return [200, { ok: true }];
    },

    /** Código de 12 caracteres, de un solo uso: se muestra en la PC y se escribe en el celular. */
    newPairing() {
      const bytes = randomBytes(12);
      const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
      pairing = { code, expires: now() + PAIRING_MS, failures: 0, starts: 0, serverNonce: null };
      return {
        code: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`,
        expiresAt: new Date(pairing.expires).toISOString(),
      };
    },

    /** La PC demuestra que conoce el código, sin mandarlo: un equipo ajeno no puede responder esto. */
    pairStart({ clientNonce }) {
      if (!activePairing()) return [404, { error: 'No hay un emparejamiento abierto' }];
      if (!isNonce(clientNonce)) return [400, { error: 'Pedido inválido' }];
      pairing.starts += 1;
      if (pairing.starts > PAIRING_MAX_STARTS) {
        pairing = null;
        return [404, { error: 'No hay un emparejamiento abierto' }];
      }
      pairing.serverNonce = randomBytes(16).toString('hex');
      const proof = hmac(pairing.code, `pc|${clientNonce}|${pairing.serverNonce}`).toString('hex');
      return [200, { serverNonce: pairing.serverNonce, proof }];
    },

    /** El celular demuestra lo mismo, y recibe su secreto cifrado con el código. */
    pairFinish({ clientNonce, serverNonce, proof, name }) {
      if (!activePairing()) return [404, { error: 'No hay un emparejamiento abierto' }];
      const nonces = `${clientNonce}|${serverNonce}`;
      const expected = hmac(pairing.code, `device|${nonces}`).toString('hex');
      if (!isNonce(clientNonce) || serverNonce !== pairing.serverNonce || !sameBytes(proof, expected)) {
        failPairing();
        return [403, { error: 'El código no coincide' }];
      }
      const secretBytes = randomBytes(32);
      const key = hmac(pairing.code, `seal|${nonces}`);
      const sealedSecret = Buffer.from(secretBytes.map((byte, index) => byte ^ key[index])).toString('hex');
      const device = {
        id: randomBytes(16).toString('hex'),
        name: cleanDeviceName(name) || 'Celular',
        secret: secretBytes.toString('hex'),
        createdAt: new Date(now()).toISOString(),
      };
      data.devices.push(device);
      pairing = null;
      save();
      return [200, { deviceId: device.id, sealedSecret }];
    },

    /** Con esto la app comprueba que habla con su PC, antes de mandar nada. También sirve para buscarla. */
    identify({ deviceId, clientNonce }) {
      const device = data.devices.find((candidate) => candidate.id === deviceId);
      if (!device || !isNonce(clientNonce)) return [404, { error: 'Dispositivo desconocido' }];
      return [200, { proof: hmac(device.secret, `pc|${clientNonce}`).toString('hex') }];
    },

    login({ deviceId, user, password }) {
      const device = data.devices.find((candidate) => candidate.id === deviceId);
      if (!device) return [403, { error: 'Este celular no está emparejado' }];
      if (!data.hash) return [403, { error: 'Falta crear la contraseña en la app de la PC' }];
      const failures = loginFailures.get(deviceId);
      if (failures && failures.count >= LOGIN_MAX_FAILURES && now() < failures.until) {
        return [429, { error: 'Demasiados intentos. Esperá un minuto.' }];
      }
      const good =
        typeof password === 'string' &&
        password.length <= 1024 &&
        sameBytes(user, data.user) &&
        sameBytes(hashPassword(password, data.salt), data.hash);
      if (!good) {
        const count = failures && now() < failures.until ? failures.count + 1 : 1;
        loginFailures.set(deviceId, { count, until: now() + LOGIN_LOCK_MS });
        return [401, { error: 'Usuario o contraseña incorrectos' }];
      }
      loginFailures.delete(deviceId);
      const token = randomBytes(32).toString('hex');
      data.sessions = data.sessions.filter((session) => now() < session.expires);
      data.sessions.push({ tokenHash: sha256(token), deviceId, expires: now() + SESSION_MS });
      save();
      return [200, { token }];
    },

    /**
     * La contraseña del panel, pedida de nuevo para algo irreversible (borrar un pedido). Vale también desde esta PC,
     * donde no se pide login, y tiene su propio límite de intentos.
     */
    verifyAdmin({ password } = {}) {
      if (!data.hash) return [403, { error: 'Primero creá la contraseña del panel en Settings, en la app de la PC' }];
      const failures = loginFailures.get('admin');
      if (failures && failures.count >= LOGIN_MAX_FAILURES && now() < failures.until) {
        return [429, { error: 'Demasiados intentos. Esperá un minuto.' }];
      }
      const good =
        typeof password === 'string' && password.length <= 1024 && sameBytes(hashPassword(password, data.salt), data.hash);
      if (!good) {
        const count = failures && now() < failures.until ? failures.count + 1 : 1;
        loginFailures.set('admin', { count, until: now() + LOGIN_LOCK_MS });
        return [401, { error: 'Contraseña incorrecta' }];
      }
      loginFailures.delete('admin');
      return [200, { ok: true }];
    },

    isValidToken(token) {
      if (typeof token !== 'string') return false;
      const tokenHash = sha256(token);
      return data.sessions.some(
        (session) =>
          sameBytes(session.tokenHash, tokenHash) &&
          now() < session.expires &&
          data.devices.some((device) => device.id === session.deviceId),
      );
    },

    logout(token) {
      const tokenHash = sha256(String(token));
      data.sessions = data.sessions.filter((session) => session.tokenHash !== tokenHash);
      save();
    },

    renameDevice(id, { name } = {}) {
      const device = data.devices.find((candidate) => candidate.id === id);
      if (!device) return [404, { error: 'No existe' }];
      const clean = cleanDeviceName(name);
      if (!clean) return [400, { error: 'Falta el nombre' }];
      device.name = clean;
      save();
      return [200, { ok: true, name: clean }];
    },

    removeDevice(id) {
      const before = data.devices.length;
      data.devices = data.devices.filter((device) => device.id !== id);
      data.sessions = data.sessions.filter((session) => session.deviceId !== id);
      if (data.devices.length === before) return [404, { error: 'No existe' }];
      save();
      return [200, { ok: true }];
    },
  };
}

// --- Pausar descargas. Requiere que qBittorrent no pida contraseña desde esta PC ---

const QBITTORRENT_NEEDS_BYPASS =
  'qBittorrent pide su contraseña. En sus Opciones, sección Web UI, activá "Omitir autenticación para clientes en localhost".';
const STOPPED_STATES = new Set(['stoppedDL', 'stoppedUP', 'pausedDL', 'pausedUP']);

function readPausedHashes(file) {
  try {
    const hashes = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(hashes) ? hashes : [];
  } catch {
    return [];
  }
}

function writePausedHashes(file, hashes) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(hashes));
}

/**
 * Frena lo que esté activo y recuerda cuáles fueron: reanudar no arranca lo que ya estaba frenado a mano.
 */
export function createDownloadControl(config) {
  const base = `${config.services.qbittorrent.url}/api/v2`;
  const file = config.pauseFile;
  let busy = false;

  function failure(response) {
    if (response.status === 403) throw new ProbeError('error', QBITTORRENT_NEEDS_BYPASS);
    throw new ProbeError('error', `qBittorrent respondió HTTP ${response.status}`);
  }

  async function request(pathname, options = {}) {
    try {
      return await fetch(`${base}${pathname}`, { redirect: 'manual', signal: AbortSignal.timeout(config.httpTimeoutMs), ...options });
    } catch {
      throw new ProbeError('down', 'qBittorrent no responde');
    }
  }

  /** qBittorrent 5 usa stop y start; los anteriores, pause y resume. */
  async function applyTo(hashes, verb, oldVerb) {
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hashes.join('|') }).toString(),
    };
    let response = await request(`/torrents/${verb}`, options);
    if (response.status === 404) response = await request(`/torrents/${oldVerb}`, options);
    if (!response.ok) failure(response);
  }

  const actions = {
    async pause() {
      const response = await request('/torrents/info');
      if (!response.ok) failure(response);
      const torrents = await response.json();
      const hashes = torrents.filter((torrent) => !STOPPED_STATES.has(torrent.state)).map((torrent) => torrent.hash);
      if (hashes.length) await applyTo(hashes, 'stop', 'pause');
      writePausedHashes(file, [...new Set([...readPausedHashes(file), ...hashes])]);
      return hashes.length === 1 ? '1 torrent en pausa' : `${hashes.length} torrents en pausa`;
    },
    async resume() {
      const hashes = readPausedHashes(file);
      if (hashes.length) await applyTo(hashes, 'start', 'resume');
      writePausedHashes(file, []);
      return 'Descargas reanudadas';
    },
  };

  return async function control(action) {
    if (!Object.hasOwn(actions, action)) return { status: 404 };
    if (busy) return { status: 409, ok: false, message: 'Ya hay una acción en curso' };
    busy = true;
    try {
      return { status: 200, ok: true, message: await actions[action]() };
    } catch (error) {
      return { status: 200, ok: false, message: error instanceof ProbeError ? error.message : 'No se pudo hacer' };
    } finally {
      busy = false;
    }
  };
}

// --- Borrar un pedido: la única excepción a "no mover, renombrar ni borrar nada de la biblioteca" ---
// Lo pidió la usuaria el 2026-11-09: solo ella controla la app. Saca el pedido de cada paso al que llegó (buzón del bot,
// Seerr, cola de qBittorrent, Radarr o Sonarr con su archivo) y le pide a Jellyfin que revise. Todas las comprobaciones
// de que algo es un pedido se hacen acá, nunca en la interfaz:
// - Película: monitoreada y en su propia carpeta dentro de F:\Movies\_inbox, donde entran los pedidos de Seerr y del bot.
//   La biblioteca existente está en las otras carpetas de F:\Movies y sin monitorear.
// - Serie: monitoreada y en su propia carpeta dentro de F:\Series. Solo se borran archivos de episodios que Sonarr registra
//   como importados de una descarga; lo importado de la biblioteca nunca tiene ese registro. La serie entera, solo si todos
//   sus archivos entraron así.

export const REQUEST_ROOTS = { movie: 'F:\\Movies\\_inbox', tv: 'F:\\Series' };
const CONFIRM_MS = 3 * 60 * 1000;
const MAILBOX_CONFIG = path.join(os.homedir(), '.pelis-bot', 'config.json');
const JELLYFIN_KEY_FILE = path.join(os.homedir(), '.lp-media-center', 'jellyfin.key');
const IMPORT_EVENT = 'downloadFolderImported';

class NotARequest extends Error {}

/** Si `folder` es la carpeta propia de un título directamente dentro de `root`, sin subir ni bajar de nivel. */
export function isTitleFolder(folder, root) {
  if (typeof folder !== 'string' || !folder || folder.includes('..')) return false;
  const clean = path.win32.normalize(folder).replace(/\\+$/, '');
  return path.win32.dirname(clean).toLowerCase() === root.toLowerCase() && path.win32.basename(clean) !== '';
}

/** Si `file` está dentro de `folder`. */
export function isInsideFolder(file, folder) {
  if (typeof file !== 'string' || typeof folder !== 'string' || file.includes('..')) return false;
  return path.win32.normalize(file).toLowerCase().startsWith(path.win32.normalize(folder).replace(/\\+$/, '').toLowerCase() + '\\');
}

/** El id que lista la interfaz: Seerr (número), Radarr o Sonarr ("radarr-12"), o algo que sigue en el buzón. */
export function parseRequestId(id) {
  let match;
  if ((match = /^(\d{1,9})$/.exec(id))) return { origin: 'seerr', seerrId: Number(match[1]) };
  if ((match = /^(radarr|sonarr)-(\d{1,9})$/.exec(id))) {
    return { origin: 'telegram', kind: match[1] === 'radarr' ? 'movie' : 'tv', arrId: Number(match[2]) };
  }
  // Lo que se está bajando (Downloads): se busca por tmdbId en Radarr o Sonarr, con la comprobación estricta.
  if ((match = /^cola-(movie|tv)-(\d{1,9})$/.exec(id))) return { origin: 'cola', kind: match[1], tmdbId: Number(match[2]) };
  if ((match = /^buzon-(movie|tv)-(\d{1,9})-(\d{1,9})$/.exec(id))) {
    return { origin: 'telegram', kind: match[1], mailboxId: Number(match[2]), tmdbId: Number(match[3]) };
  }
  return null;
}

export function createRequestRemover(
  config,
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    mailboxConfigFile = MAILBOX_CONFIG,
    jellyfinKeyFile = JELLYFIN_KEY_FILE,
    roots = REQUEST_ROOTS,
    takenRetries = 3,
  } = {},
) {
  const confirmations = new Map();
  let busy = false;

  async function call(url, { method = 'GET', headers = {}, body } = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: 'manual',
        headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(config.httpTimeoutMs * 4),
      });
    } catch {
      throw new ProbeError('down', 'No responde');
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new ProbeError('error', `Respondió HTTP ${response.status}`);
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ProbeError('error', 'Respondió algo que no se pudo leer');
    }
  }

  const arrKeys = {};
  async function arr(source, pathname, options = {}) {
    const service = config.services[source];
    arrKeys[source] ??= await readXmlApiKey(service.keyFile);
    return call(`${service.url}/api/v3${pathname}`, { ...options, headers: { 'X-Api-Key': arrKeys[source] } });
  }

  async function seerr(pathname, options = {}) {
    const service = config.services.seerr;
    const key = await readSeerrApiKey(service.keyFile);
    return call(`${service.url}/api/v1${pathname}`, { ...options, headers: { 'X-Api-Key': key } });
  }

  async function findMovie(ref) {
    if (ref.arrId) return arr('radarr', `/movie/${ref.arrId}`);
    if (!ref.tmdbId) return null;
    const list = await arr('radarr', `/movie?tmdbId=${ref.tmdbId}`);
    return (Array.isArray(list) ? list : []).find((movie) => movie.tmdbId === ref.tmdbId) ?? null;
  }

  async function findSeries(ref) {
    if (ref.arrId) return arr('sonarr', `/series/${ref.arrId}`);
    const all = await arr('sonarr', '/series');
    return (
      (Array.isArray(all) ? all : []).find(
        (series) => (ref.tvdbId && series.tvdbId === ref.tvdbId) || (ref.tmdbId && series.tmdbId === ref.tmdbId),
      ) ?? null
    );
  }

  /** Película de un pedido: qué torrents y qué carpeta se van. Null si no está en Radarr. */
  async function moviePart(ref, strict) {
    const movie = await findMovie(ref);
    if (!movie) return null;
    if (!movie.monitored || !isTitleFolder(movie.path, roots.movie)) {
      if (strict) throw new NotARequest(`${movie.title ?? 'Esta película'} no figura como pedido: está en la biblioteca. No se borra.`);
      return { skipped: `Radarr: ${movie.title ?? 'la película'} está en la biblioteca, no se toca.` };
    }
    const file = movie.hasFile ? movie.movieFile?.path ?? null : null;
    if (file && !isInsideFolder(file, movie.path)) throw new NotARequest('El archivo no está en la carpeta de la película. No se borra.');
    const queue = await arr('radarr', `/queue?movieIds=${movie.id}&pageSize=100`);
    const queueIds = (queue?.records ?? []).filter((record) => record.movieId === movie.id).map((record) => record.id);
    return { source: 'radarr', id: movie.id, title: movie.title, folder: movie.path, files: file ? [file] : [], queueIds, whole: true };
  }

  /** Serie de un pedido: la serie entera o solo los episodios que entraron por una descarga. */
  async function seriesPart(ref, strict) {
    const series = await findSeries(ref);
    if (!series) return null;
    if (!series.monitored || !isTitleFolder(series.path, roots.tv)) {
      if (strict) throw new NotARequest(`${series.title ?? 'Esta serie'} no figura como pedido: está en la biblioteca. No se borra.`);
      return { skipped: `Sonarr: ${series.title ?? 'la serie'} está en la biblioteca, no se toca.` };
    }
    const [episodes, files, history, queue] = await Promise.all([
      arr('sonarr', `/episode?seriesId=${series.id}`),
      arr('sonarr', `/episodefile?seriesId=${series.id}`),
      arr('sonarr', `/history/series?seriesId=${series.id}&eventType=${IMPORT_EVENT}`),
      arr('sonarr', `/queue?seriesIds=${series.id}&pageSize=200`),
    ]);
    const downloaded = new Set((Array.isArray(history) ? history : []).filter((event) => event.eventType === IMPORT_EVENT).map((event) => event.episodeId));
    const allEpisodes = Array.isArray(episodes) ? episodes : [];
    const allFiles = Array.isArray(files) ? files : [];
    const requestedFileIds = new Set(
      allEpisodes.filter((episode) => episode.hasFile && downloaded.has(episode.id)).map((episode) => episode.episodeFileId),
    );
    const whole = allFiles.every((file) => requestedFileIds.has(file.id));
    const doomed = allFiles.filter((file) => requestedFileIds.has(file.id));
    for (const file of doomed) {
      if (!isInsideFolder(file.path, series.path)) throw new NotARequest('Un archivo no está en la carpeta de la serie. No se borra.');
    }
    // Además de lo bajado, deja de buscar lo que falta: los episodios monitoreados sin archivo.
    const unmonitor = allEpisodes
      .filter((episode) => (episode.hasFile && requestedFileIds.has(episode.episodeFileId)) || (episode.monitored && !episode.hasFile))
      .map((episode) => episode.id);
    const queueIds = (queue?.records ?? []).filter((record) => record.seriesId === series.id).map((record) => record.id);
    return {
      source: 'sonarr',
      id: series.id,
      title: series.title,
      folder: series.path,
      files: doomed.map((file) => file.path),
      fileIds: doomed.map((file) => file.id),
      unmonitor,
      queueIds,
      whole,
      keptFiles: allFiles.length - doomed.length,
    };
  }

  function readMailbox() {
    try {
      const { mailboxUrl, mailboxKey } = JSON.parse(readFileSync(mailboxConfigFile, 'utf8'));
      if (typeof mailboxUrl !== 'string' || !/^https:\/\//.test(mailboxUrl) || typeof mailboxKey !== 'string' || !mailboxKey) return null;
      return { url: mailboxUrl.replace(/\/+$/, ''), key: mailboxKey };
    } catch {
      return null;
    }
  }

  /** Arma lo que se va a borrar, sin tocar nada. Falla con NotARequest si no se puede asegurar que es un pedido. */
  async function buildPlan(id) {
    const ref = parseRequestId(id);
    if (!ref) throw new NotARequest('Ese pedido no existe');
    const plan = { id, title: null, kind: ref.kind, mailbox: null, seerr: null, arr: null, notes: [] };
    if (ref.origin === 'seerr') {
      const request = await seerr(`/request/${ref.seerrId}`);
      if (!request) throw new NotARequest('Ese pedido ya no está en Seerr');
      ref.kind = request.type === 'tv' ? 'tv' : 'movie';
      ref.tmdbId = request.media?.tmdbId ?? null;
      ref.tvdbId = request.media?.tvdbId ?? null;
      plan.kind = ref.kind;
      plan.seerr = { id: ref.seerrId };
    }
    if (ref.origin === 'cola') {
      // Si vino de Seerr, su pedido también se borra.
      const page = await seerr('/request?take=100&skip=0&filter=all&sort=added');
      const match = (page?.results ?? []).find(
        (request) => request.media?.tmdbId === ref.tmdbId && (request.type === 'tv' ? 'tv' : 'movie') === ref.kind,
      );
      if (match) plan.seerr = { id: match.id };
    }
    if (ref.mailboxId) plan.mailbox = { kind: ref.kind, id: ref.mailboxId, tmdbId: ref.tmdbId };
    // Lo que viene de Telegram o de la cola solo existe como pedido en Radarr o Sonarr: ahí la comprobación es estricta.
    const strict = (ref.origin === 'telegram' && !ref.mailboxId) || ref.origin === 'cola';
    const part = ref.kind === 'tv' ? await seriesPart(ref, strict) : await moviePart(ref, strict);
    if (strict && !part) throw new NotARequest('Ya no está en Radarr ni en Sonarr');
    if (part?.skipped) plan.notes.push(part.skipped);
    else plan.arr = part;
    plan.title = plan.arr?.title ?? (ref.origin === 'seerr' ? `Pedido ${ref.seerrId} de Seerr` : 'Pedido del bot');
    if (ref.origin === 'seerr' && part === null) plan.notes.push('Todavía no llegó a Radarr ni a Sonarr.');
    return plan;
  }

  /** Lo que ve la usuaria antes de confirmar: cada paso y cada archivo, sin claves ni direcciones internas. */
  function describe(plan) {
    const steps = [];
    if (plan.mailbox) steps.push('Cancelar el pedido que espera en el buzón del bot');
    if (plan.seerr) steps.push('Borrar el pedido en Seerr');
    const a = plan.arr;
    if (a) {
      const program = a.source === 'radarr' ? 'Radarr' : 'Sonarr';
      if (a.queueIds.length) steps.push(`Sacar ${a.queueIds.length === 1 ? 'el torrent' : `${a.queueIds.length} torrents`} de qBittorrent, con lo que ya se bajó`);
      if (a.whole) steps.push(`Borrar ${a.source === 'radarr' ? 'la película' : 'la serie'} de ${program}, con su carpeta: ${a.folder}`);
      else {
        steps.push(`Borrar de ${program} ${a.files.length === 1 ? 'el episodio pedido' : `los ${a.files.length} episodios pedidos`} y dejar de buscar los que faltan`);
        steps.push(`Se conservan ${a.keptFiles === 1 ? '1 episodio que ya estaba' : `${a.keptFiles} episodios que ya estaban`} en la biblioteca`);
      }
      steps.push('Pedirle a Jellyfin que revise la biblioteca');
    }
    return { title: plan.title, steps, files: plan.arr?.files ?? [], notes: plan.notes, deletesFiles: Boolean(plan.arr?.files.length) };
  }

  const fingerprint = (plan) => sha256(JSON.stringify(plan));

  async function cancelInMailbox(mailbox) {
    const box = readMailbox();
    if (!box) return { ok: false, message: 'No se encontró la configuración del buzón del bot en esta PC.' };
    const route = mailbox.kind === 'tv' ? `/api/series/requests/${mailbox.id}/cancel` : `/api/requests/${mailbox.id}/cancel`;
    let result;
    try {
      result = await call(`${box.url}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${box.key}` }, body: {} });
    } catch {
      result = undefined;
    }
    if (!result || typeof result.cancelled !== 'boolean') {
      return { ok: false, unpublished: true, message: 'El buzón todavía no acepta cancelar: el pedido sigue esperando ahí.' };
    }
    if (result.cancelled) return { ok: true, message: 'Cancelado en el buzón del bot' };
    return { ok: true, taken: true, message: 'La PC ya lo había tomado del buzón' };
  }

  async function removeFromArr(a) {
    const program = a.source === 'radarr' ? 'Radarr' : 'Sonarr';
    const results = [];
    for (const queueId of a.queueIds) {
      await arr(a.source, `/queue/${queueId}?removeFromClient=true&blocklist=false`, { method: 'DELETE' });
    }
    if (a.queueIds.length) results.push({ ok: true, message: `Torrents sacados de qBittorrent: ${a.queueIds.length}` });
    if (a.whole) {
      const kind = a.source === 'radarr' ? 'movie' : 'series';
      await arr(a.source, `/${kind}/${a.id}?deleteFiles=true&addImportExclusion=false`, { method: 'DELETE' });
      results.push({ ok: true, message: `${a.title} borrada de ${program}, con su carpeta` });
    } else {
      for (const fileId of a.fileIds) await arr('sonarr', `/episodefile/${fileId}`, { method: 'DELETE' });
      if (a.unmonitor.length) await arr('sonarr', '/episode/monitor', { method: 'PUT', body: { episodeIds: a.unmonitor, monitored: false } });
      results.push({ ok: true, message: `Episodios pedidos borrados de ${program}: ${a.fileIds.length}` });
    }
    return results;
  }

  async function refreshJellyfin() {
    let key;
    try {
      key = readFileSync(jellyfinKeyFile, 'utf8').trim();
    } catch {
      key = '';
    }
    if (!key) return { ok: true, skipped: true, message: 'Jellyfin lo va a notar en su próxima revisión: falta una clave de Jellyfin para pedírselo ya.' };
    try {
      await call(`${config.services.jellyfin.url}/Library/Refresh`, { method: 'POST', headers: { 'X-Emby-Token': key } });
      return { ok: true, message: 'Jellyfin está revisando la biblioteca' };
    } catch (error) {
      return { ok: false, message: `Jellyfin no pudo revisar la biblioteca: ${error.message}` };
    }
  }

  /** Paso por paso. Si uno falla, se corta ahí y el resultado dice qué se hizo y qué no. */
  async function execute(plan) {
    const results = [];
    const step = async (failureLabel, run) => {
      try {
        await run();
        return true;
      } catch (error) {
        results.push({ ok: false, message: `${failureLabel}: ${error.message || 'falló'}. Lo anterior ya quedó hecho; lo que sigue, no.` });
        return false;
      }
    };
    let arrPart = plan.arr;
    if (plan.mailbox) {
      const result = await cancelInMailbox(plan.mailbox);
      results.push(result);
      if (result.unpublished && !arrPart) return results;
      // Si la PC ya lo tomó, puede estar llegando a Radarr o Sonarr: se vuelve a mirar unos segundos después.
      if (result.taken && !arrPart) {
        for (let attempt = 0; attempt < takenRetries && !arrPart; attempt++) {
          await sleep(5000);
          const ref = { kind: plan.kind, tmdbId: plan.mailbox.tmdbId };
          const part = plan.kind === 'tv' ? await seriesPart(ref, false) : await moviePart(ref, false);
          if (part?.skipped) results.push({ ok: true, message: part.skipped });
          if (part && !part.skipped) arrPart = part;
          if (part?.skipped) break;
        }
        if (!arrPart && !results.some((result) => result.message?.includes('no se toca'))) {
          results.push({ ok: false, message: 'La PC lo tomó pero todavía no aparece en Radarr ni en Sonarr. Probá borrarlo de nuevo en un rato.' });
        }
      }
    }
    if (plan.seerr) {
      const done = await step('No se pudo borrar el pedido en Seerr', () => seerr(`/request/${plan.seerr.id}`, { method: 'DELETE' }));
      if (!done) return results;
      results.push({ ok: true, message: 'Pedido borrado en Seerr' });
    }
    if (arrPart) {
      const program = arrPart.source === 'radarr' ? 'Radarr' : 'Sonarr';
      const done = await step(`No se pudo terminar en ${program}`, async () => results.push(...(await removeFromArr(arrPart))));
      if (!done) return results;
      results.push(await refreshJellyfin());
    }
    return results;
  }

  return {
    /** Después de verificar la contraseña: qué se va a borrar y un código para confirmarlo, que vence en 3 minutos. */
    async plan(id) {
      try {
        const plan = await buildPlan(id);
        const token = randomBytes(24).toString('hex');
        for (const [key, entry] of confirmations) if (now() > entry.expires) confirmations.delete(key);
        confirmations.set(token, { id, fingerprint: fingerprint(plan), expires: now() + CONFIRM_MS });
        return [200, { token, plan: describe(plan) }];
      } catch (error) {
        if (error instanceof NotARequest) return [409, { error: error.message }];
        return [502, { error: `No se pudo revisar el pedido: ${error.message || 'falló una consulta'}` }];
      }
    },

    /** Borra, solo si nada cambió desde la confirmación. Devuelve el resultado de cada paso. */
    async remove(id, { token } = {}) {
      const entry = typeof token === 'string' ? confirmations.get(token) : null;
      if (!entry || entry.id !== id || now() > entry.expires) return [403, { error: 'La confirmación venció. Empezá de nuevo.' }];
      confirmations.delete(token);
      if (busy) return [409, { error: 'Ya se está borrando otro pedido' }];
      busy = true;
      try {
        const plan = await buildPlan(id);
        if (fingerprint(plan) !== entry.fingerprint) return [409, { error: 'Algo cambió desde que confirmaste. Revisalo de nuevo.' }];
        const results = await execute(plan);
        return [200, { ok: results.every((result) => result.ok), results }];
      } catch (error) {
        if (error instanceof NotARequest) return [409, { error: error.message }];
        return [502, { error: `Se cortó a mitad del borrado: ${error.message || 'falló una consulta'}. Revisá el pedido antes de reintentar.` }];
      } finally {
        busy = false;
      }
    },
  };
}

// --- Importar a mano una descarga trabada ---
// Radarr o Sonarr frenan la importación cuando no pueden confirmar que el archivo es lo pedido (por ejemplo, un nombre con
// dos años). Es lo mismo que su "Manual Import": se importa como el título para el que se pidió la descarga. No borra nada.

const BLOCKED_STATES = new Set(['importBlocked', 'importPending']);

export function createImporter(config, { fetchImpl = fetch } = {}) {
  let busy = false;

  async function arr(source, pathname, { method = 'GET', body } = {}) {
    const service = config.services[source];
    const key = await readXmlApiKey(service.keyFile);
    let response;
    try {
      response = await fetchImpl(`${service.url}/api/v3${pathname}`, {
        method,
        redirect: 'manual',
        headers: body ? { 'X-Api-Key': key, 'Content-Type': 'application/json' } : { 'X-Api-Key': key },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(config.httpTimeoutMs * 5),
      });
    } catch {
      throw new ProbeError('down', 'No responde');
    }
    if (!response.ok) throw new ProbeError('error', `Respondió HTTP ${response.status}`);
    return response.json();
  }

  /** La descarga trabada y los archivos que Radarr o Sonarr proponen importar. */
  async function inspect(source, downloadId) {
    const program = source === 'radarr' ? 'Radarr' : 'Sonarr';
    const queue = await arr(source, `/queue?pageSize=200&include${source === 'radarr' ? 'Movie' : 'Series'}=true`);
    const record = (queue?.records ?? []).find((item) => item.downloadId === downloadId);
    if (!record) throw new NotARequest(`Ya no está en la cola de ${program}.`);
    if (!BLOCKED_STATES.has(record.trackedDownloadState)) throw new NotARequest('Esa descarga no está esperando una importación manual.');
    const target = source === 'radarr' ? record.movie : record.series;
    const targetId = source === 'radarr' ? record.movieId : record.seriesId;
    if (!target || !targetId) throw new NotARequest(`${program} no sabe para qué título era esta descarga.`);
    const scope = source === 'radarr' ? `movieId=${targetId}` : `seriesId=${targetId}`;
    const candidates = await arr(source, `/manualimport?downloadId=${encodeURIComponent(downloadId)}&${scope}&filterExistingFiles=true`);
    const files = (Array.isArray(candidates) ? candidates : []).filter(
      (file) => file.path && !(file.rejections ?? []).some((rejection) => /sample/i.test(rejection.reason ?? '')),
    );
    if (!files.length) throw new NotARequest(`${program} no encontró archivos para importar. Hacelo desde ${program}.`);
    if (source === 'sonarr' && files.some((file) => !file.episodes?.length)) {
      throw new NotARequest('Sonarr no sabe a qué episodio corresponde algún archivo. Hacelo desde Sonarr, en Manual Import.');
    }
    const title = target.year ? `${target.title} (${target.year})` : target.title;
    return { source, program, record, targetId, title, files };
  }

  return {
    async plan(source, downloadId) {
      try {
        const { program, title, record, files } = await inspect(source, downloadId);
        return [200, {
          program,
          title,
          release: record.title ?? null,
          files: files.map((file) => ({ name: file.relativePath ?? file.name ?? path.win32.basename(file.path), size: file.size ?? null })),
          reasons: [...new Set((record.statusMessages ?? []).flatMap((message) => message.messages ?? []))],
        }];
      } catch (error) {
        return [error instanceof NotARequest ? 409 : 502, { error: error.message || 'No se pudo revisar' }];
      }
    },

    async run(source, downloadId) {
      if (busy) return [409, { error: 'Ya hay una importación en curso' }];
      busy = true;
      try {
        const { program, title, targetId, files } = await inspect(source, downloadId);
        const common = (file) => ({ path: file.path, quality: file.quality, languages: file.languages, releaseGroup: file.releaseGroup, downloadId });
        const list = files.map((file) =>
          source === 'radarr'
            ? { ...common(file), movieId: targetId }
            : { ...common(file), seriesId: targetId, episodeIds: file.episodes.map((episode) => episode.id) },
        );
        await arr(source, '/command', { method: 'POST', body: { name: 'ManualImport', importMode: 'auto', files: list } });
        return [200, { ok: true, message: `${program} está importando ${title}. En un momento pasa a la biblioteca.` }];
      } catch (error) {
        return [error instanceof NotARequest ? 409 : 502, { error: error.message || 'No se pudo importar' }];
      } finally {
        busy = false;
      }
    },
  };
}

// --- Servidor HTTP ---

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Direcciones de las que se acepta un pedido: esta PC, la red local y Tailscale. */
function remoteKind(address = '') {
  const plain = address.toLowerCase().replace(/^::ffff:/, '');
  if (plain === '::1' || plain.startsWith('127.')) return 'local';
  if (isTailscaleAddress(plain) || isPrivateIpv4(plain)) return 'network';
  return 'outside';
}

/** Frena el DNS rebinding: el Host tiene que ser una IP privada o local, nunca un nombre ajeno. */
function isAllowedHost(host = '', port) {
  const match = /^([^:]+):(\d+)$/.exec(host);
  if (!match || Number(match[2]) !== port) return false;
  const name = match[1].toLowerCase();
  if (name === 'localhost') return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return false;
  return remoteKind(name) !== 'outside';
}

class BadRequest extends Error {}

function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BadRequest('Pedido demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('forma');
        resolve(value);
      } catch {
        reject(new BadRequest('Pedido inválido'));
      }
    });
    req.on('error', reject);
  });
}

export function createApp(collect, { allowedOrigins, act = null, auth = null, downloads = null, requests = null, imports = null }) {
  let inFlight = null;

  // Dos pedidos simultáneos comparten la misma consulta a los programas.
  function collectShared() {
    inFlight ??= collect().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function handle(req, res, pathname, kind, origin) {
    const isLocal = kind === 'local';
    const post = req.method === 'POST';

    // Sin sesión, desde la red: lo justo para emparejar, reconocer a la PC e iniciar sesión.
    if (auth && post && pathname === '/api/pair/start') return sendJson(res, ...auth.pairStart(await readJsonBody(req)));
    if (auth && post && pathname === '/api/pair/finish') return sendJson(res, ...auth.pairFinish(await readJsonBody(req)));
    if (auth && post && pathname === '/api/identify') return sendJson(res, ...auth.identify(await readJsonBody(req)));
    if (auth && post && pathname === '/api/login') return sendJson(res, ...auth.login(await readJsonBody(req)));

    // La configuración de login y dispositivos solo se toca desde la app de esta PC.
    if (auth && pathname.startsWith('/api/setup')) {
      if (!isLocal || origin === undefined) return sendJson(res, 403, { error: 'Solo desde la app de la PC' });
      if (req.method === 'GET' && pathname === '/api/setup') return sendJson(res, 200, auth.setupStatus());
      if (post && pathname === '/api/setup/password') return sendJson(res, ...auth.setPassword(await readJsonBody(req)));
      if (post && pathname === '/api/setup/pairing') return sendJson(res, 200, auth.newPairing());
      const remove = /^\/api\/setup\/devices\/([a-f0-9]+)\/remove$/.exec(pathname);
      if (post && remove) return sendJson(res, ...auth.removeDevice(remove[1]));
      const rename = /^\/api\/setup\/devices\/([a-f0-9]+)\/rename$/.exec(pathname);
      if (post && rename) return sendJson(res, ...auth.renameDevice(rename[1], await readJsonBody(req)));
      return sendJson(res, 404, { error: 'No existe' });
    }

    // De acá en adelante, desde afuera de la PC hace falta sesión.
    if (!isLocal) {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!auth?.isValidToken(token)) return sendJson(res, 401, { error: 'Hace falta iniciar sesión' });
      if (post && pathname === '/api/logout') {
        auth.logout(token);
        return sendJson(res, 200, { ok: true });
      }
    }

    // Las acciones solo se aceptan de la app: sin Origin permitido no hay acción.
    const actionRoute = /^\/api\/parts\/([a-z]+)\/(start|stop)$/.exec(pathname);
    if (actionRoute && act) {
      if (!post) {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, { error: 'Solo POST' });
      }
      if (origin === undefined) return sendJson(res, 403, { error: 'Origen no permitido' });
      const { status, ...body } = await act(actionRoute[1], actionRoute[2], {
        remoteAddress: req.socket.remoteAddress,
      });
      return sendJson(res, status, status === 404 ? { error: 'No existe' } : body);
    }

    // Borrar un pedido: primero la contraseña del panel y el plan, después el borrado con el código de confirmación.
    const requestRoute = /^\/api\/requests\/([a-z0-9-]{1,40})\/(plan|delete)$/.exec(pathname);
    if (requestRoute && requests && auth) {
      if (!post) return sendJson(res, 405, { error: 'Solo POST' });
      if (origin === undefined) return sendJson(res, 403, { error: 'Origen no permitido' });
      const body = await readJsonBody(req);
      if (requestRoute[2] === 'plan') {
        const [status, verdict] = auth.verifyAdmin(body);
        if (status !== 200) return sendJson(res, status, verdict);
        return sendJson(res, ...(await requests.plan(requestRoute[1])));
      }
      return sendJson(res, ...(await requests.remove(requestRoute[1], body)));
    }

    // Importar a mano una descarga trabada: solo desde la app de esta PC, como pidió la usuaria.
    const importRoute = /^\/api\/imports\/(radarr|sonarr)\/([A-Za-z0-9]{1,64})\/(plan|run)$/.exec(pathname);
    if (importRoute && imports) {
      if (!post) return sendJson(res, 405, { error: 'Solo POST' });
      if (!isLocal || origin === undefined) return sendJson(res, 403, { error: 'Solo desde la app de la PC' });
      const [, source, downloadId, step] = importRoute;
      return sendJson(res, ...(await (step === 'plan' ? imports.plan(source, downloadId) : imports.run(source, downloadId))));
    }

    const downloadsRoute = /^\/api\/downloads\/([a-z]+)$/.exec(pathname);
    if (downloadsRoute && downloads) {
      if (!post) return sendJson(res, 405, { error: 'Solo POST' });
      if (origin === undefined) return sendJson(res, 403, { error: 'Origen no permitido' });
      const { status, ...body } = await downloads(downloadsRoute[1]);
      return sendJson(res, status, status === 404 ? { error: 'No existe' } : body);
    }

    if (pathname !== '/api/status') return sendJson(res, 404, { error: 'No existe' });
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { error: 'Solo GET' });
    }
    return sendJson(res, 200, await collectShared());
  }

  const server = http.createServer(async (req, res) => {
    const kind = remoteKind(req.socket.remoteAddress);
    if (kind === 'outside') return sendJson(res, 403, { error: 'Dirección no permitida' });
    if (!isAllowedHost(req.headers.host, server.address().port)) return sendJson(res, 403, { error: 'Host no permitido' });

    const { origin } = req.headers;
    res.setHeader('Vary', 'Origin');
    if (origin !== undefined) {
      if (!allowedOrigins.includes(origin)) return sendJson(res, 403, { error: 'Origen no permitido' });
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    if (req.method === 'OPTIONS') {
      if (origin === undefined) return sendJson(res, 405, { error: 'Sin origen' });
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (req.headers['access-control-request-local-network']) res.setHeader('Access-Control-Allow-Local-Network', 'true');
      res.writeHead(204).end();
      return undefined;
    }

    const { pathname } = new URL(req.url, 'http://backend');
    try {
      return await handle(req, res, pathname, kind, origin);
    } catch (error) {
      if (res.headersSent) return undefined;
      if (error instanceof BadRequest) return sendJson(res, 400, { error: error.message });
      return sendJson(res, 500, { error: 'No se pudo responder' });
    }
  });
  return server;
}

export function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

// Se inicia solo al ejecutarlo; los tests importan este archivo sin abrir el puerto.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createApp(createCollector(DEFAULT_CONFIG, { mailbox: createMailboxReader() }), {
    allowedOrigins: ALLOWED_ORIGINS,
    act: createController(DEFAULT_CONFIG),
    auth: createAuth(),
    downloads: createDownloadControl(DEFAULT_CONFIG),
    requests: createRequestRemover(DEFAULT_CONFIG),
    imports: createImporter(DEFAULT_CONFIG),
  });
  try {
    await listen(server, HOST, PORT);
    console.log(`Backend de LP Media Center en el puerto ${PORT}`);
  } catch (error) {
    console.error(
      error.code === 'EADDRINUSE'
        ? `El puerto ${PORT} ya está en uso: el backend puede estar corriendo.`
        : `No se pudo iniciar el backend: ${error.message}`,
    );
    process.exitCode = 1;
  }
}

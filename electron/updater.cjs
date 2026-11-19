// Actualiza la app de Windows sola: baja el instalador de la última versión publicada en GitHub, comprueba
// su tamaño y huella SHA-256 y lo ejecuta en silencio. El instalador cierra la app y su backend (build/installer.nsh),
// instala encima y, con --force-run, vuelve a abrir la app.
//
// La última versión sale de la redirección de github.com/<repo>/releases/latest, y las novedades, el tamaño y la huella,
// de version.json, que se publica con cada versión (scripts/version-json.mjs). Ninguno de los dos cuenta para el límite
// de la API de GitHub (60 consultas por hora por IP, compartidas por todos los equipos de la casa). La API se usa solo si
// la versión no trae version.json (las publicadas antes de que existiera).
//
// Qué bajar lo decide este proceso, nunca la interfaz: así una página no puede hacerle ejecutar otro archivo. La
// dirección del instalador la arma este código, no el archivo. Las funciones de arriba no usan Electron y se prueban
// con Node.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = 'mmunozpatino/lp-media-center';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const INSTALLER_NAME = 'LP-Cine-Vault-Setup.exe';
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const MANIFEST_NAME = 'version.json';
// version.json pesa menos de 1 KB más las novedades.
const MAX_MANIFEST_BYTES = 256 * 1024;
// La respuesta de la API, con las novedades y todos los archivos.
const MAX_API_BYTES = 2 * 1024 * 1024;
const TAG = /^v\d+(?:\.\d+){1,3}$/;
// El instalador pesa unos 120 MB; más que esto no es nuestro.
const MAX_BYTES = 400 * 1024 * 1024;
// Lo que electron-builder le pasa a su propio instalador al actualizar: sin ventanas y abriendo la app al final.
const INSTALLER_ARGS = ['--updated', '/S', '--force-run'];

function versionParts(text) {
  return String(text ?? '')
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** Si `candidate` es más nueva que `current`, comparando número por número. */
function isNewerVersion(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * Del JSON de la última versión, el instalador de Windows: { version, url, sha256, size }. Falla si falta algo,
 * si la dirección no es de las versiones de este repo o si GitHub no da su huella.
 */
function pickInstaller(release) {
  const asset = release?.assets?.find?.((item) => item.name === INSTALLER_NAME);
  if (!asset) throw new Error('La versión publicada no trae el instalador de Windows.');
  const url = String(asset.browser_download_url ?? '');
  if (!url.startsWith(DOWNLOAD_PREFIX) || !url.endsWith('/' + INSTALLER_NAME)) {
    throw new Error('La dirección del instalador no es la esperada.');
  }
  const match = /^sha256:([a-f0-9]{64})$/.exec(String(asset.digest ?? ''));
  if (!match) throw new Error('GitHub no informa la huella del instalador: no se puede comprobar.');
  if (!(asset.size > 0) || asset.size > MAX_BYTES) throw new Error('El tamaño del instalador no es el esperado.');
  return { version: String(release.tag_name ?? '').replace(/^v/, ''), url, sha256: match[1], size: asset.size };
}

/**
 * Baja el instalador a `file`, avisando el avance, y comprueba tamaño y huella. Si algo falla, borra el archivo.
 * `fetchImpl` es net.fetch de Electron (usa el proxy de Windows) o fetch en los tests.
 */
async function downloadInstaller(installer, file, { fetchImpl, onProgress = () => {} }) {
  const response = await fetchImpl(installer.url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`GitHub respondió ${response.status} al bajar el instalador.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > installer.size) throw new Error('El instalador bajado es más grande de lo esperado.');
      hash.update(value);
      if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress({ received, total: installer.size });
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    if (received !== installer.size) throw new Error('El instalador se bajó incompleto.');
    if (hash.digest('hex') !== installer.sha256) throw new Error('La huella del instalador no coincide: no se instala.');
  } catch (error) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw error;
  }
}

const LATEST_PAGE = `https://github.com/${REPO}/releases/latest`;

/** "v0.1.15" de la redirección de /releases/latest ("…/releases/tag/v0.1.15"). Null si no es eso. */
function tagFromLocation(location) {
  const match = /^(?:https:\/\/github\.com)?\/mmunozpatino\/lp-media-center\/releases\/tag\/(v\d+(?:\.\d+){1,3})\/?$/.exec(String(location ?? ''));
  return match ? match[1] : null;
}

/**
 * La última versión sin la API, que tiene un límite de 60 consultas por hora por IP: github.com redirige
 * /releases/latest a la página de esa versión. Se pide solo la cabecera, sin seguir la redirección.
 */
async function fetchLatestTag(fetchImpl) {
  const response = await fetchImpl(LATEST_PAGE, { method: 'HEAD', redirect: 'manual' });
  const tag = tagFromLocation(response.headers.get('location'));
  if (![301, 302, 303, 307, 308].includes(response.status) || !tag) throw new Error('GitHub no informó la última versión.');
  return tag;
}

/**
 * Lo mismo con `net` de Electron: net.fetch cancela las redirecciones con redirect 'manual', así que se usa net.request,
 * que avisa la redirección y su destino sin seguirla.
 */
function latestTagWithNet(net, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url: LATEST_PAGE, method: 'HEAD', redirect: 'manual' });
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error('GitHub no respondió.'));
    }, timeoutMs);
    const finish = (error, tag) => {
      clearTimeout(timer);
      request.abort();
      if (error) reject(error);
      else resolve(tag);
    };
    request.on('redirect', (_status, _method, redirectUrl) => {
      const tag = tagFromLocation(redirectUrl);
      finish(tag ? null : new Error('GitHub no informó la última versión.'), tag);
    });
    request.on('response', () => finish(new Error('GitHub no informó la última versión.')));
    request.on('error', () => finish(new Error('No se pudo consultar GitHub.')));
    request.end();
  });
}

/** Si la API cortó por su límite: un mensaje con la hora para volver a probar. Null si no es eso. */
function rateLimitMessage(response) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (response.status !== 429 && !(response.status === 403 && remaining === '0')) return null;
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const hour = Number.isFinite(reset) && reset > 0
    ? new Date(reset * 1000).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
    : null;
  return `GitHub limitó las consultas por un rato: no es tu conexión.${hour ? ` Probá de nuevo después de las ${hour}.` : ' Probá de nuevo en una hora.'}`;
}

/** El cuerpo de una respuesta como texto, hasta `max` bytes: más que eso no es lo esperado. */
async function readLimitedText(response, max) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw new Error('La respuesta de GitHub es más grande de lo esperado.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * De version.json, la versión, sus novedades y el instalador: { version, notes, installer }. Falla si la versión no es
 * la del tag o si falta el tamaño o la huella. La dirección del instalador sale del tag, nunca del archivo.
 */
function parseManifest(manifest, tag) {
  if (!TAG.test(String(tag))) throw new Error('Versión inválida.');
  const version = tag.slice(1);
  if (manifest?.version !== version) throw new Error('La versión publicada no coincide.');
  const asset = manifest.assets?.[INSTALLER_NAME];
  if (!asset) throw new Error('La versión publicada no trae el instalador de Windows.');
  if (!/^[a-f0-9]{64}$/.test(String(asset.sha256 ?? ''))) throw new Error('No se informa la huella del instalador: no se puede comprobar.');
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES) throw new Error('El tamaño del instalador no es el esperado.');
  return {
    version,
    notes: typeof manifest.notes === 'string' ? manifest.notes.trim() : '',
    installer: { version, url: `${DOWNLOAD_PREFIX}${tag}/${INSTALLER_NAME}`, sha256: asset.sha256, size: asset.size },
  };
}

/** version.json de esa versión, ya validado. Null si esa versión no lo trae (las publicadas antes de que existiera). */
async function fetchManifest(tag, fetchImpl) {
  if (!TAG.test(String(tag))) throw new Error('Versión inválida.');
  const response = await fetchImpl(`${DOWNLOAD_PREFIX}${tag}/${MANIFEST_NAME}`, { redirect: 'follow', cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub respondió ${response.status} al buscar la versión nueva.`);
  let manifest;
  try {
    manifest = JSON.parse(await readLimitedText(response, MAX_MANIFEST_BYTES));
  } catch (error) {
    throw new Error(/más grande/.test(error.message) ? error.message : 'La versión publicada trae un version.json dañado.');
  }
  return parseManifest(manifest, tag);
}

// Hasta cuándo la API cortó por su límite: no se vuelve a consultar antes. Los tests pasan su propio objeto.
const sharedApiLimit = { until: 0, message: '' };

/** La última versión según la API de GitHub, solo para las versiones sin version.json. */
async function releaseFromApi(fetchImpl, limit = sharedApiLimit) {
  if (Date.now() < limit.until) throw new Error(limit.message);
  const response = await fetchImpl(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
  const limited = rateLimitMessage(response);
  if (limited) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    limit.until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60 * 60 * 1000;
    limit.message = limited;
    throw new Error(limited);
  }
  if (!response.ok) throw new Error(`GitHub respondió ${response.status} al buscar la versión nueva.`);
  return JSON.parse(await readLimitedText(response, MAX_API_BYTES));
}

/**
 * Para el aviso de versión nueva: { tag, notes }. Si la instalada ya es la última, no baja nada más. Las novedades salen
 * de version.json; si la versión no lo trae, de la API, y si esta falla, quedan vacías: igual se avisa.
 */
async function latestRelease({ currentVersion, fetchImpl, latestTag = () => fetchLatestTag(fetchImpl), apiLimit }) {
  const tag = await latestTag();
  if (!currentVersion || !isNewerVersion(tag, currentVersion)) return { tag, notes: '' };
  const manifest = await fetchManifest(tag, fetchImpl);
  if (manifest) return { tag, notes: manifest.notes };
  try {
    const release = await releaseFromApi(fetchImpl, apiLimit);
    return { tag, notes: release.tag_name === tag && typeof release.body === 'string' ? release.body.trim() : '' };
  } catch {
    return { tag, notes: '' };
  }
}

/**
 * Busca, baja e instala. `currentVersion` sale de build-info.json; sin ella es una app de desarrollo. `latestTag` da el
 * tag de la última versión (en la app, latestTagWithNet). Devuelve { version } cuando el instalador ya arrancó; la app
 * se cierra sola poco después.
 */
async function installLatest({ currentVersion, tempDir, fetchImpl, latestTag = () => fetchLatestTag(fetchImpl), onProgress, launch = launchInstaller, apiLimit }) {
  if (!currentVersion) throw new Error('Esta es una versión de desarrollo: no se actualiza sola.');
  const tag = await latestTag();
  if (!isNewerVersion(tag, currentVersion)) throw new Error('Ya tenés la última versión.');
  const manifest = await fetchManifest(tag, fetchImpl);
  const installer = manifest ? manifest.installer : pickInstaller(await releaseFromApi(fetchImpl, apiLimit));
  if (!isNewerVersion(installer.version, currentVersion)) throw new Error('Ya tenés la última versión.');
  const dir = path.join(tempDir, 'lp-cine-vault-actualizacion');
  fs.rmSync(dir, { recursive: true, force: true });
  const file = path.join(dir, `LP-Cine-Vault-Setup-${installer.version}.exe`);
  await downloadInstaller(installer, file, { fetchImpl, onProgress });
  launch(file);
  return { version: installer.version };
}

/** El instalador corre aparte: sigue vivo cuando cierra a la app. */
function launchInstaller(file) {
  const child = spawn(file, INSTALLER_ARGS, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

module.exports = {
  INSTALLER_ARGS,
  downloadInstaller,
  fetchLatestTag,
  latestTagWithNet,
  installLatest,
  isNewerVersion,
  latestRelease,
  parseManifest,
  pickInstaller,
  rateLimitMessage,
  tagFromLocation,
};

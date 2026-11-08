// Actualiza la app de Windows sola: baja el instalador de la última versión publicada en GitHub, comprueba
// su huella SHA-256 y lo ejecuta en silencio. El instalador cierra la app y su backend (build/installer.nsh),
// instala encima y, con --force-run, vuelve a abrir la app.
//
// Qué bajar lo decide este proceso con la API de GitHub, nunca la interfaz: así una página no puede hacerle
// ejecutar otro archivo. Las funciones de arriba no usan Electron y se prueban con Node.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = 'mmunozpatino/lp-media-center';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const INSTALLER_NAME = 'LP-Cine-Vault-Setup.exe';
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
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

/**
 * Busca, baja e instala. `currentVersion` sale de build-info.json; sin ella es una app de desarrollo.
 * Devuelve { version } cuando el instalador ya arrancó; la app se cierra sola poco después.
 */
async function installLatest({ currentVersion, tempDir, fetchImpl, onProgress, launch = launchInstaller }) {
  if (!currentVersion) throw new Error('Esta es una versión de desarrollo: no se actualiza sola.');
  const response = await fetchImpl(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub respondió ${response.status} al buscar la versión nueva.`);
  const installer = pickInstaller(await response.json());
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

module.exports = { INSTALLER_ARGS, downloadInstaller, installLatest, isNewerVersion, pickInstaller };

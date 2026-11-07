// Arma las novedades de cada versión con los mensajes de commit: la primera línea es el título y el resto,
// sin las líneas Co-Authored-By ni Signed-off-by, la explicación. Cada versión publicada tiene su tag
// v0.1.<n>; lo que va del tag anterior a este commit es la versión nueva. Necesita el historial completo
// (en el workflow, checkout con fetch-depth: 0).
//
// node scripts/changelog.mjs            escribe ui/changelog.json, si hay LP_VERSION
// node scripts/changelog.mjs --notas f  escribe en f el texto de la versión nueva, para la release de GitHub
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Cuántas versiones viajan dentro de la app. */
export const MAX_VERSIONS = 40;

const TRAILER = /^(co-authored-by|signed-off-by):/i;

/** "v0.1.12" -> [0, 1, 12]. null si no es una versión. */
export function versionParts(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let index = 0; index < 3; index += 1) if (x[index] !== y[index]) return x[index] - y[index];
  return 0;
}

/** El cuerpo del commit en párrafos: une las líneas cortadas y saca las líneas de autoría. */
export function commitBody(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => !TRAILER.test(line.trim()));
  return lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split('\n').map((line) => line.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n\n');
}

const RECORD = '\x1e';
const FIELD = '\x1f';
export const LOG_FORMAT = `${RECORD}%s${FIELD}%b`;

/** Salida de git log con LOG_FORMAT -> [{ title, body }], del más nuevo al más viejo. */
export function parseLog(output) {
  return String(output ?? '')
    .split(RECORD)
    .filter((record) => record.trim())
    .map((record) => {
      const [title, body = ''] = record.split(FIELD);
      return { title: title.trim(), body: commitBody(body) };
    })
    .filter((change) => change.title);
}

/** Texto de la release de GitHub: una línea por cambio, con su explicación debajo. */
export function releaseNotes(entry) {
  if (!entry?.changes.length) return 'Sin cambios en la app.';
  return entry.changes
    .map(({ title, body }) => '- ' + title + (body ? '\n\n' + body.replace(/^(?=.)/gm, '  ') : ''))
    .join('\n\n') + '\n';
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function changesBetween(from, to) {
  return parseLog(git('log', '--no-merges', '--format=' + LOG_FORMAT, from ? `${from}..${to}` : to));
}

/** Las versiones publicadas que son parte de este commit, de la más vieja a la más nueva. */
function publishedTags(current) {
  return git('tag', '--list', 'v*', '--merged', 'HEAD')
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => versionParts(tag) && compareVersions(tag, current) < 0)
    .sort(compareVersions);
}

/** { versions: [{ version, date, changes }] }, de la más nueva a la más vieja. */
export function buildChangelog(current) {
  const tags = publishedTags(current);
  const versions = [];
  let previous = null;
  for (const tag of tags) {
    versions.push({ version: tag.slice(1), date: git('log', '-1', '--format=%cs', tag).trim(), changes: changesBetween(previous, tag) });
    previous = tag;
  }
  versions.push({ version: current, date: git('log', '-1', '--format=%cs', 'HEAD').trim(), changes: changesBetween(previous, 'HEAD') });
  return { versions: versions.reverse().slice(0, MAX_VERSIONS) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.env.LP_VERSION;
  const notesIndex = process.argv.indexOf('--notas');
  if (!version) {
    console.log('Sin LP_VERSION: versión de desarrollo, sin novedades.');
  } else if (notesIndex !== -1) {
    writeFileSync(process.argv[notesIndex + 1], releaseNotes(buildChangelog(version).versions[0]));
  } else {
    const changelog = buildChangelog(version);
    writeFileSync(new URL('../ui/changelog.json', import.meta.url), JSON.stringify(changelog) + '\n');
    console.log('Novedades de', changelog.versions.length, 'versiones');
  }
}

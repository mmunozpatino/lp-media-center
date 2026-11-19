// Builds version.json, published with the APK and the Windows installer in every release. The apps download it from
// github.com/<repo>/releases/download/<tag>/version.json, which does not count against the GitHub API limit (60
// requests per hour per IP, shared by every device in the house). It carries the release notes and the size and
// SHA-256 of each installer, to check them before installing.
//
// node scripts/version-json.mjs <version> <notes.md> <output> <file>...
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** files: [{ name, bytes }]. Each one goes to `assets` by name, with its size and SHA-256. */
export function buildVersionJson({ version, notes, files }) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error(`Versión inválida: ${version}`);
  if (!Array.isArray(files) || !files.length) throw new Error('Falta al menos un archivo.');
  const assets = {};
  for (const { name, bytes } of files) {
    if (!/^[\w.-]+$/.test(String(name)) || name in assets) throw new Error(`Nombre de archivo inválido: ${name}`);
    if (!bytes?.length) throw new Error(`Archivo vacío: ${name}`);
    assets[name] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  return { version, notes: String(notes ?? '').trim(), assets };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, notesFile, output, ...paths] = process.argv.slice(2);
  if (!paths.length) {
    console.error('Uso: node scripts/version-json.mjs <versión> <novedades.md> <salida> <archivo>...');
    process.exit(1);
  }
  const data = buildVersionJson({
    version,
    notes: readFileSync(notesFile, 'utf8'),
    files: paths.map((file) => ({ name: path.basename(file), bytes: readFileSync(file) })),
  });
  writeFileSync(output, JSON.stringify(data, null, 2) + '\n');
  for (const [name, asset] of Object.entries(data.assets)) {
    console.log(`version.json ${data.version}: ${name} ${asset.size} bytes, sha256 ${asset.sha256}`);
  }
}

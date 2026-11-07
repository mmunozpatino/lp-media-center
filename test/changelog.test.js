import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOG_FORMAT, commitBody, compareVersions, parseLog, releaseNotes, versionParts } from '../scripts/changelog.mjs';

// Lo que devolvería git log con LOG_FORMAT, armado a mano.
const log = (...commits) =>
  commits.map(([title, body]) => LOG_FORMAT.replace('%s', title).replace('%b', body)).join('\n');

describe('changelog desde los commits', () => {
  it('saca las líneas de autoría y une las líneas cortadas', () => {
    const body = 'Las tarjetas suman el botón\nde Services.\n\nSegundo párrafo.\n\nCo-Authored-By: Alguien <a@example.com>\nSigned-off-by: Otra <b@example.com>\n';
    assert.equal(commitBody(body), 'Las tarjetas suman el botón de Services.\n\nSegundo párrafo.');
    assert.equal(commitBody('co-authored-by: x <x@example.com>'), '');
    assert.equal(commitBody(undefined), '');
  });

  it('parsea la salida de git log', () => {
    const output = log(['Novedades en la app', 'Explica\nqué cambia.\n\nCo-Authored-By: X <x@example.com>\n'], ['Arreglo chico', '']);
    assert.deepEqual(parseLog(output), [
      { title: 'Novedades en la app', body: 'Explica qué cambia.' },
      { title: 'Arreglo chico', body: '' },
    ]);
    assert.deepEqual(parseLog(''), []);
  });

  it('ordena versiones numéricamente', () => {
    assert.deepEqual(versionParts('v0.1.12'), [0, 1, 12]);
    assert.equal(versionParts('v0.1'), null);
    assert.equal(versionParts('latest'), null);
    assert.deepEqual(['v0.1.10', 'v0.1.9', 'v0.1.2'].sort(compareVersions), ['v0.1.2', 'v0.1.9', 'v0.1.10']);
  });

  it('arma el texto de la release', () => {
    assert.equal(
      releaseNotes({ changes: [{ title: 'Uno', body: 'Detalle\n\nMás' }, { title: 'Dos', body: '' }] }),
      '- Uno\n\n  Detalle\n\n  Más\n\n- Dos\n',
    );
    assert.equal(releaseNotes({ changes: [] }), 'Sin cambios en la app.');
  });
});

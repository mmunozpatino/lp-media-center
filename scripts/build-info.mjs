// Escribe ui/build-info.json con la versión que arma el workflow. Con ella la app sabe si hay una más nueva.
// Sin LP_VERSION no escribe nada: la app queda como versión de desarrollo y no busca actualizaciones.
import { writeFileSync } from 'node:fs';

const version = process.env.LP_VERSION;
if (!version) {
  console.log('Sin LP_VERSION: versión de desarrollo.');
} else {
  const info = { version, commit: (process.env.GITHUB_SHA ?? '').slice(0, 7) || null };
  writeFileSync(new URL('../ui/build-info.json', import.meta.url), JSON.stringify(info) + '\n');
  console.log('Versión', version);
}

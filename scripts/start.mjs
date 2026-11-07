// Para desarrollo: abre el backend y la app juntos, sin empaquetar. Al cerrar la app, corta el
// backend. Si el backend ya estaba corriendo, avisa por consola y la app usa ese.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = { cwd: root, stdio: 'inherit' };

const backend = spawn(process.execPath, ['backend/server.js'], options);
const electron = spawn(process.execPath, ['node_modules/electron/cli.js', '.'], options);

electron.on('exit', (code) => {
  backend.kill();
  process.exitCode = code ?? 0;
});

// La app instalada lanza su propio backend: el mismo .exe de Electron corriendo como Node. Queda como
// proceso aparte y sigue vivo al cerrar la ventana. Si el puerto ya está en uso, ese proceso termina solo.

const { spawn } = require('node:child_process');
const path = require('node:path');

/** Node no ejecuta un script ESM desde dentro del asar: el backend va desempaquetado al lado. */
function backendScriptPath(appPath) {
  return path.win32.join(appPath.replace(/app\.asar$/, 'app.asar.unpacked'), 'backend', 'server.js');
}

function startBackend(appPath) {
  const child = spawn(process.execPath, [backendScriptPath(appPath)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

module.exports = { backendScriptPath, startBackend };

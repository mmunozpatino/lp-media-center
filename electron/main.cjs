const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, net, protocol, shell } = require('electron');
const { startBackend } = require('./backend.cjs');
const { isReleaseUrl, isSeerrUrl, isServiceUrl } = require('./seerr-url.cjs');

// La interfaz se sirve como app://lp-media-center, el único origen que acepta el backend. No se marca
// como `secure`: la app va a pedirle datos por HTTP a la IP de LAN, y un origen seguro lo bloquearía.
const APP_HOST = 'lp-media-center';
const APP_URL = `app://${APP_HOST}/index.html`;
const UI_DIR = path.join(__dirname, '..', 'ui');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, supportFetchAPI: true } },
]);

const hardened = { contextIsolation: true, sandbox: true, nodeIntegration: false };

let mainWindow = null;
let seerrWindow = null;

function serveUi(request) {
  const url = new URL(request.url);
  const file = path.normalize(path.join(UI_DIR, decodeURIComponent(url.pathname)));
  if (url.host !== APP_HOST || !file.startsWith(UI_DIR + path.sep)) {
    return new Response('No existe', { status: 404 });
  }
  return net.fetch(pathToFileURL(file).toString());
}

function openExternally(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

/** Seerr va en su propia ventana y sesión, con su login. Lo que salga de Seerr se abre en el navegador. */
function openSeerr(url) {
  if (seerrWindow) {
    seerrWindow.loadURL(url);
    seerrWindow.show();
    seerrWindow.focus();
    return;
  }
  const origin = new URL(url).origin;
  const isSameOrigin = (target) => {
    try {
      return new URL(target).origin === origin;
    } catch {
      return false;
    }
  };
  seerrWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Seerr',
    autoHideMenuBar: true,
    webPreferences: { ...hardened, partition: 'persist:seerr' },
  });
  seerrWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isSameOrigin(target)) seerrWindow.loadURL(target);
    else openExternally(target);
    return { action: 'deny' };
  });
  seerrWindow.webContents.on('will-navigate', (event, target) => {
    if (!isSameOrigin(target)) {
      event.preventDefault();
      openExternally(target);
    }
  });
  seerrWindow.on('closed', () => {
    seerrWindow = null;
  });
  seerrWindow.loadURL(url);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    title: 'LP Cine Vault',
    webPreferences: hardened,
  });
  // La interfaz pide el navegador con window.open(url, 'navegador'); sin ese nombre, abre Seerr en su ventana.
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === 'navegador') {
      if (isServiceUrl(url) || isReleaseUrl(url)) shell.openExternal(url);
    } else if (isSeerrUrl(url)) {
      openSeerr(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(() => {
    // Solo la app instalada se registra al iniciar Windows y lanza su propio backend.
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true });
      startBackend(app.getAppPath());
    }
    Menu.setApplicationMenu(null);
    protocol.handle('app', serveUi);
    createMainWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

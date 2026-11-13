// Lo único que la interfaz puede pedirle a la app de Windows: instalar la última versión publicada.
// Qué bajar lo decide el proceso principal; la interfaz no pasa ninguna dirección.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lpDesktop', {
  /** { tag: "v0.1.15" } de la última versión publicada. Falla si GitHub no la informó. */
  async latestVersion() {
    const result = await ipcRenderer.invoke('lp:latest-version');
    if (!result.ok) throw new Error(result.message);
    return { tag: result.tag };
  },
  /** onProgress recibe { received, total } en bytes. Se resuelve con { version } cuando arrancó el instalador. */
  installUpdate(onProgress) {
    const listener = (_event, progress) => onProgress?.(progress);
    ipcRenderer.on('lp:update-progress', listener);
    return ipcRenderer
      .invoke('lp:install-update')
      .finally(() => ipcRenderer.removeListener('lp:update-progress', listener))
      .then((result) => {
        if (!result.ok) throw new Error(result.message);
        return { version: result.version };
      });
  },
});

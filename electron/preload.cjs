// Lo único que la interfaz puede pedirle a la app de Windows: cuál es la última versión publicada y sus novedades, e
// instalarla.
// Qué bajar lo decide el proceso principal; la interfaz no pasa ninguna dirección.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lpDesktop', {
  /**
   * { tag: "v0.1.15", notes } de la última versión publicada. notes trae las novedades solo si es más nueva que la
   * instalada (puede venir vacío). Falla si GitHub no informó la versión.
   */
  async latestRelease() {
    const result = await ipcRenderer.invoke('lp:latest-release');
    if (!result.ok) throw new Error(result.message);
    return { tag: result.tag, notes: typeof result.notes === 'string' ? result.notes : '' };
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

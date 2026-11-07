// Qué direcciones puede abrir la app: los puertos de los programas, por HTTP, en esta PC, la LAN o
// Tailscale. Cualquier otra se rechaza.

const SEERR_PORT = '5055';
// Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent, Jellyfin y Seerr.
const SERVICE_PORTS = ['7878', '8989', '9696', '6767', '8080', '8096', SEERR_PORT];

function isPrivateHost(hostname) {
  if (hostname === 'localhost') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const [a, b] = match.slice(1, 3).map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isAllowedUrl(text, ports) {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' && ports.includes(url.port) && isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

const isSeerrUrl = (text) => isAllowedUrl(text, [SEERR_PORT]);
const isServiceUrl = (text) => isAllowedUrl(text, SERVICE_PORTS);

/** Descargas de las versiones publicadas de este repo, para actualizar la app. */
function isReleaseUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/mmunozpatino/lp-media-center/releases/');
  } catch {
    return false;
  }
}

module.exports = { isReleaseUrl, isSeerrUrl, isServiceUrl };

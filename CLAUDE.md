# LP Cine Vault

Nombre elegido por la usuaria (LP es ladyPurple, su tag). Se ve en la interfaz (constante `PRODUCT_NAME`), en el acceso directo
y la lista de programas de Windows, y en el nombre de la app de Android. `productName` y la carpeta del repo siguen como
"LP Media Center": cambiarlos movería el `.exe`, y la regla de firewall y el inicio con Windows están atados a esa ruta.

App de administración del servidor casero de películas y series. Se instala en Android y Windows, y
muestra el estado de cada programa, qué se está bajando y da acceso a Seerr. Este proyecto se
conversa en español.

El servidor y el bot de Telegram se documentan en `C:\Develop\pelis-bot\CLAUDE.md`. Este repo no los
reemplaza. Estado al 2026-11-06: instalada en esta PC, con backend abierto a la LAN y Tailscale tras login y emparejamiento. APK de prueba generado y probado en emulador, todavía sin probar en un celular real.

**Nunca guardes acá tokens, claves ni contraseñas.** No pidas al usuario que los pegue en el chat:
indicale qué dato cargar y en qué pantalla o terminal.

## Comandos
Desde `C:\Develop\lp-media-center`, con Node 22 o más nuevo:

| Comando | Qué hace |
|---|---|
| `npm install` | Instala dependencias y baja el binario de Electron |
| `npm start` | Abre backend y app juntos; al cerrar la app, corta el backend |
| `npm run backend` | Solo el backend, en `http://127.0.0.1:8787/api/status` |
| `npm run app` | Solo la app, sin empaquetar |
| `npm test` | Tests del backend y la interfaz, con programas simulados |
| `npm run dist` | Genera el instalador `dist\LP Media Center Setup 0.1.0.exe` con electron-builder |
| `npm run apk` | Genera `dist\LP Media Center.apk`, firmado con la clave de depuración. Gradle solo corre desde una pestaña del panel Terminal |

Para actualizar la app de Windows: `npm run dist` y, desde el panel Terminal, `scripts\reinstalar.ps1`. Las reglas de firewall están en `scripts\firewall.ps1`.

La app instalada lanza su propio backend y se registra para abrirse al iniciar Windows. Sin empaquetar (`npm run app`) no hace
ninguna de las dos cosas.

## Código
**Decisión del usuario:** el backend es un solo script de Node, solo con módulos nativos, sin dependencias de
npm ni framework. La interfaz es un solo archivo, sin framework. La app y el backend no tienen dependencias
en ejecución. Electron y Capacitor son la base de cada app; electron-builder y las herramientas de Capacitor son solo para construir.

- `backend/server.js`: todo el backend, con los puertos y las rutas al principio.
- `ui/index.html`: toda la interfaz, la misma en Windows y Android. Solo su sección "Conexión" conoce la dirección
  de la PC, y ahí está la búsqueda. La sección "Protocolo" no toca el DOM y se prueba con Node.
- `android/`: proyecto de Capacitor. `LpNetworkPlugin.java` da la IP del Wi-Fi y abre webs en el navegador. No se importa
  `@capacitor/core` en la interfaz: se usa `Capacitor.nativePromise` del puente nativo.
- `electron/`: sirve `ui/` como `app://lp-media-center` y abre Seerr en su propia ventana.
- `electron/backend.cjs`: lanza `backend/server.js` con el mismo `.exe` y `ELECTRON_RUN_AS_NODE=1`, como proceso aparte. Sigue
  vivo al cerrar la ventana; si el puerto está ocupado, termina solo.
- `backend/package.json`: solo marca el módulo ESM. El backend va desempaquetado en `app.asar.unpacked`, donde no se ve el
  `package.json` de la raíz.
- El instalador es NSIS, por usuario y sin administrador. No lleva firma. Ícono: el carrete del logo (`build/icono.svg`);
  `npx electron scripts/iconos.cjs` genera `build/icon.png` (Windows) y los `mipmap-*` de Android, que quedan commiteados.
- `GET /api/status` devuelve `generatedAt`, `network` (`lanIp`, `tailscaleIp`), `parts`, `downloads`, `requests`
  y `disks`. Cada parte tiene `state`: `ok`, `warning`, `down` (no responde) o `error` (responde, pero no se pudo
  leer), y `control`, que es `null` si no se puede frenar ni levantar.
- `POST /api/parts/<id>/stop` o `/start` responde `ok` y `message`. Solo se acepta con el `Origin` de la app.

## Seguridad del backend
Escucha en `0.0.0.0`, solo IPv4, porque la PC tiene IPv6 público.
- **Desde esta PC:** sin login. La configuración (`/api/setup`) solo se acepta desde acá y con `Origin` de la app.
- **Desde la red:** rechaza direcciones que no sean privadas o de Tailscale, y exige sesión. El `Host` tiene que ser una IP
  privada o `localhost`, lo que frena el DNS rebinding. Orígenes: `app://lp-media-center` y `http://localhost` de Android. Nunca `*` ni `null`.
- **Datos:** `~/.lp-media-center/auth.json`, fuera del repo y de AppData: hash scrypt, secretos de dispositivos y hash de sesiones.
- **Emparejar:** código de 12 caracteres que se crea en la app de Windows, de un solo uso, 10 minutos, se anula a los 5 errores.
  La PC prueba que lo conoce con un HMAC antes de que el celular mande nada, y el secreto viaja cifrado con él.
  El código se puede copiar y trae un QR (generador propio en la sección "QR" de la interfaz) con
  `lpcinevault://emparejar?codigo=…&pc=<IP>`. En Android, "Escanear QR" usa el lector de Google Play Services
  (`play-services-code-scanner`, única dependencia nativa agregada; no pide permiso de cámara), y si la cámara abre
  ese enlace, la app llega con los datos cargados pero no empareja sola. Cada dispositivo tiene nombre: se elige al
  emparejar y se cambia desde la PC (`/api/setup/devices/<id>/rename`). Sin probar con una cámara real: en el emulador
  se probó el enlace con `adb` y que el lector abre y se cierra.
- **Entrar:** `/api/identify` prueba que es la PC antes de mandar la contraseña. Sesión de 30 días; 5 errores frenan un minuto.
- **Firewall:** `scripts/firewall.ps1` crea `LP Media Center (LAN y Tailscale)`, atada al `.exe`, y `Seerr (Tailscale)`, en perfil Privado. Si se cancela el cartel de Windows al abrir el puerto, se crean reglas de bloqueo que ganan sobre el permiso: ese script las borra. Sin probar desde otro equipo. Bazarr y qBittorrent no tienen regla
  de LAN: la flecha desde el celu solo los abre por Tailscale.

## Reglas que puso el usuario
- Usar instaladores o paquetes oficiales.
- Dejar los servicios iniciando con la PC.
- Proteger las interfaces web con usuario y contraseña, y no exponerlas a internet.
- Limitar el acceso a la PC, la red local y Tailscale. Nunca abrir puertos en el router.
- No mover, renombrar ni borrar nada de la biblioteca. **Única excepción:** borrar un pedido desde la app (ver "Borrar un
  pedido"), que la usuaria pidió y confirmó el 2026-11-09 porque solo ella controla la app.
- Pedir confirmación antes de cambios importantes, permisos de administrador o reglas de firewall.
- No agregar indexadores: de eso se encarga el usuario.

## Diseño acordado
```text
En casa:  App --HTTP por la LAN----------> IP actual de la PC:8787 --> backend --> programas
Afuera:   App --HTTP dentro de Tailscale-> <IP de Tailscale>:8787    --> backend --> programas
```
- **Apps:** una sola interfaz web, empaquetada con Capacitor (APK de Android) y Electron (Windows). En
Windows es un instalador NSIS. La interfaz va dentro
  de la app, para poder avisar si no llega a la PC.
- **Sin PWA:** una PWA no se instala desde HTTP en la LAN, y en casa la app tiene que funcionar sin
  Tailscale. Por eso tampoco se usa Tailscale Serve.
- **Backend:** Node en la PC, iniciado con la sesión. Lee las claves de cada programa localmente y
  ninguna sale de la PC. Puerto previsto: 8787, libre al 2026-11-05.
- **Conexión:** la IP de la LAN no es fija: la PC la toma por DHCP y el usuario no tiene acceso al
  router para reservarla. La app no depende de ninguna IP de LAN escrita en el código:
  1. Prueba la última IP que funcionó y Tailscale a la vez. Si responden las dos, usa la LAN.
  2. Si conecta por Tailscale, el backend le informa su IP de LAN actual y la app la guarda.
  3. Si no responde ninguna, busca en la red: prueba el puerto 8787 en las 254 direcciones de su propia
     subred `/24`, de a pocas por vez y con timeout corto.
  4. Solo acepta el equipo que responda bien el desafío del emparejamiento. El secreto nunca se envía.
- **Límite de la búsqueda:** es automática solo en la subred donde ya encontró la PC. En otra subred,
  solo con el botón "Buscar PC", para no recorrer redes ajenas.
- **Sin mDNS:** sumaría otra regla de firewall y puede fallar según el router; la búsqueda alcanza.
- **Direcciones que dependen de la IP:** el backend no las fija; la app arma la de Seerr con la dirección
  que esté usando. En Seerr, `externalUrl` de Radarr y Sonarr quedó con `<IP de LAN>`: si la IP cambia,
  solo se rompen sus links, no la conexión, que usa `localhost`.
- **Autenticación:** usuario y contraseña propios del panel.
- **Emparejamiento:** cada dispositivo se empareja una vez con un secreto. La app comprueba con él que
  habla con esta PC antes de mandar la contraseña: en otro Wi-Fi, la misma IP puede ser de otra persona.
- **Cifrado:** Tailscale cifra el tráfico cuando está afuera. En casa la contraseña viaja por HTTP,
  igual que hoy en Radarr o Seerr. Se aceptó para empezar; un certificado propio queda para después.
- **Android:** como la IP de LAN cambia, el HTTP no se puede limitar a dos direcciones. Hay que permitirlo
  y que la app solo lo use hacia direcciones privadas y de Tailscale.
- **Seerr:** se abre dentro de la app con su propia dirección y su propio login, sin iframe.

## Qué hace la app
**Ya está:** ver todo, con cada sección colapsable, pedidos pendientes en una sección aparte, y frenar o
levantar cada programa o todos juntos. Frenar pide confirmación; levantar no.

**Falta:** reintentar una descarga. Lo único que borra archivos es borrar un pedido.

**Borrar un pedido (la excepción a no tocar la biblioteca):** papelera en cada tarjeta de Requests y de Downloads. Pedido de la
usuaria el 2026-11-09: sacar un pedido de Telegram o de Seerr de todos los pasos a los que llegó, archivo incluido; existe porque
solo ella controla la app. `createRequestRemover` en `backend/server.js`, tests en `test/borrar.test.js`.
- **Contraseña primero:** `POST /api/requests/<id>/plan` con `{ password }` verifica la contraseña del panel (`auth.verifyAdmin`,
  también desde esta PC, 5 errores frenan un minuto) antes de revisar nada. Devuelve el plan (pasos, archivos, notas) y un
  `token` de 3 minutos. `POST /api/requests/<id>/delete` con `{ token }` rehace el plan y solo borra si es idéntico.
- **Ids:** Seerr (número), `radarr-<id>` o `sonarr-<id>` (Telegram), `cola-movie|tv-<tmdbId>` (Downloads; busca además el pedido
  de Seerr) y `buzon-movie|tv-<idDelBuzón>-<tmdbId>` (lo que sigue en el buzón).
- **Qué es un pedido lo decide el backend:** película monitoreada y en su propia carpeta dentro de `F:\Movies\_inbox` (raíz de
  Seerr y del bot; la biblioteca está en las otras carpetas de `F:\Movies`, sin monitorear). Serie monitoreada y en su carpeta
  dentro de `F:\Series`: solo se borran archivos de episodios con `downloadFolderImported` en el historial de Sonarr; la serie
  entera, solo si todos sus archivos entraron así. Si no, borra esos episodios y deja de monitorear los pedidos que faltan.
  Todo archivo tiene que estar dentro de la carpeta del título. Si algo no cumple, 409 y no se toca nada.
- **Pasos, en orden, cortando en el primero que falle y diciendo qué quedó hecho:** buzón del bot
  (`POST /api/requests|series/requests/<id>/cancel` con `mailboxUrl` y `mailboxKey` de `%USERPROFILE%\.pelis-bot\config.json`, que
  nunca salen de la PC; si responde `cancelled: false`, vuelve a mirar Radarr o Sonarr tres veces cada 5 s; si el buzón todavía no
  lo acepta, lo dice y no sigue), Seerr (`DELETE /api/v1/request/<id>`), cola (`removeFromClient=true`), Radarr o Sonarr
  (`deleteFiles=true`) y Jellyfin (`POST /Library/Refresh`).
- **Jellyfin:** necesita una clave en `~/.lp-media-center/jellyfin.key`, que todavía no existe: sin ella el paso solo avisa.
- **Pendiente:** listar lo que espera en el buzón. `GET /api/pending` y `/api/series/pending` guardan además la señal de vida del
  programa de la PC (`agent_seen`), así que la app no los consulta; se pidió a pelis-bot una lectura sin efectos.
- **Sin probar en real:** solo con programas simulados. Probarlo solo con un pedido que elija la usuaria: es irreversible.

**Pantalla de carga:** `#splash` tapa todo al abrir, con el carrete girando y "Conectando con la PC…" (en el celu, "Buscando la
PC…"). Se va con el primer estado, un error (`showFailure`) o cualquier pantalla de `showGate`.

**Pausar descargas:** frena en qBittorrent lo que esté activo y guarda cuáles fueron en `~/.lp-media-center/pausa.json`, para que
reanudar no arranque lo frenado a mano. Requiere activar en qBittorrent "Omitir autenticación para clientes en localhost"; sin eso,
el botón explica qué activar.

**Pantalla:** diseño CineVault (dark cinematic) con barra lateral y vistas Overview, Services, Downloads, Requests, Storage,
Network y Settings. En celular, servicios de a dos por fila, como pidió la usuaria, sin descripción ni gráfica; descargas, pedidos y red de a uno. La barra de abajo flota y muestra Overview, Services, Downloads, Requests y "Más", que abre Storage, Network y Settings. Fuera de Overview, el estado general queda en una línea. Tema oscuro por defecto, o claro.

**Pedidos fuera de Seerr:** el bot de Telegram agrega directo a Radarr o Sonarr. Por eso `requests` suma lo que Radarr
(`/wanted/missing`) y Sonarr (`/series`) tienen monitoreado, sin archivo y fuera de la cola, con estado `notGrabbed` o
`notReleased`. Cada pedido trae `origin`: `seerr` o `telegram` (lo de Radarr o Sonarr fuera de Seerr; el bot no lo marca, así que lo
 agregado a mano también sale como Telegram), y la interfaz lo muestra como etiqueta. El 2026-11-07, Radarr no pudo mandar un pedido del bot porque qBittorrent todavía no había abierto tras
el arranque, y no vuelve a buscarlo solo: hay que buscarlo de nuevo en Radarr. Conviene que el bot espere a qBittorrent.

**Buscar la PC:** la subred propia en 254 direcciones, de a 24 y con timeout de 2 s. Con 800 ms fallaba: el primer pedido del
WebView tardó 750 ms. Solo sale sola en subredes donde ya encontró la PC; en otras, con el botón "Buscar PC".

### Cómo se frena y levanta cada programa
| Programa | Frenar | Levantar | Permiso |
|---|---|---|---|
| Radarr, Sonarr, Prowlarr | `sc.exe stop` | `sc.exe start` | Ya lo tienen los usuarios autenticados |
| Bazarr | `sc.exe stop` | `sc.exe start` | **Falta:** su servicio solo se lo da a administradores |
| qBittorrent | Pide cerrar; a los 15 s, fuerza | Abre el `.exe` por Explorer | Es de la sesión |
| Jellyfin | Fuerza el cierre de la bandeja y del servidor | Abre la bandeja por Explorer | Es de la sesión |
| Seerr | Termina su `node.exe` | Tarea `Seerr` | Es de la sesión |
| Bot | Termina el `node.exe` de `agent.js` | Tarea `Pelis Bot Agent` | Es de la sesión |

- **Tailscale:** se conecta con `tailscale up` y se desconecta con `tailscale down`, sin tocar su servicio ni
  su configuración. No entra en "apagar todo", y el backend rechaza desconectarlo si el pedido llega por el propio
  Tailscale: se perdería el acceso. Conectar sin opciones falla o se corta a los 30 s si pide iniciar sesión.
- **El backend no se frena a sí mismo,** para poder prender todo de nuevo.
- **"Quedó hecho" se comprueba:** el backend espera hasta 45 s a que el programa deje de responder o vuelva.
- **Apagar y prender todo:** la interfaz manda los pedidos de a 3. El navegador abre 6 conexiones por servidor,
  y con más se trabaría la actualización del estado y aparecería un falso "No llego a la PC".
- **Explorer para abrir programas:** así no quedan como hijos del backend ni heredan el AppData virtualizado
  de la app de Claude.
- **Seerr:** los pedidos salen de `/api/v1/request` con `filter=pending`, `processing` y `failed`, porque para
  Seerr `pending` es solo lo que espera aprobación. El título sale de `/api/v1/movie/<tmdbId>` o `/tv/<tmdbId>`. A la
  interfaz solo llega `displayName`, nunca el mail.
- **Flecha de cada programa:** abre su web en el navegador del sistema con `window.open(url, 'navegador')`.
  `electron/seerr-url.cjs` solo deja pasar los puertos de los programas en direcciones privadas.

## De dónde sale cada estado
Solo `127.0.0.1` desde el backend. Lo marcado como comprobado se probó el 2026-11-05.

| Parte | Puerto | Cómo | Clave | Comprobado |
|---|---|---|---|---|
| Radarr | 7878 | `/api/v3/system/status`, `/health`, `/queue` | `C:\ProgramData\Radarr\config.xml` | Sí; cola vacía |
| Sonarr | 8989 | `/api/v3/system/status`, `/health`, `/queue` | `C:\ProgramData\Sonarr\config.xml` | Sí; cola vacía |
| Prowlarr | 9696 | `/api/v1/system/status`, `/health` | `C:\ProgramData\Prowlarr\config.xml` | Sí |
| Bazarr | 6767 | `/api/system/status`, `/api/system/health`, `/api/providers`, con cabecera `X-API-KEY` | `auth.apikey` en `C:\ProgramData\Bazarr\config\config.yaml` | Sí |
| qBittorrent | 8080 | Si `/api/v2/app/version` responde 403 sin sesión, está vivo | Velocidades y torrents requieren su contraseña | Sí |
| Jellyfin | 8096 | `/System/Info/Public`; quién está viendo requiere clave | La crea el usuario en Jellyfin | Parte pública |
| Seerr | 5055 | `/api/v1/status`, `/api/v1/request/count` | `main.apiKey` en `C:\Develop\seerr\app\config\settings.json` | Sí |
| Bot | - | Proceso `node.exe` con `agent.js` | - | Sí |
| Tailscale | - | `C:\Program Files\Tailscale\tailscale.exe status --json` | - | Sí |
| Discos | - | `Win32_LogicalDisk` por PowerShell; avisa con menos de 10% libre | - | Sí |

- **Bazarr:** `/api/system/status` trae la versión en `data.bazarr_version`. `/api/providers` trae
  `data[]` con `name`, `status` (`Good` o el motivo) y `retry`; así se ve el límite de OpenSubtitles.
  `/api/system/settings` no se usa, para no traer su configuración al backend.
- **Seerr:** `/request/count` devuelve `total`, `movie`, `tv`, `pending`, `approved`, `declined`,
  `processing`, `available` y `completed`.
- **Descargas:** salen de las colas de Radarr y Sonarr, sin credenciales de qBittorrent. Lo agregado a mano
  en qBittorrent no aparece ahí. Se vio con descargas reales el 2026-11-06, incluido un pack de temporada agrupado. Los campos
  usados salen del `openapi.json` oficial: `title`, `size`, `sizeleft`, `timeleft`, `status`,
  `trackedDownloadState`, `trackedDownloadStatus`, `statusMessages`, `errorMessage` y `downloadId`, más
  `movie`, `series` y `episode` con `includeMovie`, `includeSeries` e `includeEpisode`.
- **Bot:** `agent.log` no sirve como latido, porque solo escribe cuando hay eventos. Saber si atiende
  pedidos requiere agregarle un latido en `pelis-bot`.

## Antes de usarla
Requieren OK del usuario:
- **Firewall, con permisos de administrador:** puerto del backend solo desde `192.168.1.0/24`,
  `100.64.0.0/10` y `fd7a:115c:a1e0::/48`, en perfil Privado. Además, `Seerr (Tailscale)` para 5055.
- **Herramientas:** no hace falta instalar nada. Android Studio trae el JDK en `jbr`, y el SDK y el emulador `Pixel_10_Pro` ya están.

Los hace el usuario:
- **Celu:** todavía no está en la cuenta de Tailscale, y tiene que permitir instalar el APK a mano.
- **Copia de la clave de firma:** conviene guardar `~/.lp-media-center-firma` en otro lado.

## Repo público y actualizaciones
Repo público: `github.com/mmunozpatino/lp-media-center`, para que las apps se actualicen sin la PC prendida. Se publicó sin
el historial anterior, que tenía datos personales; ese historial queda solo en esta PC, en la rama local `historial-privado`.
**No subir datos personales:** IP reales, nombre de usuario de Windows, nombre de la PC, mails ni nombres de quienes piden.
En los tests van IP y nombres de ejemplo. Los commits usan el mail privado de GitHub, configurado solo en este repo.

- **Cada push a main** corre `.github/workflows/version.yml`: tests, APK firmado y `LP-Cine-Vault-Setup.exe`, y publica
  la versión `v0.1.<número de corrida>` con los dos archivos.
- **Versión de cada app:** `scripts/build-info.mjs` escribe `ui/build-info.json`, que no se commitea. Sin ese archivo, la app es
  de desarrollo y no busca actualizaciones.
- **Aviso:** la app consulta `api.github.com` al abrir y cada 6 horas, y cuando se pide en Settings, "Versión", con "Buscar
  actualizaciones" (ahí el aviso aparece aunque se haya tocado "Más tarde"). Si hay una más nueva, ofrece descargarla: en Android el
  APK con "Actualizar ahora" (`AppUpdater.java` y `installUpdate` de `LpNetworkPlugin`): misma validación que en Windows, baja a la
  caché y abre el cartel de Android con el FileProvider, que siempre pide confirmar. La primera vez abre el ajuste "instalar apps
  desconocidas" (`REQUEST_INSTALL_PACKAGES`). Probado el 2026-11-08 en el emulador, de un 0.1.7 local a la 0.1.8 publicada; Play
  Protect pidió escanearla la primera vez. En Windows, "Actualizar ahora" (`electron/updater.cjs`, por `electron/preload.cjs`) baja el instalador de la API de GitHub,
  comprueba tamaño y SHA-256 (`digest` del asset) y lo corre con `--updated /S --force-run`: cierra la app y su backend
  (`build/installer.nsh`), instala en silencio y la vuelve a abrir. Qué bajar lo decide el proceso principal, nunca la interfaz.
  Probado el 2026-11-08 de punta a punta, de un 0.1.5 local a la 0.1.6 publicada. Si falla, ofrece bajarla a mano.
  El aviso lista los títulos de la release nueva. Hasta el 2026-11-07 la CSP no dejaba leer `build-info.json` en Windows
  (`app://` no entra en `http:`), así que la app de Windows nunca avisó; ahora `connect-src` incluye `'self'`.
- **Novedades (changelog):** salen de los mensajes de commit, así que **cada mensaje es público y lo lee la usuaria en la app**:
  en español, entendible y sin datos personales. Primera línea = título; el cuerpo, sin `Co-Authored-By` ni `Signed-off-by`,
  es la explicación. `scripts/changelog.mjs` toma los tags `v0.1.*` que son ancestros de HEAD: cada versión son los commits
  desde el tag anterior, y la nueva, los que van del último tag a HEAD (si una corrida falló sin publicar, sus commits pasan a
  la siguiente). Por eso el workflow hace checkout con `fetch-depth: 0`. `build-info.mjs` escribe además `ui/changelog.json`
  (últimas 40 versiones, no se commitea), y el job `publicar` usa `changelog.mjs --notas` como texto de la release.
- **Diálogo de novedades:** al abrir, si la versión de `build-info.json` es más nueva que la guardada en `localStorage`
  (`lp-media-center:novedades-vistas`), muestra los cambios de las versiones posteriores a esa, y la guarda al cerrarlo (con
  "Listo" o Escape). Sin versión guardada muestra solo la actual: no se distingue una instalación nueva de una
  actualización desde una versión sin novedades. En desarrollo no muestra nada. Muestra solo la versión instalada, aunque se hayan salteado otras; en Settings, "Novedades", también se ve solo esa. Las anteriores, con "Ver versiones anteriores en GitHub" (pedido de la usuaria el 2026-11-08: sin historial en la app).
- **Firma del APK:** clave en `~/.lp-media-center-firma` (`lp-release.jks` y `clave.txt`), fuera del repo. En GitHub está en los
  secretos `ANDROID_KEYSTORE_BASE64` y `ANDROID_KEYSTORE_PASSWORD`. **Si se pierde, hay que desinstalar la app en cada
  dispositivo.** `npm run apk` la usa si está, para que el APK local también se instale encima.
- **Cambio de firma del 2026-11-07:** los APK anteriores estaban firmados con la clave de depuración. En cada celu o tablet
  hay que desinstalar una vez y volver a emparejar.

## Instalación
Instalada el 2026-11-06 en `%LOCALAPPDATA%\Programs\LP Media Center`, con `Setup /S` desde una pestaña del panel Terminal.
El Setup y el primer arranque no pueden correr desde Bash ni PowerShell de Claude (ver "AppData virtualizado"). Esa pestaña pide
una aprobación, así que una tarea programada sin la usuaria presente no puede instalar.

Comprobado ese día desde esa pestaña: la app abre y lanza su backend, que responde datos reales y escucha solo en
`127.0.0.1:8787`; existe `electron.app.LP Media Center` en `HKCU\...\Run`, apuntando al `.exe`; el backend sigue al
cerrar la ventana, y reabrir con el puerto ocupado funciona, con un solo proceso escuchando.

Para actualizar: `npm run dist` y volver a instalar. El backend queda corriendo y conserva la versión vieja hasta que termine.

## Sin probar
- **La app en un celular real:** Wi-Fi que deje ver a la PC, firewall desde otro equipo, Tailscale desde afuera. Se probó en el
  emulador (Android 17): emparejar buscando en la red, login, botones simulados, reabrir, IP cambiada y subred desconocida. Ahí
  el tráfico entra por loopback y no pasa por el firewall.
- **Pausar y reanudar con qBittorrent real:** solo tests y botón simulado.
- **El inicio real tras reiniciar Windows:** solo se comprobó el valor en el registro.
- **Reinstalar:** el backend corre con el mismo nombre de `.exe` que la app; no se probó qué hace el instalador si está corriendo.
- **Conectar y desconectar Tailscale en real:** solo pasó por tests, incluido si Windows lo deja sin permisos de
  administrador.
- **Frenar y levantar en los programas reales, salvo Prowlarr:** Prowlarr se probó de verdad desde la app el
  2026-11-05 (frenó en 2 s y volvió en 4 s, sin avisos en Radarr ni Sonarr), lo que valida `sc.exe` en un servicio.
  El resto solo pasó por tests y por un backend simulado, sobre todo qBittorrent con su bandeja, Jellyfin al
  forzar el cierre y Seerr y el bot por sus tareas. Apagar y prender todo tampoco se probó en real.
- Un pedido real que espere aprobación o que haya fallado: al 2026-11-05 solo había uno aprobado, *Wildwood*, que
  sigue sin bajarse porque Radarr lo marca en cines.
- La caída real de un programa en la app. Se comprobó con tests y un backend simulado, sin detener servicios.
- El cambio automático entre LAN y Tailscale.
- Seerr desde el celu: abre en el navegador del sistema, no dentro de la app. No se probó iniciar sesión.

## Trampa de esta PC: AppData virtualizado
La app de escritorio de Claude es una app empaquetada. Lo que sus herramientas Bash y PowerShell
escriben en `%APPDATA%`, `%LOCALAPPDATA%` o `HKCU` va a una copia privada que el resto de Windows no ve.
Para configuración por usuario o inicio automático, escribí y comprobá desde una pestaña del panel
Terminal, o usá una ruta fuera de AppData.

**Firewall:** una prueba desde la misma PC no vale, porque Windows no filtra esas conexiones. Probá
desde otro equipo o decí que no quedó comprobado.

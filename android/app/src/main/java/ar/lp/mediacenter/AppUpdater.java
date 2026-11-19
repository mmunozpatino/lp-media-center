package ar.lp.mediacenter;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Baja el APK de la última versión publicada en GitHub y comprueba que sea exactamente el publicado: dirección de
 * las versiones de este repo, tamaño y huella SHA-256 que informa version.json (publicado con cada versión; si falta,
 * la API de GitHub). Qué bajar lo decide esta clase, nunca la interfaz. Además, Android solo lo instala encima si está firmado con la misma clave.
 * Es la versión Android de electron/updater.cjs.
 */
final class AppUpdater {

    static final String REPO = "mmunozpatino/lp-media-center";
    static final String RELEASES_API = "https://api.github.com/repos/" + REPO + "/releases/latest";
    static final String APK_NAME = "LP-Cine-Vault.apk";
    static final String DOWNLOAD_PREFIX = "https://github.com/" + REPO + "/releases/download/";
    /** El APK pesa unos 4 MB; más que esto no es nuestro. */
    static final long MAX_BYTES = 100L * 1024 * 1024;
    private static final Pattern DIGEST = Pattern.compile("^sha256:([a-f0-9]{64})$");

    static final class Release {
        final String version;
        final String url;
        final String sha256;
        final long size;
        final String notes;

        Release(String version, String url, String sha256, long size, String notes) {
            this.version = version;
            this.url = url;
            this.sha256 = sha256;
            this.size = size;
            this.notes = notes;
        }
    }

    interface Progress {
        void update(long received, long total);
    }

    private AppUpdater() {}

    /** Si `candidate` es más nueva que `current`, comparando número por número. */
    static boolean isNewer(String candidate, String current) {
        int[] a = parts(candidate);
        int[] b = parts(current);
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int x = i < a.length ? a[i] : 0;
            int y = i < b.length ? b[i] : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    private static int[] parts(String text) {
        String[] pieces = (text == null ? "" : text.replaceFirst("^v", "")).split("\\.");
        int[] numbers = new int[pieces.length];
        for (int i = 0; i < pieces.length; i++) {
            try {
                numbers[i] = Integer.parseInt(pieces[i].replaceAll("[^0-9].*$", ""));
            } catch (NumberFormatException e) {
                numbers[i] = 0;
            }
        }
        return numbers;
    }

    static final String LATEST_PAGE = "https://github.com/" + REPO + "/releases/latest";
    private static final Pattern TAG = Pattern.compile("^(?:https://github\\.com)?/mmunozpatino/lp-media-center/releases/tag/(v\\d+(?:\\.\\d+){1,3})/?$");

    /**
     * La última versión sin la API (que tiene un límite de 60 consultas por hora por IP): github.com redirige
     * /releases/latest a la página de esa versión. Se pide solo la cabecera, sin seguir la redirección.
     */
    static String latestTag() throws Exception {
        HttpURLConnection connection = open(LATEST_PAGE);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod("HEAD");
        int code = connection.getResponseCode();
        Matcher tag = TAG.matcher(String.valueOf(connection.getHeaderField("Location")));
        connection.disconnect();
        if (code < 300 || code > 308 || !tag.matches()) throw new IOException("GitHub no informó la última versión.");
        return tag.group(1);
    }

    /** Si la API cortó por su límite: un mensaje con la hora para volver a probar. Null si no es eso. */
    static String rateLimitMessage(HttpURLConnection connection, int code) {
        String remaining = connection.getHeaderField("X-RateLimit-Remaining");
        if (code != 429 && !(code == 403 && "0".equals(remaining))) return null;
        String hour = null;
        try {
            long reset = Long.parseLong(connection.getHeaderField("X-RateLimit-Reset"));
            hour = new java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(new java.util.Date(reset * 1000));
        } catch (Exception ignored) {
            // Sin la hora, se dice "en una hora".
        }
        return "GitHub limitó las consultas por un rato: no es tu conexión. "
                + (hour != null ? "Probá de nuevo después de las " + hour + "." : "Probá de nuevo en una hora.");
    }

    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern VERSION_TAG = Pattern.compile("^v\\d+(?:\\.\\d+){1,3}$");
    /** version.json pesa menos de 1 KB más las novedades. */
    private static final int MAX_MANIFEST_BYTES = 256 * 1024;
    private static final int MAX_API_BYTES = 2 * 1024 * 1024;
    /** Hasta cuándo la API cortó por su límite (ms) y su mensaje: no se vuelve a consultar antes. */
    private static volatile long apiLimitedUntil = 0;
    private static volatile String apiLimitedMessage = "";

    /**
     * El APK de la última versión publicada, ya validado. Primero con version.json, que se baja como cualquier archivo
     * de la versión y no cuenta para el límite de la API de GitHub (60 consultas por hora por IP, compartidas por
     * todos los equipos de la casa). Solo si la versión no lo trae (las publicadas antes de que existiera), la API.
     */
    static Release latest() throws Exception {
        String tag = latestTag();
        Release release = fromManifest(tag);
        return release != null ? release : latestFromApi();
    }

    /**
     * Lee github.com/<repo>/releases/download/<tag>/version.json (lo arma scripts/version-json.mjs en el workflow).
     * Null si esa versión no lo trae. La dirección del APK la arma esta clase, nunca el archivo.
     */
    static Release fromManifest(String tag) throws Exception {
        if (!VERSION_TAG.matcher(String.valueOf(tag)).matches()) throw new IOException("Versión inválida.");
        HttpURLConnection connection = open(DOWNLOAD_PREFIX + tag + "/version.json");
        int code = connection.getResponseCode();
        if (code == 404) {
            connection.disconnect();
            return null;
        }
        if (code != 200) throw new IOException("GitHub respondió " + code + " al buscar la versión nueva.");
        JSONObject manifest;
        try {
            manifest = new JSONObject(readAll(connection.getInputStream(), MAX_MANIFEST_BYTES));
        } catch (org.json.JSONException e) {
            throw new IOException("La versión publicada trae un version.json dañado.");
        }
        return parseManifest(manifest, tag);
    }

    /** Valida version.json contra el tag. Separada para probarla sin red. */
    static Release parseManifest(JSONObject manifest, String tag) throws IOException {
        if (!VERSION_TAG.matcher(String.valueOf(tag)).matches()) throw new IOException("Versión inválida.");
        String version = manifest.optString("version", "");
        if (!version.equals(tag.substring(1))) throw new IOException("La versión publicada no coincide.");
        JSONObject assets = manifest.optJSONObject("assets");
        JSONObject apk = assets == null ? null : assets.optJSONObject(APK_NAME);
        if (apk == null) throw new IOException("La versión publicada no trae el APK.");
        String sha256 = apk.optString("sha256", "");
        if (!SHA256.matcher(sha256).matches()) throw new IOException("No se informa la huella del APK: no se puede comprobar.");
        Object rawSize = apk.opt("size");
        long size = rawSize instanceof Number ? ((Number) rawSize).longValue() : 0;
        if (size <= 0 || size > MAX_BYTES) throw new IOException("El tamaño del APK no es el esperado.");
        return new Release(version, DOWNLOAD_PREFIX + tag + "/" + APK_NAME, sha256, size, manifest.optString("notes", "").trim());
    }

    /** Lo mismo con la API de GitHub, solo para versiones sin version.json. */
    static Release latestFromApi() throws Exception {
        if (System.currentTimeMillis() < apiLimitedUntil) throw new IOException(apiLimitedMessage);
        HttpURLConnection connection = open(RELEASES_API);
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        int code = connection.getResponseCode();
        String limited = rateLimitMessage(connection, code);
        if (limited != null) {
            long until;
            try {
                until = Long.parseLong(connection.getHeaderField("X-RateLimit-Reset")) * 1000;
            } catch (Exception e) {
                until = System.currentTimeMillis() + 60 * 60 * 1000;
            }
            apiLimitedMessage = limited;
            apiLimitedUntil = until;
            throw new IOException(limited);
        }
        if (code != 200) throw new IOException("GitHub respondió " + code + " al buscar la versión nueva.");
        JSONObject release = new JSONObject(readAll(connection.getInputStream(), MAX_API_BYTES));
        JSONArray assets = release.optJSONArray("assets");
        for (int i = 0; assets != null && i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            if (!APK_NAME.equals(asset.optString("name"))) continue;
            String url = asset.optString("browser_download_url", "");
            if (!url.startsWith(DOWNLOAD_PREFIX) || !url.endsWith("/" + APK_NAME)) {
                throw new IOException("La dirección del APK no es la esperada.");
            }
            Matcher digest = DIGEST.matcher(asset.optString("digest", ""));
            if (!digest.matches()) throw new IOException("GitHub no informa la huella del APK: no se puede comprobar.");
            long size = asset.optLong("size", 0);
            if (size <= 0 || size > MAX_BYTES) throw new IOException("El tamaño del APK no es el esperado.");
            return new Release(release.optString("tag_name", "").replaceFirst("^v", ""), url, digest.group(1), size, release.optString("body", "").trim());
        }
        throw new IOException("La versión publicada no trae el APK.");
    }

    /** Baja el APK a `file` y comprueba tamaño y huella. Si algo falla, borra el archivo. */
    static void download(Release release, File file, Progress progress) throws Exception {
        HttpURLConnection connection = open(release.url);
        int code = connection.getResponseCode();
        if (code != 200) throw new IOException("GitHub respondió " + code + " al bajar el APK.");
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        long received = 0;
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                received += read;
                if (received > release.size) throw new IOException("El APK bajado es más grande de lo esperado.");
                sha.update(buffer, 0, read);
                out.write(buffer, 0, read);
                progress.update(received, release.size);
            }
        } catch (Exception e) {
            file.delete();
            throw e;
        }
        if (received != release.size) {
            file.delete();
            throw new IOException("El APK se bajó incompleto.");
        }
        if (!hex(sha.digest()).equals(release.sha256)) {
            file.delete();
            throw new IOException("La huella del APK no coincide: no se instala.");
        }
    }

    /** Solo HTTPS. Sigue las redirecciones de GitHub a su servidor de archivos, que también son HTTPS. */
    private static HttpURLConnection open(String address) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", "LP-Cine-Vault");
        return connection;
    }

    /** Lee todo como texto, hasta `max` bytes: más que eso no es lo esperado. */
    private static String readAll(InputStream in, int max) throws IOException {
        try (InputStream input = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (out.size() + read > max) throw new IOException("La respuesta de GitHub es más grande de lo esperado.");
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) text.append(String.format("%02x", b));
        return text.toString();
    }
}

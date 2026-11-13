package ar.lp.mediacenter;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.common.MlKitException;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import java.io.File;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lo que el JavaScript no puede hacer solo: ver la IP del Wi-Fi, abrir una web en el navegador, leer un QR y
 * recibir el enlace de emparejamiento cuando la cámara abre la app.
 */
@CapacitorPlugin(name = "LpNetwork")
public class LpNetworkPlugin extends Plugin {

    private static final String PAIR_SCHEME = "lpcinevault";

    /** Enlace del QR que todavía no leyó la interfaz. */
    private String pendingPairLink = null;

    private final ExecutorService updates = Executors.newSingleThreadExecutor();
    private volatile boolean updating = false;

    @Override
    public void load() {
        rememberPairLink(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        rememberPairLink(intent);
    }

    private void rememberPairLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data != null && PAIR_SCHEME.equals(data.getScheme())) {
            pendingPairLink = data.toString();
            // Que no se vuelva a leer si la actividad se recrea.
            intent.setData(null);
        }
    }

    /** Entrega el enlace del QR una sola vez. */
    @PluginMethod
    public void takePairLink(PluginCall call) {
        JSObject result = new JSObject();
        result.put("url", pendingPairLink == null ? JSObject.NULL : pendingPairLink);
        pendingPairLink = null;
        call.resolve(result);
    }

    /** Abre el lector de QR de Google Play Services y devuelve el texto leído. */
    @PluginMethod
    public void scanQr(PluginCall call) {
        GmsBarcodeScannerOptions options =
                new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanning.getClient(getActivity(), options)
                .startScan()
                .addOnSuccessListener(barcode -> {
                    JSObject result = new JSObject();
                    result.put("canceled", false);
                    result.put("text", barcode.getRawValue());
                    call.resolve(result);
                })
                .addOnCanceledListener(() -> {
                    JSObject result = new JSObject();
                    result.put("canceled", true);
                    call.resolve(result);
                })
                .addOnFailureListener(error -> {
                    // Cerrar el lector no es una falla. Con la X llega como cancelado; con "atrás", el lector
                    // devuelve el error interno 13 ("Failed to scan code"), comprobado en el emulador.
                    int code = error instanceof MlKitException ? ((MlKitException) error).getErrorCode() : -1;
                    if (code == MlKitException.CANCELLED || code == MlKitException.INTERNAL) {
                        JSObject result = new JSObject();
                        result.put("canceled", true);
                        call.resolve(result);
                        return;
                    }
                    android.util.Log.w("LpNetwork", "Lector de QR, error " + code, error);
                    call.reject("No se pudo abrir el lector de QR. Revisá que Google Play Services esté actualizado.");
                });
    }

    /**
     * "Actualizar ahora": baja el APK de la última versión, lo comprueba (AppUpdater) y abre el cartel de instalación
     * de Android, que siempre pide confirmar. Responde varias veces: { state: "progress", received, total } mientras
     * baja y { state: "installing", version } al abrir el cartel. Si Android todavía no deja que esta app instale,
     * abre ese ajuste y responde { state: "permission" }.
     */
    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void installUpdate(PluginCall call) {
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(settings);
            JSObject result = new JSObject();
            result.put("state", "permission");
            call.resolve(result);
            return;
        }
        String current = currentVersion();
        if (current == null) {
            call.reject("Esta es una versión de desarrollo: no se actualiza sola.");
            return;
        }
        if (updating) {
            call.reject("Ya se está actualizando.");
            return;
        }
        updating = true;
        call.setKeepAlive(true);
        updates.execute(() -> {
            try {
                AppUpdater.Release release = AppUpdater.latest();
                if (!AppUpdater.isNewer(release.version, current)) throw new IOException("Ya tenés la última versión.");
                File dir = new File(context.getCacheDir(), "actualizacion");
                File[] old = dir.listFiles();
                if (old != null) for (File file : old) file.delete();
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No se pudo guardar el APK.");
                File apk = new File(dir, "LP-Cine-Vault-" + release.version + ".apk");
                final int[] lastPercent = { -1 };
                AppUpdater.download(release, apk, (received, total) -> {
                    int percent = (int) (received * 100 / total);
                    if (percent == lastPercent[0]) return;
                    lastPercent[0] = percent;
                    JSObject progress = new JSObject();
                    progress.put("state", "progress");
                    progress.put("received", received);
                    progress.put("total", total);
                    call.resolve(progress);
                });
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(install);
                JSObject result = new JSObject();
                result.put("state", "installing");
                result.put("version", release.version);
                call.setKeepAlive(false);
                call.resolve(result);
            } catch (Exception e) {
                android.util.Log.w("LpNetwork", "Actualización", e);
                call.setKeepAlive(false);
                String message = e instanceof IOException && e.getMessage() != null ? e.getMessage() : "No se pudo actualizar. Revisá la conexión a internet.";
                call.reject(message);
            } finally {
                updating = false;
            }
        });
    }

    /** { tag: "v0.1.15" }: la última versión publicada, de la redirección de github.com (sin el límite de la API). */
    @PluginMethod
    public void latestVersion(PluginCall call) {
        updates.execute(() -> {
            try {
                JSObject result = new JSObject();
                result.put("tag", AppUpdater.latestTag());
                call.resolve(result);
            } catch (Exception e) {
                call.reject(e instanceof IOException && e.getMessage() != null ? e.getMessage() : "No se pudo consultar GitHub.");
            }
        });
    }

    /** La versión instalada, la que pone el workflow. Null si es de desarrollo. */
    private String currentVersion() {
        try {
            String name = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
            return name == null || name.contains("dev") ? null : name;
        } catch (Exception e) {
            return null;
        }
    }

    /** Devuelve la IP privada del Wi-Fi o Ethernet. Ignora VPN como Tailscale y los datos móviles. */
    @PluginMethod
    public void getLocalIpv4(PluginCall call) {
        ConnectivityManager manager =
                (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        JSObject result = new JSObject();
        result.put("ip", JSObject.NULL);
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities == null
                    || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                    || !(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                            || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) {
                continue;
            }
            LinkProperties properties = manager.getLinkProperties(network);
            if (properties == null) continue;
            for (LinkAddress linkAddress : properties.getLinkAddresses()) {
                InetAddress address = linkAddress.getAddress();
                if (address instanceof Inet4Address && address.isSiteLocalAddress()) {
                    result.put("ip", address.getHostAddress());
                    call.resolve(result);
                    return;
                }
            }
        }
        call.resolve(result);
    }

    /** Abre http o https en el navegador del celular. Cualquier otro esquema se rechaza. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            call.reject("Dirección no permitida");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}

package ar.lp.mediacenter;

import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.common.MlKitException;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import java.net.Inet4Address;
import java.net.InetAddress;

/**
 * Lo que el JavaScript no puede hacer solo: ver la IP del Wi-Fi, abrir una web en el navegador, leer un QR y
 * recibir el enlace de emparejamiento cuando la cámara abre la app.
 */
@CapacitorPlugin(name = "LpNetwork")
public class LpNetworkPlugin extends Plugin {

    private static final String PAIR_SCHEME = "lpcinevault";

    /** Enlace del QR que todavía no leyó la interfaz. */
    private String pendingPairLink = null;

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

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

import java.net.Inet4Address;
import java.net.InetAddress;

/** Lo que el JavaScript no puede hacer solo: ver la IP del Wi-Fi y abrir una web en el navegador. */
@CapacitorPlugin(name = "LpNetwork")
public class LpNetworkPlugin extends Plugin {

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

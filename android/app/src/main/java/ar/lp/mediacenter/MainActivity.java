package ar.lp.mediacenter;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LpNetworkPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

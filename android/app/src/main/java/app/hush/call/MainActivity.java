package app.hush.call;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Hush's own Android code (background calls, screen sharing) — see HushNativePlugin.
        registerPlugin(HushNativePlugin.class);
        super.onCreate(savedInstanceState);
        // Blocks screenshots and screen recording of this app, hides it from the
        // recent-apps preview, and keeps it off screen sharing and casting.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}

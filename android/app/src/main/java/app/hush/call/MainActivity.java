package app.hush.call;

import android.app.PictureInPictureParams;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** A video call is on: leaving the app shrinks it into a floating window, like WhatsApp. */
    private static volatile boolean floatingAllowed;
    private static MainActivity current;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Hush's own Android code (background calls, screen sharing, sound) — see HushNativePlugin.
        registerPlugin(HushNativePlugin.class);
        super.onCreate(savedInstanceState);
        current = this;
        // Blocks screenshots and screen recording of this app, hides it from the
        // recent-apps preview, and keeps it off screen sharing and casting.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override
    public void onDestroy() {
        if (current == this) current = null;
        super.onDestroy();
    }

    /** Called from the page: a video call started or ended. */
    static void setFloatingAllowed(boolean allowed) {
        floatingAllowed = allowed;
        MainActivity activity = current;
        if (activity != null) activity.runOnUiThread(activity::applyPipParams);
    }

    /** Shrink into the floating window now (Back during a video call). */
    static boolean enterFloating() {
        MainActivity activity = current;
        if (activity == null || !floatingAllowed || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        activity.runOnUiThread(() -> {
            try {
                activity.enterPictureInPictureMode(activity.pipParams());
            } catch (Exception ignored) {
                activity.moveTaskToBack(true);
            }
        });
        return true;
    }

    private void applyPipParams() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                setPictureInPictureParams(pipParams());
            } catch (Exception ignored) {
                // Floating windows turned off for Hush in the phone's settings.
            }
        }
    }

    private PictureInPictureParams pipParams() {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder().setAspectRatio(new Rational(3, 4));
        // Android 12+: swiping Home during a video call floats it automatically.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(floatingAllowed);
        return builder.build();
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Older Android: float when the user presses Home during a video call.
        if (floatingAllowed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            try {
                enterPictureInPictureMode(pipParams());
            } catch (Exception ignored) {
                // Not allowed on this phone: the call simply keeps going in the background.
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        HushNativePlugin.emitFloating(inPip);
    }
}

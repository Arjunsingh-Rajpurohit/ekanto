package app.hush.call;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The Android side of Hush, used from src/native.ts:
 * keeps a call alive in the background, and shares the phone's screen into the call.
 */
@CapacitorPlugin(name = "HushNative")
public class HushNativePlugin extends Plugin {

    private static HushNativePlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** A screen frame (JPEG, base64) for the page to paint into the call. */
    static void emitFrame(String jpegBase64, int width, int height) {
        HushNativePlugin plugin = instance;
        if (plugin == null) return;
        JSObject frame = new JSObject();
        frame.put("data", jpegBase64);
        frame.put("width", width);
        frame.put("height", height);
        plugin.notifyListeners("frame", frame);
    }

    /** Android stopped the screen share (from its own notification or "Stop sharing"). */
    static void emitScreenStopped() {
        HushNativePlugin plugin = instance;
        if (plugin != null) plugin.notifyListeners("screenStopped", new JSObject());
    }

    @PluginMethod
    public void startCall(PluginCall call) {
        try {
            ContextCompat.startForegroundService(getContext(), CallService.intent(getContext(), CallService.ACTION_CALL));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not keep the call running in the background", e);
        }
    }

    @PluginMethod
    public void endCall(PluginCall call) {
        getContext().stopService(new Intent(getContext(), CallService.class));
        call.resolve();
    }

    @PluginMethod
    public void startScreen(PluginCall call) {
        MediaProjectionManager manager = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        // Android shows its own "Start recording or casting?" prompt; nothing happens without a yes.
        startActivityForResult(call, manager.createScreenCaptureIntent(), "onScreenConsent");
    }

    @ActivityCallback
    private void onScreenConsent(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        try {
            Intent intent = CallService.intent(getContext(), CallService.ACTION_SCREEN)
                .putExtra(CallService.EXTRA_CODE, result.getResultCode())
                .putExtra(CallService.EXTRA_DATA, result.getData());
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start screen sharing", e);
        }
    }

    @PluginMethod
    public void stopScreen(PluginCall call) {
        try {
            getContext().startService(CallService.intent(getContext(), CallService.ACTION_STOP_SCREEN));
        } catch (Exception ignored) {
            // The service is already gone: nothing is being shared.
        }
        call.resolve();
    }
}

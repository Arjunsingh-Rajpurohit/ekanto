package app.hush.call;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The Android side of Ekanto, used from src/native.ts:
 * keeps a call alive in the background, and shares the phone's screen into the call.
 */
@CapacitorPlugin(
    name = "HushNative",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class HushNativePlugin extends Plugin {

    private static volatile HushNativePlugin instance;
    /** What the app was opened for (a ringing call), until the page asks. */
    private static JSObject launch;
    private AudioRoutes audio;

    @Override
    public void load() {
        instance = this;
        audio = new AudioRoutes(getContext(), () -> notifyListeners("audioRoutes", routes()));
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /** True while the page is running (it then handles rings itself as well). */
    static boolean isAlive() {
        return instance != null;
    }

    /** A sealed ring heard by the background listener, for the page. False if the page isn't running. */
    static boolean emitRingData(String topic, String data) {
        HushNativePlugin plugin = instance;
        if (plugin == null) return false;
        JSObject event = new JSObject();
        event.put("topic", topic);
        event.put("data", data);
        plugin.notifyListeners("ringData", event);
        return true;
    }

    /** The app was opened from the ringing notification: the call screen, or "Answer". */
    static synchronized void setLaunch(String action, String call, String channel, String from, boolean voice, String why) {
        JSObject l = new JSObject();
        l.put("action", action);
        l.put("call", call);
        l.put("channel", channel);
        l.put("from", from);
        l.put("voice", voice);
        if (why != null) l.put("why", why);
        launch = l;
        HushNativePlugin plugin = instance;
        if (plugin != null) plugin.notifyListeners("launch", new JSObject());
    }

    private JSObject routes() {
        JSObject out = new JSObject();
        JSArray list = new JSArray();
        for (String r : audio.available()) list.put(r);
        out.put("routes", list);
        out.put("current", audio.current());
        return out;
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

    /** The call shrank into (or came back from) the floating window. */
    static void emitFloating(boolean floating) {
        HushNativePlugin plugin = instance;
        if (plugin == null) return;
        JSObject event = new JSObject();
        event.put("floating", floating);
        plugin.notifyListeners("floating", event);
    }

    /** "Hang up" tapped in the notification. */
    static void emitHangUp() {
        HushNativePlugin plugin = instance;
        if (plugin != null) plugin.notifyListeners("hangUp", new JSObject());
    }

    /** Android stopped the screen share (from its own notification or "Stop sharing"). */
    static void emitScreenStopped() {
        HushNativePlugin plugin = instance;
        if (plugin != null) plugin.notifyListeners("screenStopped", new JSObject());
    }

    @PluginMethod
    public void startCall(PluginCall call) {
        try {
            audio.start(call.getBoolean("voice", false));
            ContextCompat.startForegroundService(getContext(), CallService.intent(getContext(), CallService.ACTION_CALL));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not keep the call running in the background", e);
        }
    }

    @PluginMethod
    public void endCall(PluginCall call) {
        audio.stop();
        MainActivity.setFloatingAllowed(false);
        MainActivity.closeFloating();
        MainActivity.setShowOverLock(false);
        getContext().stopService(new Intent(getContext(), CallService.class));
        call.resolve();
    }

    /** Which outputs exist right now (speaker, earpiece, bluetooth, wired) and which one is used. */
    @PluginMethod
    public void getAudioRoutes(PluginCall call) {
        call.resolve(routes());
    }

    @PluginMethod
    public void setAudioRoute(PluginCall call) {
        if (audio.select(call.getString("route"))) call.resolve(routes());
        else call.reject("That output isn't available");
    }

    /** A video is showing: leaving the app floats the call in a small window. */
    @PluginMethod
    public void setFloating(PluginCall call) {
        MainActivity.setFloatingAllowed(call.getBoolean("allowed", false));
        call.resolve();
    }

    /** Back during a video call: float instead of leaving. False when not possible. */
    @PluginMethod
    public void enterFloating(PluginCall call) {
        JSObject out = new JSObject();
        out.put("floating", MainActivity.enterFloating());
        call.resolve(out);
    }

    /** The camera went on/off: earpiece-and-screen-off behaviour follows. */
    @PluginMethod
    public void setVoiceCall(PluginCall call) {
        audio.setVoiceCall(call.getBoolean("voice", false));
        call.resolve();
    }

    /* ---------- Saved channels: ringing while Ekanto is closed ---------- */

    /** The page's saved channels (only their ring part) and your name, for the background listener. */
    @PluginMethod
    public void setChannels(PluginCall call) {
        JSArray channels = call.getArray("channels", new JSArray());
        RingService.prefs(getContext()).edit()
            .putString("name", call.getString("name", "Someone"))
            .putString("channels", channels.toString())
            .apply();
        if (RingService.hasChannels(getContext())) RingService.start(getContext());
        else RingService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void ringStatus(PluginCall call) {
        call.resolve(ringState());
    }

    private JSObject ringState() {
        Context context = getContext();
        JSObject out = new JSObject();
        out.put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled());
        out.put("fullScreen", Build.VERSION.SDK_INT < 34 || context.getSystemService(NotificationManager.class).canUseFullScreenIntent());
        out.put("battery", context.getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(context.getPackageName()));
        return out;
    }

    /** Asks for one of the three things ringing needs, or opens the right page of Android's settings. */
    @PluginMethod
    public void ringSetting(PluginCall call) {
        String which = call.getString("which", "");
        Context context = getContext();
        Uri pkg = Uri.parse("package:" + context.getPackageName());
        try {
            if ("notifications".equals(which)) {
                if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
                    requestPermissionForAlias("notifications", call, "onNotifications");
                    return;
                }
                openNotificationSettings();
            } else if ("fullScreen".equals(which) && Build.VERSION.SDK_INT >= 34) {
                getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg));
            } else if ("battery".equals(which)) {
                // Ekanto is not on Google Play, so it may ask this directly: one tap, "Allow".
                getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg));
            }
        } catch (Exception e) {
            getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg));
        }
        call.resolve(ringState());
    }

    @PermissionCallback
    private void onNotifications(PluginCall call) {
        // Said no before: Android won't ask again, so show the switch in settings instead.
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) openNotificationSettings();
        call.resolve(ringState());
    }

    private void openNotificationSettings() {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        getActivity().startActivity(intent);
    }

    /** Answered or declined inside the app. */
    @PluginMethod
    public void stopRinging(PluginCall call) {
        RingService.stopRinging(call.getString("call"), call.getBoolean("keepOverLock", false));
        call.resolve();
    }

    /** Why the app was opened (a ringing call), and what happened while the page wasn't running. */
    @PluginMethod
    public void takeLaunch(PluginCall call) {
        JSObject out;
        synchronized (HushNativePlugin.class) {
            out = launch != null ? launch : new JSObject();
            launch = null;
        }
        SharedPreferences prefs = RingService.prefs(getContext());
        try {
            JSONObject pending = new JSONObject(prefs.getString("pending", "{}"));
            out.put("missed", pending.optJSONArray("missed") != null ? pending.optJSONArray("missed") : new JSONArray());
            out.put("gone", pending.optJSONArray("gone") != null ? pending.optJSONArray("gone") : new JSONArray());
        } catch (Exception ignored) {
            // Nothing pending.
        }
        prefs.edit().remove("pending").apply();
        call.resolve(out);
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

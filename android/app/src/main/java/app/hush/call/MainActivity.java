package app.hush.call;

import android.Manifest;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.WindowManager;
import androidx.annotation.RequiresApi;
import com.getcapacitor.BridgeActivity;
import java.util.function.Consumer;

public class MainActivity extends BridgeActivity {

    /** A video call is on: leaving the app shrinks it into a floating window, like WhatsApp. */
    private static volatile boolean floatingAllowed;
    private static MainActivity current;
    /** Ekanto is on screen: a ring plays here instead of as a notification. */
    static volatile boolean visible;
    /** Android 15+: tells us when a screen recorder is on (its picture is black anyway — FLAG_SECURE). */
    private Consumer<Integer> recordingWatch;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Ekanto's own Android code (background calls, screen sharing, sound) — see HushNativePlugin.
        registerPlugin(HushNativePlugin.class);
        super.onCreate(savedInstanceState);
        current = this;
        // Blocks screenshots and screen recording of this app, hides it from the
        // recent-apps preview, and keeps it off screen sharing and casting.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        watchScreenRecording();
        handleCallIntent(getIntent());
    }

    /**
     * Android 15+ can say when a recorder captures this app, so a protected call can tell everyone
     * "Ravi's phone tried to record — blocked". Older Android just records black (FLAG_SECURE above).
     */
    private void watchScreenRecording() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return;
        // A normal permission, granted at install from the manifest; checked anyway, as the platform asks.
        if (checkSelfPermission(Manifest.permission.DETECT_SCREEN_RECORDING) != PackageManager.PERMISSION_GRANTED) return;
        Consumer<Integer> watch = state -> HushNativePlugin.emitRecording(state == WindowManager.SCREEN_RECORDING_STATE_VISIBLE);
        try {
            int now = getWindowManager().addScreenRecordingCallback(getMainExecutor(), watch);
            recordingWatch = watch;
            if (now == WindowManager.SCREEN_RECORDING_STATE_VISIBLE) HushNativePlugin.emitRecording(true);
        } catch (Exception ignored) {
            // No callback on this phone: FLAG_SECURE still blacks the recording.
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleCallIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        visible = false;
        RingService.appHidden();
        super.onPause();
    }

    /** Opened from a ringing call: show it over the lock screen, like a phone call. */
    private void handleCallIntent(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        boolean answer = RingService.ACTION_ANSWER.equals(action);
        if (RingService.ACTION_TEST_SEEN.equals(action)) {
            // The test ring was seen: that is all it had to prove.
            RingService.decline(RingService.TEST_CALL);
            intent.setAction(Intent.ACTION_MAIN);
            return;
        }
        if (!answer && !RingService.ACTION_INCOMING.equals(action)) return;
        String call = intent.getStringExtra(RingService.EXTRA_CALL);
        showOverLock(true);
        HushNativePlugin.setLaunch(answer ? "answer" : "incoming", call, intent.getStringExtra(RingService.EXTRA_CHANNEL),
            intent.getStringExtra(RingService.EXTRA_FROM), intent.getBooleanExtra(RingService.EXTRA_VOICE, false),
            intent.getStringExtra(RingService.EXTRA_WHY));
        if (answer) RingService.stopRinging(call, true);
        // Handled once: turning the phone around must not answer it again.
        intent.setAction(Intent.ACTION_MAIN);
    }

    /** True while ringing or in a call answered from the lock screen; false again afterwards. */
    static void setShowOverLock(boolean on) {
        MainActivity activity = current;
        if (activity != null) activity.runOnUiThread(() -> activity.showOverLock(on));
    }

    private void showOverLock(boolean on) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(on);
            setTurnScreenOn(on);
        } else if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    @Override
    public void onDestroy() {
        if (current == this) current = null;
        if (recordingWatch != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            getWindowManager().removeScreenRecordingCallback(recordingWatch);
            recordingWatch = null;
        }
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

    /** The call ended while floating: close the small window too, like a phone call does. */
    static void closeFloating() {
        MainActivity activity = current;
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (activity.isInPictureInPictureMode()) activity.moveTaskToBack(true);
        });
    }

    private void applyPipParams() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                setPictureInPictureParams(pipParams());
            } catch (Exception ignored) {
                // Floating windows turned off for Ekanto in the phone's settings.
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
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

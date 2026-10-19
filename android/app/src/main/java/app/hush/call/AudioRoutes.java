package app.hush.call;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import java.util.ArrayList;
import java.util.List;

/**
 * Where the call's sound comes out: speaker, earpiece, Bluetooth or wired headphones.
 * Like WhatsApp: a voice call starts on the earpiece, a video call on the speaker, and plugging in
 * headphones or connecting Bluetooth moves the sound there by itself.
 */
final class AudioRoutes {

    interface Listener {
        void onChanged();
    }

    static final String SPEAKER = "speaker";
    static final String EARPIECE = "earpiece";
    static final String BLUETOOTH = "bluetooth";
    static final String WIRED = "wired";

    private final AudioManager audio;
    private final PowerManager power;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock proximity;
    private String chosen;
    private boolean voiceCall;
    private boolean active;

    private final AudioDeviceCallback deviceCallback = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
            if (!active) return;
            // New headphones or Bluetooth: the sound goes there, as people expect.
            for (AudioDeviceInfo d : added) {
                String type = typeOf(d.getType());
                if (BLUETOOTH.equals(type) || WIRED.equals(type)) {
                    main.postDelayed(() -> select(type), 600);
                    break;
                }
            }
            listener.onChanged();
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            if (!active) return;
            for (AudioDeviceInfo d : removed) {
                if (chosen != null && chosen.equals(typeOf(d.getType()))) {
                    main.postDelayed(() -> select(defaultRoute()), 300);
                    break;
                }
            }
            listener.onChanged();
        }
    };

    AudioRoutes(Context context, Listener listener) {
        this.audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        this.power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        this.listener = listener;
    }

    /** Call starts: talk mode, the right default output, and watch for headsets coming and going. */
    void start(boolean isVoiceCall) {
        voiceCall = isVoiceCall;
        active = true;
        audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        audio.registerAudioDeviceCallback(deviceCallback, main);
        select(defaultRoute());
    }

    void stop() {
        if (!active) return;
        active = false;
        audio.unregisterAudioDeviceCallback(deviceCallback);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.clearCommunicationDevice();
        } else {
            audio.setSpeakerphoneOn(false);
            audio.stopBluetoothSco();
            audio.setBluetoothScoOn(false);
        }
        audio.setMode(AudioManager.MODE_NORMAL);
        setProximity(false);
        chosen = null;
    }

    /** Voice or video right now (camera turned on in a voice call = like a video call). */
    void setVoiceCall(boolean isVoiceCall) {
        voiceCall = isVoiceCall;
        updateProximity();
    }

    String current() {
        return chosen == null ? defaultRoute() : chosen;
    }

    List<String> available() {
        List<String> out = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (AudioDeviceInfo d : audio.getAvailableCommunicationDevices()) {
                String type = typeOf(d.getType());
                if (type != null && !out.contains(type)) out.add(type);
            }
        } else {
            out.add(SPEAKER);
            if (hasEarpiece()) out.add(EARPIECE);
            for (AudioDeviceInfo d : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                String type = typeOf(d.getType());
                if ((BLUETOOTH.equals(type) || WIRED.equals(type)) && !out.contains(type)) out.add(type);
            }
        }
        // A fixed, familiar order.
        List<String> ordered = new ArrayList<>();
        for (String t : new String[] { BLUETOOTH, WIRED, EARPIECE, SPEAKER }) if (out.contains(t)) ordered.add(t);
        return ordered;
    }

    /** Sends the sound to one output. Returns false when it isn't there. */
    boolean select(String type) {
        if (!active || type == null) return false;
        boolean ok;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ok = false;
            for (AudioDeviceInfo d : audio.getAvailableCommunicationDevices()) {
                if (type.equals(typeOf(d.getType()))) {
                    ok = audio.setCommunicationDevice(d);
                    break;
                }
            }
        } else {
            ok = true;
            if (BLUETOOTH.equals(type)) {
                audio.setSpeakerphoneOn(false);
                audio.startBluetoothSco();
                audio.setBluetoothScoOn(true);
            } else {
                audio.stopBluetoothSco();
                audio.setBluetoothScoOn(false);
                audio.setSpeakerphoneOn(SPEAKER.equals(type));
            }
        }
        if (ok) chosen = type;
        updateProximity();
        listener.onChanged();
        return ok;
    }

    private String defaultRoute() {
        List<String> all = available();
        if (all.contains(BLUETOOTH)) return BLUETOOTH;
        if (all.contains(WIRED)) return WIRED;
        if (voiceCall && all.contains(EARPIECE)) return EARPIECE;
        return SPEAKER;
    }

    /** On the earpiece in a voice call, the screen turns off at your ear (no cheek-presses). */
    private void updateProximity() {
        setProximity(active && voiceCall && EARPIECE.equals(chosen));
    }

    private void setProximity(boolean on) {
        if (on) {
            if (proximity == null && power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                proximity = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "hush:proximity");
            }
            if (proximity != null && !proximity.isHeld()) proximity.acquire();
        } else if (proximity != null && proximity.isHeld()) {
            proximity.release();
        }
    }

    private boolean hasEarpiece() {
        for (AudioDeviceInfo d : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) return true;
        }
        return false;
    }

    private static String typeOf(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return SPEAKER;
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return EARPIECE;
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
                return BLUETOOTH;
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
                return WIRED;
            default:
                return null;
        }
    }
}

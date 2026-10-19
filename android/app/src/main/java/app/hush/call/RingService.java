package app.hush.call;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Lets a saved channel ring this phone while Hush is closed — like WhatsApp, but without Google's
 * push service and without a server of our own. It keeps a few quiet connections to the public ring
 * relays, listening on each channel's ring topic for today. A ring it can open (sealed with a
 * channel's key) shows the incoming-call screen; everything else is ignored.
 *
 * Android only lets an app stay connected like this from a "foreground service" with a notification:
 * "Hush is ready for calls". It holds only the ring part of each channel's secret, never a call.
 */
public class RingService extends Service {

    static final String ACTION_START = "app.hush.call.RING_START";
    static final String ACTION_KEEPALIVE = "app.hush.call.RING_KEEPALIVE";
    static final String ACTION_DECLINE = "app.hush.call.RING_DECLINE";
    /** Opening the app for a ring: the call screen, or "Answer" in the notification. */
    static final String ACTION_INCOMING = "app.hush.call.INCOMING";
    static final String ACTION_ANSWER = "app.hush.call.ANSWER";
    static final String EXTRA_CALL = "call";
    static final String EXTRA_CHANNEL = "channel";
    static final String EXTRA_FROM = "from";
    static final String EXTRA_VOICE = "voice";

    static final String PREFS = "hush.ring";
    private static final String READY_CHANNEL = "ready";
    private static final String RING_CHANNEL = "ring";
    private static final String MISSED_CHANNEL = "missed";
    private static final int READY_ID = 8;
    /** Rings repeat every 4 s; nothing heard for this long = the caller gave up. */
    private static final long RING_GAP_MS = 12000;
    private static final long MAX_AGE_MS = 90000;
    /** How often the phone wakes to check its connections (Android allows about every 10 minutes). */
    private static final long KEEPALIVE_MS = 10 * 60 * 1000;
    private static final long[] VIBRATION = { 0, 700, 600, 700, 600 };
    /** Must match RING_MQTT / RING_NOSTR in src/relays.ts. */
    private static final String[] MQTT = { "wss://broker.hivemq.com:8884/mqtt", "wss://broker.emqx.io:8084/mqtt" };
    private static final String[] NOSTR = { "wss://nos.lol", "wss://relay.damus.io" };

    private static volatile RingService instance;

    private static final class Ch {
        String id;
        String name;
        String me;
        byte[] ring;
        byte[] key;
        boolean gone;
    }

    private static final class Ringing {
        Ch ch;
        String call;
        String from;
        boolean voice;
        int id;
        boolean notified;
        Runnable timeout;
    }

    private HandlerThread thread;
    private Handler handler;
    private OkHttpClient http;
    private final List<RingLink> links = new ArrayList<>();
    private List<Ch> channels = new ArrayList<>();
    private String myName = "Someone";
    private Map<String, Ch> byTopic = new HashMap<>();
    private final Map<String, Ringing> ringing = new HashMap<>();
    private final Set<String> seen = recent(600);
    private final Set<String> handled = recent(200);
    private ConnectivityManager.NetworkCallback networkCallback;
    private Network network;
    private Ringtone tone;

    /* ---------- Called from the app (plugin, activity, receivers) ---------- */

    static void start(Context context) {
        try {
            ContextCompat.startForegroundService(context, new Intent(context, RingService.class).setAction(ACTION_START));
        } catch (Exception ignored) {
            // Android doesn't allow starting it from the background right now; the next app open does.
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, RingService.class));
    }

    static boolean hasChannels(Context context) {
        try {
            JSONArray list = new JSONArray(prefs(context).getString("channels", "[]"));
            for (int i = 0; i < list.length(); i++) if (!list.getJSONObject(i).optBoolean("gone")) return true;
        } catch (Exception ignored) {
            // Nothing readable saved.
        }
        return false;
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Answered or declined inside the app: stop the ringing. */
    static void stopRinging(String call, boolean keepOverLock) {
        RingService s = instance;
        if (s != null && call != null) s.handler.post(() -> s.stopRingingNow(call));
        if (!keepOverLock) MainActivity.setShowOverLock(false);
    }

    /** "Decline" in the notification. */
    static void decline(String call) {
        RingService s = instance;
        if (s != null && call != null) s.handler.post(() -> s.declineNow(call));
        MainActivity.setShowOverLock(false);
    }

    /** The phone woke for its regular check. */
    static boolean keepAlive() {
        RingService s = instance;
        if (s == null) return false;
        s.handler.post(s::keepAliveNow);
        return true;
    }

    /** The app went to the background while ringing inside it: ring as a notification instead. */
    static void appHidden() {
        RingService s = instance;
        if (s != null) s.handler.post(s::moveRingsToNotifications);
    }

    /* ---------- Service ---------- */

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        thread = new HandlerThread("hush-ring");
        thread.start();
        handler = new Handler(thread.getLooper());
        // OkHttp pings each connection; one that stops answering is dropped and reconnected.
        http = new OkHttpClient.Builder().pingInterval(60, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).build();
        for (String url : MQTT) links.add(new MqttLink(http, url, handler, this::heard));
        for (String url : NOSTR) links.add(new NostrLink(http, url, handler, this::heard));
        watchNetwork();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground();
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_KEEPALIVE.equals(action)) handler.post(this::keepAliveNow);
        else handler.post(this::reload);
        // Android may stop it to free memory: it comes back by itself.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        instance = null;
        if (networkCallback != null) {
            try {
                getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
                // Already gone.
            }
        }
        getSystemService(AlarmManager.class).cancel(keepAliveIntent());
        handler.post(() -> {
            for (Ringing r : ringing.values()) manager().cancel(r.id);
            ringing.clear();
            stopTone();
            for (RingLink link : links) link.close();
            thread.quitSafely();
        });
        super.onDestroy();
    }

    private void goForeground() {
        createChannels();
        Notification notification = new NotificationCompat.Builder(this, READY_CHANNEL)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle("Hush is ready for calls")
            .setContentText("Your saved channels can ring this phone.")
            .setContentIntent(openApp(0))
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(READY_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(READY_ID, notification);
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager m = manager();
        if (m.getNotificationChannel(READY_CHANNEL) == null) {
            NotificationChannel ready = new NotificationChannel(READY_CHANNEL, "Ready for calls", NotificationManager.IMPORTANCE_MIN);
            ready.setDescription("Shown while Hush waits for calls from your saved channels. You can hide it here.");
            ready.setShowBadge(false);
            m.createNotificationChannel(ready);
        }
        if (m.getNotificationChannel(RING_CHANNEL) == null) {
            NotificationChannel ring = new NotificationChannel(RING_CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            ring.setDescription("Rings when someone in a saved channel calls you");
            ring.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), ringAudio());
            ring.enableVibration(true);
            ring.setVibrationPattern(VIBRATION);
            ring.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            m.createNotificationChannel(ring);
        }
        if (m.getNotificationChannel(MISSED_CHANNEL) == null) {
            NotificationChannel missed = new NotificationChannel(MISSED_CHANNEL, "Missed calls", NotificationManager.IMPORTANCE_DEFAULT);
            m.createNotificationChannel(missed);
        }
    }

    /* ---------- Listening ---------- */

    private void reload() {
        SharedPreferences p = prefs(this);
        myName = p.getString("name", "Someone");
        List<Ch> list = new ArrayList<>();
        try {
            JSONArray saved = new JSONArray(p.getString("channels", "[]"));
            for (int i = 0; i < saved.length(); i++) {
                JSONObject o = saved.getJSONObject(i);
                byte[] ring = RingCrypto.fromBase64Url(o.optString("ring"));
                if (ring == null || ring.length != 32) continue;
                Ch ch = new Ch();
                ch.id = o.optString("id");
                ch.name = clip(o.optString("name", "Hush"));
                ch.me = o.optString("me");
                ch.ring = ring;
                ch.key = RingCrypto.key(ring);
                ch.gone = o.optBoolean("gone");
                list.add(ch);
            }
        } catch (Exception ignored) {
            // Broken list: treat as empty.
        }
        channels = list;
        boolean any = false;
        for (Ch ch : list) any |= !ch.gone;
        if (!any) {
            stopSelf();
            return;
        }
        updateTopics();
        for (RingLink link : links) link.connect();
        scheduleKeepAlive();
    }

    private void updateTopics() {
        long now = System.currentTimeMillis();
        long day = RingCrypto.day(now);
        Map<String, Ch> all = new HashMap<>();
        Set<String> listen = new HashSet<>();
        for (Ch ch : channels) {
            for (long d = day - 1; d <= day + 1; d++) all.put(RingCrypto.topic(ch.ring, d), ch);
            if (!ch.gone) for (long d : RingCrypto.listenDays(now)) listen.add(RingCrypto.topic(ch.ring, d));
        }
        byTopic = all;
        for (RingLink link : links) link.setTopics(listen);
    }

    private void keepAliveNow() {
        if (channels.isEmpty()) {
            reload();
            return;
        }
        // Midnight may have passed: today's topics.
        updateTopics();
        for (RingLink link : links) {
            if (link.isUp()) link.ping();
            else link.reconnectNow();
        }
        scheduleKeepAlive();
    }

    private void scheduleKeepAlive() {
        // Allowed even while the phone is idle ("Doze"), about every 10 minutes at most.
        getSystemService(AlarmManager.class).setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + KEEPALIVE_MS, keepAliveIntent());
    }

    private PendingIntent keepAliveIntent() {
        return PendingIntent.getBroadcast(this, 3, new Intent(this, RingReceiver.class).setAction(ACTION_KEEPALIVE),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** New Wi-Fi or mobile data: the old connections are dead, so open new ones at once. */
    private void watchNetwork() {
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network available) {
                handler.post(() -> {
                    boolean changed = network != null && !network.equals(available);
                    network = available;
                    if (changed) for (RingLink link : links) link.reconnectNow();
                });
            }
        };
        try {
            getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(networkCallback);
        } catch (Exception ignored) {
            networkCallback = null;
        }
    }

    /** A message on a ring topic (on this service's thread). */
    private void heard(String topic, String text) {
        // The same ring arrives once per relay.
        if (text == null || text.length() < 16 || !seen.add(text.substring(0, 16))) return;
        Ch ch = byTopic.get(topic);
        if (ch == null) return;
        // When the app is open, the page decides for itself too (call screen, "busy", "in a call now").
        boolean pageAlive = HushNativePlugin.emitRingData(topic, text);
        String json = RingCrypto.open(ch.key, RingCrypto.fromBase64Url(text));
        if (json == null) return;
        try {
            JSONObject m = new JSONObject(json);
            String t = m.optString("t");
            String call = m.has("call") ? m.optString("call") : null;
            String from = clip(m.optString("from", ch.name));
            if (ch.me.equals(m.optString("by"))) return;
            if (!"gone".equals(t) && Math.abs(System.currentTimeMillis() - m.optLong("ts")) > MAX_AGE_MS) return;
            if ("ring".equals(t) && call != null) ring(ch, call, from, m.optBoolean("v"));
            else if ("cancel".equals(t) && call != null && ringing.containsKey(call)) missed(call, pageAlive);
            else if ("gone".equals(t)) gone(ch, from, pageAlive);
        } catch (Exception ignored) {
            // A broken ring is ignored.
        }
    }

    /* ---------- Ringing ---------- */

    private void ring(Ch ch, String call, String from, boolean voice) {
        if (ch.gone || handled.contains(call)) return;
        Ringing r = ringing.get(call);
        if (r != null) {
            // The caller repeats the ring every few seconds: keep ringing.
            handler.removeCallbacks(r.timeout);
            handler.postDelayed(r.timeout, RING_GAP_MS);
            return;
        }
        // Already on a call: the page answers "busy" itself.
        if (CallService.running) return;
        Ringing next = new Ringing();
        next.ch = ch;
        next.call = call;
        next.from = from;
        next.voice = voice;
        next.id = 1000 + (call.hashCode() & 0xffff);
        next.timeout = () -> missed(call, HushNativePlugin.isAlive());
        ringing.put(call, next);
        handler.postDelayed(next.timeout, RING_GAP_MS);
        // Hush is on screen: the page shows the call and the phone rings. Otherwise: the call notification.
        if (MainActivity.visible) ringInApp();
        else notifyIncoming(next);
    }

    private void notifyIncoming(Ringing r) {
        boolean sameName = r.ch.name.equalsIgnoreCase(r.from);
        Person caller = new Person.Builder().setName(r.from).setImportant(true).build();
        PendingIntent full = PendingIntent.getActivity(this, r.id, callIntent(ACTION_INCOMING, r), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent answer = PendingIntent.getActivity(this, r.id + 1, callIntent(ACTION_ANSWER, r), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent decline = PendingIntent.getBroadcast(this, r.id + 2,
            new Intent(this, RingReceiver.class).setAction(ACTION_DECLINE).putExtra(EXTRA_CALL, r.call),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, RING_CHANNEL)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(r.from)
            .setContentText((r.voice ? "Hush voice call" : "Hush video call") + (sameName ? "" : " · " + r.ch.name))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(full)
            // On a locked or sleeping phone this opens the full call screen, like a phone call.
            .setFullScreenIntent(full, true)
            .setTimeoutAfter(60000)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
            .setVibrate(VIBRATION)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer));
        Notification notification = builder.build();
        // Keep ringing until answered, declined or given up (not just one chime).
        notification.flags |= Notification.FLAG_INSISTENT;
        manager().notify(r.id, notification);
        r.notified = true;
    }

    private Intent callIntent(String action, Ringing r) {
        return new Intent(this, MainActivity.class)
            .setAction(action)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_CALL, r.call)
            .putExtra(EXTRA_CHANNEL, r.ch.id)
            .putExtra(EXTRA_FROM, r.from)
            .putExtra(EXTRA_VOICE, r.voice);
    }

    private void moveRingsToNotifications() {
        boolean any = false;
        for (Ringing r : ringing.values()) {
            if (!r.notified) {
                notifyIncoming(r);
                any = true;
            }
        }
        if (any) stopTone();
    }

    private void stopRingingNow(String call) {
        handled.add(call);
        Ringing r = ringing.remove(call);
        if (r != null) clear(r);
    }

    private void declineNow(String call) {
        handled.add(call);
        Ringing r = ringing.remove(call);
        if (r == null) return;
        clear(r);
        // Twice, a moment apart: a lost "no" would leave them ringing until time runs out.
        send(r.ch, "decline", call);
        handler.postDelayed(() -> send(r.ch, "decline", call), 2000);
    }

    private void missed(String call, boolean pageAlive) {
        Ringing r = ringing.remove(call);
        if (r == null) return;
        handled.add(call);
        clear(r);
        MainActivity.setShowOverLock(false);
        boolean sameName = r.ch.name.equalsIgnoreCase(r.from);
        manager().notify(r.id, new NotificationCompat.Builder(this, MISSED_CHANNEL)
            .setSmallIcon(android.R.drawable.sym_call_missed)
            .setContentTitle("Missed call")
            .setContentText(r.from + (sameName ? "" : " · " + r.ch.name))
            .setContentIntent(openApp(r.id))
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setAutoCancel(true)
            .build());
        // The page marks it on the channel itself when it's open; otherwise it reads it later.
        if (!pageAlive) addPending("missed", new String[] { "channel", r.ch.id }, "at", System.currentTimeMillis());
    }

    private void gone(Ch ch, String from, boolean pageAlive) {
        ch.gone = true;
        for (Ringing r : new ArrayList<>(ringing.values())) {
            if (r.ch == ch) {
                ringing.remove(r.call);
                clear(r);
            }
        }
        try {
            SharedPreferences p = prefs(this);
            JSONArray saved = new JSONArray(p.getString("channels", "[]"));
            for (int i = 0; i < saved.length(); i++) {
                JSONObject o = saved.getJSONObject(i);
                if (ch.id.equals(o.optString("id"))) o.put("gone", true);
            }
            p.edit().putString("channels", saved.toString()).apply();
        } catch (Exception ignored) {
            // Kept in memory at least.
        }
        if (!pageAlive) addPending("gone", new String[] { "channel", ch.id, "from", from }, null, 0);
        updateTopics();
        boolean any = false;
        for (Ch c : channels) any |= !c.gone;
        if (!any) stopSelf();
    }

    private void clear(Ringing r) {
        handler.removeCallbacks(r.timeout);
        manager().cancel(r.id);
        if (ringing.isEmpty()) stopTone();
    }

    /** A sealed answer ("decline") on today's topic, through every MQTT relay that is connected. */
    private void send(Ch ch, String type, String call) {
        try {
            long now = System.currentTimeMillis();
            JSONObject m = new JSONObject();
            m.put("t", type);
            m.put("call", call);
            m.put("from", myName);
            m.put("by", ch.me);
            m.put("ts", now);
            String text = RingCrypto.toBase64Url(RingCrypto.seal(ch.key, m.toString()));
            seen.add(text.substring(0, 16));
            String topic = RingCrypto.topic(ch.ring, RingCrypto.day(now));
            for (RingLink link : links) link.publish(topic, text);
        } catch (Exception ignored) {
            // Not sent: they hear "no answer" when their ringing time is up.
        }
    }

    /** Hush is on screen: ring with the phone's own ringtone (it respects silent and vibrate mode). */
    private void ringInApp() {
        if (tone != null) return;
        AudioManager audio = getSystemService(AudioManager.class);
        int mode = audio.getRingerMode();
        if (mode == AudioManager.RINGER_MODE_SILENT) return;
        Vibrator vibrator = getSystemService(Vibrator.class);
        if (vibrator != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vibrator.vibrate(VibrationEffect.createWaveform(VIBRATION, 1));
            else vibrator.vibrate(VIBRATION, 1);
        }
        if (mode != AudioManager.RINGER_MODE_NORMAL) return;
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        tone = RingtoneManager.getRingtone(this, uri);
        if (tone == null) return;
        tone.setAudioAttributes(ringAudio());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) tone.setLooping(true);
        tone.play();
    }

    private void stopTone() {
        if (tone != null) tone.stop();
        tone = null;
        Vibrator vibrator = getSystemService(Vibrator.class);
        if (vibrator != null) vibrator.cancel();
    }

    /* ---------- Small helpers ---------- */

    /** Remembered for the page, which reads (and clears) it the next time Hush opens. */
    private void addPending(String list, String[] pairs, String numberKey, long number) {
        try {
            SharedPreferences p = prefs(this);
            JSONObject pending = new JSONObject(p.getString("pending", "{}"));
            JSONArray items = pending.optJSONArray(list);
            if (items == null) items = new JSONArray();
            JSONObject item = new JSONObject();
            for (int i = 0; i + 1 < pairs.length; i += 2) item.put(pairs[i], pairs[i + 1]);
            if (numberKey != null) item.put(numberKey, number);
            items.put(item);
            while (items.length() > 20) items.remove(0);
            pending.put(list, items);
            p.edit().putString("pending", pending.toString()).apply();
        } catch (Exception ignored) {
            // Only a hint for the page.
        }
    }

    private PendingIntent openApp(int code) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, code, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private NotificationManager manager() {
        return getSystemService(NotificationManager.class);
    }

    private static AudioAttributes ringAudio() {
        return new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
    }

    private static String clip(String name) {
        String n = name == null ? "" : name.trim();
        return n.isEmpty() ? "Someone" : n.length() > 30 ? n.substring(0, 30) : n;
    }

    private static Set<String> recent(int max) {
        return Collections.newSetFromMap(new LinkedHashMap<String, Boolean>() {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
                return size() > max;
            }
        });
    }
}

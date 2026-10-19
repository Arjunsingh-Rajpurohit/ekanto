package app.hush.call;

import android.os.Handler;
import java.security.SecureRandom;
import okhttp3.OkHttpClient;
import okhttp3.Response;
import okhttp3.WebSocket;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Listens on a Nostr relay for ring events (the same ephemeral kind as calls: relays pass them
 * on and never store them). Only listens: answers go out over MQTT.
 */
final class NostrLink extends RingLink {

    private static final int KIND = 21733;
    private final String subId;

    NostrLink(OkHttpClient http, String url, Handler handler, Sink sink) {
        super(http, url, handler, sink);
        byte[] b = new byte[6];
        new SecureRandom().nextBytes(b);
        subId = RingCrypto.toBase64Url(b);
    }

    @Override
    public void onOpen(WebSocket ws, Response response) {
        handler.post(() -> {
            if (ws == socket) opened();
        });
    }

    @Override
    public void onMessage(WebSocket ws, String text) {
        handler.post(() -> {
            if (ws != socket) return;
            try {
                JSONArray m = new JSONArray(text);
                if (!"EVENT".equals(m.optString(0)) || !subId.equals(m.optString(1))) return;
                JSONObject event = m.getJSONObject(2);
                if (event.optInt("kind") != KIND) return;
                JSONArray tags = event.optJSONArray("tags");
                if (tags == null) return;
                for (int i = 0; i < tags.length(); i++) {
                    JSONArray tag = tags.optJSONArray(i);
                    if (tag != null && "t".equals(tag.optString(0))) {
                        sink.onRing(tag.optString(1), event.optString("content"));
                        return;
                    }
                }
            } catch (Exception ignored) {
                // Not for us.
            }
        });
    }

    @Override
    protected void syncTopics() {
        if (socket == null) return;
        try {
            JSONArray message = new JSONArray();
            if (topics.isEmpty()) {
                message.put("CLOSE").put(subId);
            } else {
                // The same subscription id again replaces the old filter.
                JSONObject filter = new JSONObject();
                filter.put("kinds", new JSONArray().put(KIND));
                filter.put("#t", new JSONArray(topics));
                filter.put("since", System.currentTimeMillis() / 1000 - 30);
                message.put("REQ").put(subId).put(filter);
            }
            socket.send(message.toString());
        } catch (Exception ignored) {
            // Never happens with these values.
        }
    }

    @Override
    void ping() {
        // OkHttp pings the WebSocket by itself; a dead one fails and is reconnected.
    }

    @Override
    boolean publish(String topic, String text) {
        return false;
    }
}

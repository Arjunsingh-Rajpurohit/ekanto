package app.hush.call;

import android.os.Handler;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * One connection to one ring relay, kept open while Hush is closed so a saved channel can ring.
 * It only ever carries sealed rings. Everything runs on the ring service's own thread.
 */
abstract class RingLink extends WebSocketListener {

    interface Sink {
        void onRing(String topic, String text);
    }

    protected final OkHttpClient http;
    protected final String url;
    protected final Handler handler;
    protected final Sink sink;
    protected WebSocket socket;
    protected boolean up;
    protected Set<String> topics = Collections.emptySet();
    private boolean closed;
    private long retry = 2000;
    private final Runnable reconnect = this::connect;

    RingLink(OkHttpClient http, String url, Handler handler, Sink sink) {
        this.http = http;
        this.url = url;
        this.handler = handler;
        this.sink = sink;
    }

    protected Request request() {
        return new Request.Builder().url(url).build();
    }

    void connect() {
        handler.removeCallbacks(reconnect);
        if (closed || socket != null) return;
        socket = http.newWebSocket(request(), this);
    }

    /** The network changed, or the phone just woke: start over at once rather than wait. */
    void reconnectNow() {
        if (closed) return;
        if (socket != null) socket.cancel();
        socket = null;
        up = false;
        retry = 2000;
        connect();
    }

    void close() {
        closed = true;
        handler.removeCallbacks(reconnect);
        if (socket != null) socket.close(1000, null);
        socket = null;
        up = false;
    }

    boolean isUp() {
        return up;
    }

    void setTopics(Set<String> next) {
        topics = new HashSet<>(next);
        if (up) syncTopics();
    }

    protected void opened() {
        up = true;
        retry = 2000;
        syncTopics();
    }

    protected abstract void syncTopics();

    /** Keeps an idle connection from being dropped by the mobile network. */
    abstract void ping();

    /** False when this kind of relay can't send from here (or isn't connected). */
    abstract boolean publish(String topic, String text);

    @Override
    public void onClosed(WebSocket ws, int code, String reason) {
        handler.post(() -> lost(ws));
    }

    @Override
    public void onFailure(WebSocket ws, Throwable t, Response response) {
        handler.post(() -> lost(ws));
    }

    private void lost(WebSocket ws) {
        if (ws != socket) return;
        socket = null;
        up = false;
        if (closed) return;
        handler.postDelayed(reconnect, retry);
        retry = Math.min(retry * 2, 60000);
    }
}

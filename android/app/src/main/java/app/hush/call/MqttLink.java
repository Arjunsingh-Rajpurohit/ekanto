package app.hush.call;

import android.os.Handler;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okio.ByteString;

/**
 * Just enough MQTT 3.1.1 (over a WebSocket) to listen on ring topics and send a "declined":
 * connect, subscribe, publish at QoS 0, ping. Nothing is retained or stored by the broker.
 */
final class MqttLink extends RingLink {

    /** Long, because Android may only let the phone wake every ~10 minutes to send a ping. */
    private static final int KEEPALIVE_S = 900;

    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    private Set<String> subscribed = new HashSet<>();
    private int packetId = 1;

    MqttLink(OkHttpClient http, String url, Handler handler, Sink sink) {
        super(http, url, handler, sink);
    }

    @Override
    protected Request request() {
        return new Request.Builder().url(url).header("Sec-WebSocket-Protocol", "mqtt").build();
    }

    @Override
    public void onOpen(WebSocket ws, Response response) {
        handler.post(() -> {
            if (ws != socket) return;
            buffer.reset();
            subscribed = new HashSet<>();
            // A fresh random name each time: nothing ties two connections together.
            byte[] id = ("r" + RingCrypto.toBase64Url(randomBytes(9))).getBytes(StandardCharsets.UTF_8);
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            writeString(body, "MQTT".getBytes(StandardCharsets.UTF_8));
            body.write(4); // protocol level 3.1.1
            body.write(0x02); // clean session
            body.write(KEEPALIVE_S >> 8);
            body.write(KEEPALIVE_S & 0xff);
            writeString(body, id);
            send(0x10, body.toByteArray());
        });
    }

    @Override
    public void onMessage(WebSocket ws, ByteString bytes) {
        handler.post(() -> {
            if (ws != socket) return;
            byte[] data = bytes.toByteArray();
            buffer.write(data, 0, data.length);
            readPackets();
        });
    }

    private void readPackets() {
        byte[] all = buffer.toByteArray();
        int pos = 0;
        while (all.length - pos >= 2) {
            int length = 0;
            int multiplier = 1;
            int i = pos + 1;
            boolean complete = false;
            while (i < all.length && i < pos + 5) {
                int b = all[i++] & 0xff;
                length += (b & 0x7f) * multiplier;
                multiplier *= 128;
                if ((b & 0x80) == 0) {
                    complete = true;
                    break;
                }
            }
            if (!complete || all.length < i + length) break;
            handle(all[pos] & 0xff, all, i, length);
            pos = i + length;
        }
        buffer.reset();
        buffer.write(all, pos, all.length - pos);
    }

    private void handle(int header, byte[] data, int start, int length) {
        int type = header >> 4;
        if (type == 2) {
            // CONNACK: return code 0 = accepted.
            if (length >= 2 && data[start + 1] == 0) opened();
            else if (socket != null) socket.cancel();
        } else if (type == 3 && length >= 2) {
            int qos = (header >> 1) & 3;
            int topicLength = (data[start] & 0xff) << 8 | (data[start + 1] & 0xff);
            int at = start + 2 + topicLength + (qos > 0 ? 2 : 0);
            if (at > start + length) return;
            String topic = new String(data, start + 2, topicLength, StandardCharsets.UTF_8);
            String text = new String(data, at, start + length - at, StandardCharsets.UTF_8);
            if (topic.startsWith("h1/")) sink.onRing(topic.substring(3), text);
        }
    }

    @Override
    protected void syncTopics() {
        Set<String> gone = new HashSet<>(subscribed);
        gone.removeAll(topics);
        Set<String> added = new HashSet<>(topics);
        added.removeAll(subscribed);
        if (!gone.isEmpty()) {
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            writeId(body);
            for (String t : gone) writeString(body, ("h1/" + t).getBytes(StandardCharsets.UTF_8));
            send(0xA2, body.toByteArray());
        }
        if (!added.isEmpty()) {
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            writeId(body);
            for (String t : added) {
                writeString(body, ("h1/" + t).getBytes(StandardCharsets.UTF_8));
                body.write(0); // QoS 0
            }
            send(0x82, body.toByteArray());
        }
        subscribed = new HashSet<>(topics);
    }

    @Override
    void ping() {
        if (up) send(0xC0, new byte[0]);
    }

    @Override
    boolean publish(String topic, String text) {
        if (!up) return false;
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        writeString(body, ("h1/" + topic).getBytes(StandardCharsets.UTF_8));
        byte[] payload = text.getBytes(StandardCharsets.UTF_8);
        body.write(payload, 0, payload.length);
        // QoS 0, not retained: the broker forwards it and keeps nothing.
        send(0x30, body.toByteArray());
        return true;
    }

    private void send(int header, byte[] body) {
        if (socket == null) return;
        ByteArrayOutputStream packet = new ByteArrayOutputStream();
        packet.write(header);
        int length = body.length;
        do {
            int b = length % 128;
            length /= 128;
            packet.write(length > 0 ? b | 0x80 : b);
        } while (length > 0);
        packet.write(body, 0, body.length);
        socket.send(ByteString.of(packet.toByteArray()));
    }

    private void writeId(ByteArrayOutputStream out) {
        packetId = packetId % 65535 + 1;
        out.write(packetId >> 8);
        out.write(packetId & 0xff);
    }

    private static void writeString(ByteArrayOutputStream out, byte[] bytes) {
        out.write(bytes.length >> 8);
        out.write(bytes.length & 0xff);
        out.write(bytes, 0, bytes.length);
    }

    private static byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        new java.security.SecureRandom().nextBytes(b);
        return b;
    }
}

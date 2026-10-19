package app.hush.call;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The ring maths of src/channels.ts, in Java, so a closed app can still hear and open rings.
 * Both sides must agree byte for byte (RingCryptoTest and channels.test.ts share one example).
 */
final class RingCrypto {

    private static final long DAY_MS = 24L * 3600 * 1000;
    private static final long HOUR_MS = 3600L * 1000;
    private static final byte[] AAD = "hush/v1/ring".getBytes(StandardCharsets.UTF_8);
    private static final SecureRandom RANDOM = new SecureRandom();

    private RingCrypto() {}

    static byte[] hmac(byte[] key, String text) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(text.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The channel's meeting name for one (UTC) day. */
    static String topic(byte[] ring, long day) {
        byte[] mac = hmac(ring, "topic|" + day);
        StringBuilder hex = new StringBuilder(32);
        for (int i = 0; i < 16; i++) hex.append(String.format("%02x", mac[i] & 0xff));
        return hex.toString();
    }

    static byte[] key(byte[] ring) {
        return hmac(ring, "key");
    }

    static long day(long now) {
        return Math.floorDiv(now, DAY_MS);
    }

    /** Today, plus yesterday or tomorrow near midnight (as listenDays in channels.ts). */
    static List<Long> listenDays(long now) {
        long day = day(now);
        long into = now - day * DAY_MS;
        List<Long> days = new ArrayList<>();
        days.add(day);
        if (into < 2 * HOUR_MS) days.add(day - 1);
        if (into > 22 * HOUR_MS) days.add(day + 1);
        return days;
    }

    /** The JSON inside a sealed ring, or null for anything not sealed with this key. */
    static String open(byte[] key, byte[] data) {
        if (data == null || data.length < 12 + 16) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, data, 0, 12));
            cipher.updateAAD(AAD);
            return new String(cipher.doFinal(data, 12, data.length - 12), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException e) {
            return null;
        }
    }

    static byte[] seal(byte[] key, String json) {
        try {
            byte[] iv = new byte[12];
            RANDOM.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            cipher.updateAAD(AAD);
            byte[] sealed = cipher.doFinal(json.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[12 + sealed.length];
            System.arraycopy(iv, 0, out, 0, 12);
            System.arraycopy(sealed, 0, out, 12, sealed.length);
            return out;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /* Base64url without padding — written out, because java.util.Base64 needs Android 8. */

    private static final char[] ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".toCharArray();

    static String toBase64Url(byte[] bytes) {
        StringBuilder out = new StringBuilder((bytes.length * 4 + 2) / 3);
        int i = 0;
        for (; i + 2 < bytes.length; i += 3) {
            int n = (bytes[i] & 0xff) << 16 | (bytes[i + 1] & 0xff) << 8 | (bytes[i + 2] & 0xff);
            out.append(ALPHABET[n >> 18 & 63]).append(ALPHABET[n >> 12 & 63]).append(ALPHABET[n >> 6 & 63]).append(ALPHABET[n & 63]);
        }
        int rest = bytes.length - i;
        if (rest == 1) {
            int n = (bytes[i] & 0xff) << 16;
            out.append(ALPHABET[n >> 18 & 63]).append(ALPHABET[n >> 12 & 63]);
        } else if (rest == 2) {
            int n = (bytes[i] & 0xff) << 16 | (bytes[i + 1] & 0xff) << 8;
            out.append(ALPHABET[n >> 18 & 63]).append(ALPHABET[n >> 12 & 63]).append(ALPHABET[n >> 6 & 63]);
        }
        return out.toString();
    }

    /** Null for anything that isn't base64url. */
    static byte[] fromBase64Url(String text) {
        if (text == null) return null;
        int len = text.length();
        if (len % 4 == 1) return null;
        byte[] out = new byte[len * 3 / 4];
        int bits = 0;
        int value = 0;
        int o = 0;
        for (int i = 0; i < len; i++) {
            int c = text.charAt(i);
            int v;
            if (c >= 'A' && c <= 'Z') v = c - 'A';
            else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
            else if (c >= '0' && c <= '9') v = c - '0' + 52;
            else if (c == '-') v = 62;
            else if (c == '_') v = 63;
            else return null;
            value = value << 6 | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = (byte) (value >> bits & 0xff);
            }
        }
        return o == out.length ? out : java.util.Arrays.copyOf(out, o);
    }
}

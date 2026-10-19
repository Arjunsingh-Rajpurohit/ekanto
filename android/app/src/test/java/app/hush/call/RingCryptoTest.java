package app.hush.call;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.junit.Test;

/** The app's background listener must work out exactly what the page does (src/channels.test.ts). */
public class RingCryptoTest {

    /** ringSecret() of the channel secret 00 01 02 … 1f, computed by the page. */
    private static final String RING = "e-v7F32U84Gn4hggqer2mXXbWF4VQcBfvuraW9_tGVw";
    /** A ring sealed by the page with that channel's ring key. */
    private static final String SEALED_BY_PAGE =
        "ReXxuD99lJYTADHuSqUjRdyNcHt_v6jxG8nfE-BUBQ_I-b52I19pde40hhI9HnHxRAh40jnNyhwxrdGODechp_ZoatKDX2ys0smszYIWeN-ruLO5ndYrtWNFwMUUM7baSkftzD11egINrwiF";

    @Test
    public void topicMatchesThePage() {
        assertEquals("48628575be48e4665945e1f04734602a", RingCrypto.topic(RingCrypto.fromBase64Url(RING), 20745));
    }

    @Test
    public void opensARingSealedByThePage() {
        byte[] key = RingCrypto.key(RingCrypto.fromBase64Url(RING));
        String json = RingCrypto.open(key, RingCrypto.fromBase64Url(SEALED_BY_PAGE));
        assertEquals("{\"t\":\"ring\",\"call\":\"CALL\",\"from\":\"Arjun\",\"by\":\"me1\",\"ts\":1760000000000,\"v\":true}", json);
    }

    @Test
    public void sealsWhatItOpens_andNothingElseOpens() {
        byte[] key = RingCrypto.key(RingCrypto.fromBase64Url(RING));
        byte[] sealed = RingCrypto.seal(key, "{\"t\":\"decline\"}");
        assertEquals("{\"t\":\"decline\"}", RingCrypto.open(key, sealed));
        byte[] bent = sealed.clone();
        bent[20] ^= 1;
        assertNull(RingCrypto.open(key, bent));
        assertNull(RingCrypto.open(RingCrypto.key(new byte[32]), sealed));
    }

    @Test
    public void reasonIsOneShortLine() {
        assertEquals("Dinner plans?", RingCrypto.cleanReason("  Dinner\n plans?  "));
        assertNull(RingCrypto.cleanReason("   "));
        assertNull(RingCrypto.cleanReason(null));
        String longOne = new String(new char[200]).replace('\0', 'x');
        assertEquals(60, RingCrypto.cleanReason(longOne).length());
        assertEquals("खाना कब बनेगा? 🍲", RingCrypto.cleanReason("खाना कब बनेगा? 🍲"));
    }

    @Test
    public void base64UrlRoundTrips() {
        for (int n = 0; n < 40; n++) {
            byte[] bytes = new byte[n];
            for (int i = 0; i < n; i++) bytes[i] = (byte) (i * 37 + n);
            assertArrayEquals(bytes, RingCrypto.fromBase64Url(RingCrypto.toBase64Url(bytes)));
        }
        assertNull(RingCrypto.fromBase64Url("ab$d"));
    }

    @Test
    public void listensOnNeighbourDaysOnlyNearMidnight() {
        long day = 20000L * 24 * 3600 * 1000;
        assertEquals(Arrays.asList(20000L), RingCrypto.listenDays(day + 12L * 3600 * 1000));
        assertEquals(Arrays.asList(20000L, 19999L), RingCrypto.listenDays(day + 30L * 60 * 1000));
        assertTrue(RingCrypto.listenDays(day + 23L * 3600 * 1000 + 1800 * 1000).contains(20001L));
    }
}

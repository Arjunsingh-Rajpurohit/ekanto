package app.hush.call;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;

/** "Decline" on the ringing notification, and the regular wake-up that keeps ringing working. */
public class RingReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (RingService.ACTION_DECLINE.equals(action)) {
            RingService.decline(intent.getStringExtra(RingService.EXTRA_CALL));
        } else if (RingService.ACTION_KEEPALIVE.equals(action)) {
            // Stay awake a few seconds so the connections can be checked before the phone sleeps again.
            PowerManager power = context.getSystemService(PowerManager.class);
            power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hush:ring-check").acquire(15000);
            if (!RingService.keepAlive() && RingService.hasChannels(context)) RingService.start(context);
        }
    }
}

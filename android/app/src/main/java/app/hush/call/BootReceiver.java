package app.hush.call;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After the phone restarts (or Ekanto is updated), saved channels can ring again without opening Ekanto. */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean restart = Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (restart && RingService.hasChannels(context)) RingService.start(context);
    }
}

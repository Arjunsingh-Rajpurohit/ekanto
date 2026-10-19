package app.hush.call;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Runs while a call is on. Android lets an app keep using the microphone and camera — and capture
 * the screen — only from a visible "foreground service" with a notification, so this is that:
 * "Ekanto call in progress". Screen frames go straight to the page (and into the encrypted call);
 * nothing is recorded or stored.
 */
public class CallService extends Service {

    static final String ACTION_CALL = "app.hush.call.CALL";
    static final String ACTION_SCREEN = "app.hush.call.SCREEN";
    static final String ACTION_STOP_SCREEN = "app.hush.call.STOP_SCREEN";
    static final String ACTION_HANG_UP = "app.hush.call.HANG_UP";
    static final String EXTRA_CODE = "code";
    static final String EXTRA_DATA = "data";

    private static final String CHANNEL = "call";
    private static final int NOTIFICATION_ID = 7;
    /** Long side of the shared picture, and frames per second: sharp enough for text, light on the phone. */
    private static final int MAX_SIDE = 1280;
    private static final long FRAME_GAP_MS = 125;

    /** A call is on: a saved channel's ring gets "busy" instead of the ringing screen. */
    static volatile boolean running;

    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private Handler handler;
    private long lastFrame;

    static Intent intent(Context context, String action) {
        return new Intent(context, CallService.class).setAction(action);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_CALL : intent.getAction();
        running = true;
        if (ACTION_SCREEN.equals(action)) {
            // The screen-capture type must be in place before the capture starts.
            goForeground(true);
            startCapture(intent.getIntExtra(EXTRA_CODE, 0), intent.getParcelableExtra(EXTRA_DATA));
        } else if (ACTION_HANG_UP.equals(action)) {
            // The page hangs up properly (says goodbye, wipes the chat) and then stops this service.
            HushNativePlugin.emitHangUp();
            return START_NOT_STICKY;
        } else if (ACTION_STOP_SCREEN.equals(action)) {
            stopCapture();
            goForeground(false);
        } else {
            goForeground(false);
        }
        // If Android ever kills the app, the call is over: don't come back on its own.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        stopCapture();
        super.onDestroy();
    }

    private void goForeground(boolean screen) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Calls", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while a Ekanto call is on");
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent hangUp = PendingIntent.getService(this, 1, intent(this, ACTION_HANG_UP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ekanto)
            .setContentTitle(screen ? "Ekanto · sharing your screen" : "Ekanto call in progress")
            .setContentText("Tap to return to the call")
            .setContentIntent(tap)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Hang up", hangUp)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int types = 0;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Only what was actually granted: a voice call never asked for the camera.
                if (granted(Manifest.permission.RECORD_AUDIO)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if (granted(Manifest.permission.CAMERA)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            }
            if (screen) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            if (types == 0) types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST;
            startForeground(NOTIFICATION_ID, notification, types);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void startCapture(int code, Intent data) {
        stopCapture();
        if (data == null) return;
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = manager.getMediaProjection(code, data);
        if (projection == null) return;

        thread = new HandlerThread("hush-screen");
        thread.start();
        handler = new Handler(thread.getLooper());
        // Required before capturing on Android 14+; also tells us when sharing ends from outside.
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                releaseCapture();
                HushNativePlugin.emitScreenStopped();
            }
        }, handler);

        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager windows = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        windows.getDefaultDisplay().getRealMetrics(metrics);
        float scale = Math.min(1f, (float) MAX_SIDE / Math.max(metrics.widthPixels, metrics.heightPixels));
        int width = Math.max(2, Math.round(metrics.widthPixels * scale) & ~1);
        int height = Math.max(2, Math.round(metrics.heightPixels * scale) & ~1);

        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(this::onImage, handler);
        display = projection.createVirtualDisplay("hush-screen", width, height, metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
    }

    private void onImage(ImageReader source) {
        Image image = null;
        try {
            image = source.acquireLatestImage();
            if (image == null) return;
            long now = System.currentTimeMillis();
            if (now - lastFrame < FRAME_GAP_MS) return;
            lastFrame = now;

            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int pixelStride = plane.getPixelStride();
            int rowPadding = plane.getRowStride() - pixelStride * image.getWidth();
            Bitmap padded = Bitmap.createBitmap(image.getWidth() + rowPadding / pixelStride, image.getHeight(), Bitmap.Config.ARGB_8888);
            padded.copyPixelsFromBuffer(buffer);
            Bitmap frame = Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
            padded.recycle();

            ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
            frame.compress(Bitmap.CompressFormat.JPEG, 60, jpeg);
            HushNativePlugin.emitFrame(Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP), frame.getWidth(), frame.getHeight());
            frame.recycle();
        } catch (Exception ignored) {
            // A bad frame is skipped; the next one follows a moment later.
        } finally {
            if (image != null) image.close();
        }
    }

    private void stopCapture() {
        MediaProjection current = projection;
        releaseCapture();
        if (current != null) current.stop();
    }

    private void releaseCapture() {
        if (display != null) display.release();
        if (reader != null) reader.close();
        if (thread != null) thread.quitSafely();
        display = null;
        reader = null;
        thread = null;
        handler = null;
        projection = null;
    }
}

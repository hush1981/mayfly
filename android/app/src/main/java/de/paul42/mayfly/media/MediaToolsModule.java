package de.paul42.mayfly.media;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.ContentValues;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.BaseActivityEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.security.MessageDigest;

/**
 * Small media helpers that run fully on the device:
 * - stripAudio: copies only the video track of a clip into a new file (no re-encoding), so a
 *   muted moment really contains no sound — not just a "play muted" flag.
 * - saveToGallery: writes a photo / video the user made into the shared Pictures / Movies
 *   folder (Android 10+, no storage permission needed for own files).
 * - sha256File: SHA-256 (base64) of an encrypted media file, so a shared blob can be checked
 *   against the hash its sender put into each recipient's envelope.
 */
public class MediaToolsModule extends ReactContextBaseJavaModule {
    private static final int REQ_DUAL = 7311;
    private Promise pendingDual;

    public MediaToolsModule(ReactApplicationContext ctx) {
        super(ctx);
        ctx.addActivityEventListener(new BaseActivityEventListener() {
            @Override
            public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
                if (requestCode != REQ_DUAL || pendingDual == null) return;
                Promise p = pendingDual;
                pendingDual = null;
                if (resultCode != Activity.RESULT_OK || data == null) {
                    p.resolve(null);
                    return;
                }
                WritableMap m = Arguments.createMap();
                m.putString("type", data.getStringExtra("type"));
                m.putString("uri", data.getStringExtra("uri"));
                if (data.hasExtra("inset")) {
                    m.putString("inset", data.getStringExtra("inset"));
                    m.putString("layout", data.getStringExtra("layout"));
                    m.putArray("mainRect", arr(data.getDoubleArrayExtra("mainRect")));
                    m.putArray("insetRect", arr(data.getDoubleArrayExtra("insetRect")));
                    m.putDouble("aspect", data.getDoubleExtra("aspect", 0.5));
                }
                p.resolve(m);
            }
        });
    }

    private static WritableArray arr(double[] v) {
        WritableArray a = Arguments.createArray();
        if (v != null) for (double d : v) a.pushDouble(d);
        return a;
    }

    /** Opens the dual camera; resolves with the result map, or null if cancelled. */
    @ReactMethod
    public void dualCamera(ReadableMap labels, Promise promise) {
        Activity a = getCurrentActivity();
        if (a == null) {
            promise.reject("no_activity", "no activity");
            return;
        }
        if (pendingDual != null) pendingDual.resolve(null);
        pendingDual = promise;
        Bundle b = new Bundle();
        ReadableMapKeySetIterator it = labels.keySetIterator();
        while (it.hasNextKey()) {
            String k = it.nextKey();
            b.putString(k, labels.getString(k));
        }
        Intent i = new Intent(a, DualCameraActivity.class);
        i.putExtra(DualCameraActivity.EXTRA_LABELS, b);
        a.startActivityForResult(i, REQ_DUAL);
    }

    @NonNull
    @Override
    public String getName() {
        return "MfMediaTools";
    }

    private static String path(String uri) {
        if (uri.startsWith("file://")) return Uri.parse(uri).getPath();
        return uri;
    }

    /** SHA-256 of a local file (file:// or plain path), base64. */
    @ReactMethod
    public void sha256File(String uri, Promise promise) {
        new Thread(() -> {
            try (InputStream in = new FileInputStream(path(uri))) {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
                promise.resolve(Base64.encodeToString(md.digest(), Base64.NO_WRAP));
            } catch (Exception e) {
                promise.reject("hash", e.getMessage());
            }
        }).start();
    }

    @ReactMethod
    public void stripAudio(String uri, Promise promise) {
        new Thread(() -> {
            MediaExtractor ex = new MediaExtractor();
            MediaMuxer mux = null;
            File out = null;
            try {
                ex.setDataSource(path(uri));
                int videoTrack = -1;
                MediaFormat format = null;
                for (int i = 0; i < ex.getTrackCount(); i++) {
                    MediaFormat f = ex.getTrackFormat(i);
                    String mime = f.getString(MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith("video/")) {
                        videoTrack = i;
                        format = f;
                        break;
                    }
                }
                if (videoTrack < 0) throw new IllegalStateException("no video track");
                String mime = format.getString(MediaFormat.KEY_MIME);
                boolean webm = "video/x-vnd.on2.vp8".equals(mime) || "video/x-vnd.on2.vp9".equals(mime);
                out = new File(getReactApplicationContext().getCacheDir(), "muted_" + System.currentTimeMillis() + (webm ? ".webm" : ".mp4"));
                mux = new MediaMuxer(out.getAbsolutePath(),
                        webm ? MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM : MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
                // keep the rotation of portrait recordings
                try {
                    android.media.MediaMetadataRetriever r = new android.media.MediaMetadataRetriever();
                    r.setDataSource(path(uri));
                    String rot = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                    r.release();
                    if (rot != null) mux.setOrientationHint(Integer.parseInt(rot));
                } catch (Exception ignored) {
                }
                int dst = mux.addTrack(format);
                mux.start();
                ex.selectTrack(videoTrack);
                int max = format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE) ? format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) : 4 << 20;
                ByteBuffer buf = ByteBuffer.allocate(Math.max(max, 1 << 20));
                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                while (true) {
                    int size = ex.readSampleData(buf, 0);
                    if (size < 0) break;
                    info.offset = 0;
                    info.size = size;
                    info.presentationTimeUs = ex.getSampleTime();
                    info.flags = (ex.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0 ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
                    mux.writeSampleData(dst, buf, info);
                    ex.advance();
                }
                mux.stop();
                promise.resolve(Uri.fromFile(out).toString());
            } catch (Exception e) {
                if (out != null) //noinspection ResultOfMethodCallIgnored
                    out.delete();
                promise.reject("strip_failed", e.getMessage(), e);
            } finally {
                ex.release();
                if (mux != null) try { mux.release(); } catch (Exception ignored) { }
            }
        }).start();
    }

    @ReactMethod
    public void canSaveToGallery(Promise promise) {
        promise.resolve(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
    }

    @ReactMethod
    public void saveToGallery(String uri, String type, Promise promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            promise.reject("unsupported", "needs Android 10");
            return;
        }
        new Thread(() -> {
            boolean video = "video".equals(type);
            String p = path(uri);
            String ext = video ? (p.endsWith(".webm") ? ".webm" : ".mp4") : ".jpg";
            ContentResolver cr = getReactApplicationContext().getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, "Mayfly_" + System.currentTimeMillis() + ext);
            v.put(MediaStore.MediaColumns.MIME_TYPE, video ? (ext.equals(".webm") ? "video/webm" : "video/mp4") : "image/jpeg");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, (video ? "Movies" : "Pictures") + "/Mayfly");
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri collection = video
                    ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri item = null;
            try {
                item = cr.insert(collection, v);
                if (item == null) throw new IllegalStateException("insert failed");
                try (InputStream in = new FileInputStream(p); OutputStream o = cr.openOutputStream(item)) {
                    if (o == null) throw new IllegalStateException("cannot write");
                    byte[] b = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(b)) > 0) o.write(b, 0, n);
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(item, done, null, null);
                promise.resolve(true);
            } catch (Exception e) {
                if (item != null) try { cr.delete(item, null, null); } catch (Exception ignored) { }
                promise.reject("save_failed", e.getMessage(), e);
            }
        }).start();
    }
}

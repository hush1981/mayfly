package de.paul42.mayfly.qr;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.BaseActivityEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;

/**
 * Offline QR codes with ZXing (Apache-2.0, pure Java) — no Google Play Services,
 * no ML Kit, no network. scan() opens {@link QrScanActivity}; decodeFile() reads an image.
 */
public class QrDecoderModule extends ReactContextBaseJavaModule {
    private static final int MAX_DIM = 1400;
    private static final int REQ_SCAN = 4721;
    private Promise pendingScan;

    QrDecoderModule(ReactApplicationContext ctx) {
        super(ctx);
        ctx.addActivityEventListener(new BaseActivityEventListener() {
            @Override
            public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
                if (requestCode != REQ_SCAN || pendingScan == null) return;
                Promise p = pendingScan;
                pendingScan = null;
                p.resolve(resultCode == Activity.RESULT_OK && data != null ? data.getStringExtra("text") : null);
            }
        });
    }

    /** Opens the camera scanner; resolves with the QR text or null if cancelled. */
    @ReactMethod
    public void scan(Promise promise) {
        Activity a = getCurrentActivity();
        if (a == null) {
            promise.resolve(null);
            return;
        }
        if (pendingScan != null) pendingScan.resolve(null);
        pendingScan = promise;
        a.startActivityForResult(new Intent(a, QrScanActivity.class), REQ_SCAN);
    }

    @NonNull
    @Override
    public String getName() {
        return "MayflyQrDecoder";
    }

    @ReactMethod
    public void decodeFile(String uriOrPath, Promise promise) {
        try {
            String path = uriOrPath.startsWith("file:") ? Uri.parse(uriOrPath).getPath() : uriOrPath;
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, bounds);
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / sample > MAX_DIM) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeFile(path, opts);
            if (bmp == null) {
                promise.resolve(null);
                return;
            }
            int w = bmp.getWidth(), h = bmp.getHeight();
            int[] px = new int[w * h];
            bmp.getPixels(px, 0, w, 0, 0, w, h);
            bmp.recycle();

            Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
            hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
            hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
            MultiFormatReader reader = new MultiFormatReader();
            reader.setHints(hints);
            try {
                Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(w, h, px))));
                promise.resolve(r.getText());
            } catch (NotFoundException e) {
                promise.resolve(null);
            }
        } catch (Exception e) {
            promise.resolve(null);
        }
    }
}

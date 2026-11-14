package de.paul42.mayfly.filter;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import androidx.exifinterface.media.ExifInterface;
import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

/**
 * Bakes a photo for sending: colour filter on the photo, then the drawing / sticker layer
 * (transparent PNG of the editor canvas) on top. With a layer, the photo is cropped to the
 * canvas' aspect ratio exactly like the editor shows it ("cover"). The output is a fresh
 * JPEG in the app cache without any EXIF data (no camera model, no time, no location).
 */
public class ImageFilterModule extends ReactContextBaseJavaModule {
    private static final int MAX_SIDE = 2560;

    public ImageFilterModule(ReactApplicationContext ctx) {
        super(ctx);
    }

    @NonNull
    @Override
    public String getName() {
        return "MfImageFilter";
    }

    private InputStream open(String uri) throws Exception {
        Uri u = Uri.parse(uri);
        if (u.getScheme() == null) u = Uri.fromFile(new File(uri));
        InputStream in = getReactApplicationContext().getContentResolver().openInputStream(u);
        if (in == null) throw new IllegalStateException("cannot open " + uri);
        return in;
    }

    private int orientation(String uri) {
        try (InputStream in = open(uri)) {
            return new ExifInterface(in).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (Exception e) {
            return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    private Bitmap decode(String uri) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = open(uri)) { BitmapFactory.decodeStream(in, null, bounds); }
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2;
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = sample;
        Bitmap b;
        try (InputStream in = open(uri)) { b = BitmapFactory.decodeStream(in, null, o); }
        if (b == null) throw new IllegalStateException("not an image");
        Matrix m = new Matrix();
        switch (orientation(uri)) {
            case ExifInterface.ORIENTATION_ROTATE_90: m.postRotate(90); break;
            case ExifInterface.ORIENTATION_ROTATE_180: m.postRotate(180); break;
            case ExifInterface.ORIENTATION_ROTATE_270: m.postRotate(270); break;
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: m.postScale(1, -1); break;
            default: break;
        }
        if (!m.isIdentity()) {
            Bitmap r = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
            if (r != b) b.recycle();
            b = r;
        }
        return b;
    }

    /**
     * @param uri       the photo
     * @param matrix    20 floats (colour matrix) or null
     * @param overlay   PNG of the editor layer or null
     * @param aspect    width / height of the editor canvas (used with an overlay)
     */
    @ReactMethod
    public void bake(String uri, @Nullable ReadableArray matrix, @Nullable String overlay, double aspect, Promise promise) {
        new Thread(() -> {
            Bitmap src = null;
            Bitmap out = null;
            Bitmap layer = null;
            try {
                src = decode(uri);
                Rect crop = new Rect(0, 0, src.getWidth(), src.getHeight());
                if (overlay != null && aspect > 0.1 && aspect < 10) {
                    double a = (double) src.getWidth() / src.getHeight();
                    if (a > aspect) {
                        int w = (int) Math.round(src.getHeight() * aspect);
                        int x = (src.getWidth() - w) / 2;
                        crop = new Rect(x, 0, x + w, src.getHeight());
                    } else {
                        int h = (int) Math.round(src.getWidth() / aspect);
                        int y = (src.getHeight() - h) / 2;
                        crop = new Rect(0, y, src.getWidth(), y + h);
                    }
                }
                out = Bitmap.createBitmap(crop.width(), crop.height(), Bitmap.Config.ARGB_8888);
                Canvas c = new Canvas(out);
                Paint p = new Paint(Paint.FILTER_BITMAP_FLAG);
                if (matrix != null && matrix.size() == 20) {
                    float[] m = new float[20];
                    for (int i = 0; i < 20; i++) m[i] = (float) matrix.getDouble(i);
                    p.setColorFilter(new ColorMatrixColorFilter(new ColorMatrix(m)));
                }
                c.drawBitmap(src, crop, new Rect(0, 0, out.getWidth(), out.getHeight()), p);
                if (overlay != null) {
                    try (InputStream in = open(overlay)) { layer = BitmapFactory.decodeStream(in); }
                    if (layer != null) {
                        c.drawBitmap(layer, null, new RectF(0, 0, out.getWidth(), out.getHeight()), new Paint(Paint.FILTER_BITMAP_FLAG));
                    }
                }
                File f = new File(getReactApplicationContext().getCacheDir(), "moment_filtered_" + System.currentTimeMillis() + ".jpg");
                try (FileOutputStream fo = new FileOutputStream(f)) {
                    out.compress(Bitmap.CompressFormat.JPEG, 90, fo);
                }
                promise.resolve(Uri.fromFile(f).toString());
            } catch (Exception e) {
                promise.reject("filter", e.getMessage(), e);
            } finally {
                if (src != null) src.recycle();
                if (out != null) out.recycle();
                if (layer != null) layer.recycle();
            }
        }).start();
    }
}

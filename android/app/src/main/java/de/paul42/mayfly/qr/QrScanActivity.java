package de.paul42.mayfly.qr;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Full-screen QR scanner: CameraX preview + frame analysis decoded offline with ZXing.
 * No Google Play Services, no ML Kit, no network, no shutter sound. Returns the text
 * in the result intent ("text").
 */
public class QrScanActivity extends AppCompatActivity {
    private static final int REQ_CAMERA = 1;
    private PreviewView previewView;
    private final ExecutorService analysisExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean done = new AtomicBoolean(false);
    private final MultiFormatReader reader = new MultiFormatReader();

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        reader.setHints(hints);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        previewView = new PreviewView(this);
        root.addView(previewView, new FrameLayout.LayoutParams(-1, -1));

        android.view.View frame = new android.view.View(this);
        GradientDrawable border = new GradientDrawable();
        border.setStroke(dp(3), Color.parseColor("#2DD4BF"));
        border.setCornerRadius(dp(16));
        frame.setBackground(border);
        root.addView(frame, new FrameLayout.LayoutParams(dp(240), dp(240), Gravity.CENTER));

        TextView hint = new TextView(this);
        hint.setText("Point the camera at an Mayfly code");
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(15);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(dp(16), dp(10), dp(16), dp(10));
        hint.setBackgroundColor(Color.parseColor("#99000000"));
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        hp.bottomMargin = dp(72);
        root.addView(hint, hp);

        TextView close = new TextView(this);
        close.setText("Cancel");
        close.setTextColor(Color.parseColor("#00201C"));
        close.setTextSize(15);
        close.setGravity(Gravity.CENTER);
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(Color.parseColor("#2DD4BF"));
        pill.setCornerRadius(dp(12));
        close.setBackground(pill);
        close.setPadding(dp(24), dp(12), dp(24), dp(12));
        close.setContentDescription("Cancel");
        close.setOnClickListener(v -> finishWith(null));
        FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        cp.bottomMargin = dp(16);
        root.addView(close, cp);

        setContentView(root);

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            finishWith(null);
        }
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                ProcessCameraProvider provider = future.get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                        .setTargetResolution(new Size(1280, 720))
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build();
                analysis.setAnalyzer(analysisExecutor, this::analyze);
                provider.unbindAll();
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis);
            } catch (Exception e) {
                finishWith(null);
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void analyze(ImageProxy image) {
        try {
            if (done.get()) return;
            ImageProxy.PlaneProxy y = image.getPlanes()[0];
            ByteBuffer buf = y.getBuffer();
            byte[] data = new byte[buf.remaining()];
            buf.get(data);
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(
                    data, y.getRowStride(), image.getHeight(), 0, 0, image.getWidth(), image.getHeight(), false);
            Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(src)));
            if (r != null && done.compareAndSet(false, true)) {
                String text = r.getText();
                runOnUiThread(() -> finishWith(text));
            }
        } catch (Exception ignored) {
            // no QR code in this frame
        } finally {
            reader.reset();
            image.close();
        }
    }

    private void finishWith(String text) {
        if (text != null) setResult(RESULT_OK, new Intent().putExtra("text", text));
        else setResult(RESULT_CANCELED);
        finish();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        analysisExecutor.shutdown();
    }
}

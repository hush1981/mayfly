package de.paul42.mayfly.media;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraInfo;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ConcurrentCamera;
import androidx.camera.core.MirrorMode;
import androidx.camera.core.Preview;
import androidx.camera.core.UseCaseGroup;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.video.FallbackStrategy;
import androidx.camera.video.FileOutputOptions;
import androidx.camera.video.PendingRecording;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Dual camera: back and front camera at the same time (CameraX concurrent cameras), shown
 * as picture-in-picture or split screen. Tap = photo (both previews composed into one JPEG,
 * no EXIF), hold = video (two files: the main one with sound, the inset one without; the
 * viewer plays them on top of each other). Tap the small picture to swap the cameras.
 *
 * Phones that cannot run two cameras at once still get dual photos: back photo first, then
 * the front one right after. Dual video needs real concurrent camera support.
 *
 * Result extras: type (image|video), uri, inset (video), layout (pip|split), mainRect /
 * insetRect (fractions of the screen: l, t, w, h), aspect (screen w / h).
 */
public class DualCameraActivity extends AppCompatActivity {
    public static final String EXTRA_LABELS = "labels";
    private static final long MAX_VIDEO_MS = 30_000;

    private FrameLayout root;
    private FrameLayout mainBox;
    private FrameLayout insetBox;
    private PreviewView mainView;
    private PreviewView insetView;
    private TextView hint;
    private TextView shutter;
    private TextView layoutBtn;
    private ProcessCameraProvider provider;
    private CameraSelector backSel;
    private CameraSelector frontSel;
    private boolean concurrent;
    private boolean frontIsMain = false;
    private boolean split = false;
    private Preview backPreview;
    private Preview frontPreview;
    private VideoCapture<Recorder> backVideo;
    private VideoCapture<Recorder> frontVideo;
    private Recording recMain;
    private Recording recInset;
    private File fileMain;
    private File fileInset;
    private int finalized = 0;
    private boolean recording = false;
    private boolean busy = false;
    private long recStart = 0;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Bundle labels;

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private String label(String key, String fallback) {
        String v = labels != null ? labels.getString(key) : null;
        return v != null ? v : fallback;
    }

    private TextView pill(String text, int bg, int fg) {
        TextView v = new TextView(this);
        v.setText(text);
        v.setTextColor(fg);
        v.setTextSize(14);
        v.setGravity(Gravity.CENTER);
        GradientDrawable d = new GradientDrawable();
        d.setColor(bg);
        d.setCornerRadius(dp(22));
        v.setBackground(d);
        v.setPadding(dp(16), dp(10), dp(16), dp(10));
        return v;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        labels = getIntent().getBundleExtra(EXTRA_LABELS);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        mainBox = new FrameLayout(this);
        mainView = new PreviewView(this);
        mainView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        mainBox.addView(mainView, new FrameLayout.LayoutParams(-1, -1));
        root.addView(mainBox, new FrameLayout.LayoutParams(-1, -1));

        insetBox = new FrameLayout(this);
        insetView = new PreviewView(this);
        // TextureView: can be clipped to rounded corners and read back with getBitmap()
        insetView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        insetBox.addView(insetView, new FrameLayout.LayoutParams(-1, -1));
        insetBox.setClipToOutline(true);
        insetBox.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), split ? 0 : dp(14));
            }
        });
        insetBox.setOnClickListener(v -> swap());
        root.addView(insetBox);

        TextView close = pill("✕", Color.parseColor("#99000000"), Color.WHITE);
        close.setContentDescription(label("close", "Close"));
        close.setOnClickListener(v -> finishWith(null));
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(dp(44), dp(44), Gravity.TOP | Gravity.END);
        clp.topMargin = dp(40);
        clp.rightMargin = dp(12);
        root.addView(close, clp);

        layoutBtn = pill(label("split", "Split"), Color.parseColor("#99000000"), Color.WHITE);
        layoutBtn.setOnClickListener(v -> {
            if (recording || busy) return;
            split = !split;
            applyLayout();
        });
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, dp(44), Gravity.TOP | Gravity.END);
        lp.topMargin = dp(92);
        lp.rightMargin = dp(12);
        root.addView(layoutBtn, lp);

        hint = new TextView(this);
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(12);
        hint.setGravity(Gravity.CENTER);
        hint.setShadowLayer(4, 0, 1, Color.BLACK);
        hint.setText(label("hint", "Tap · photo  ·  Hold · video  ·  Tap the small picture to swap"));
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        hp.bottomMargin = dp(132);
        root.addView(hint, hp);

        shutter = new TextView(this);
        GradientDrawable sd = new GradientDrawable();
        sd.setShape(GradientDrawable.OVAL);
        sd.setColor(Color.WHITE);
        sd.setStroke(dp(5), Color.parseColor("#59FFFFFF"));
        shutter.setBackground(sd);
        shutter.setContentDescription(label("shutter", "Shutter"));
        FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(dp(76), dp(76), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        sp.bottomMargin = dp(44);
        root.addView(shutter, sp);
        setupShutter();

        setContentView(root);
        root.post(this::applyLayout);

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            finishWith(null);
            return;
        }
        ListenableFuture<ProcessCameraProvider> f = ProcessCameraProvider.getInstance(this);
        f.addListener(() -> {
            try {
                provider = f.get();
                findCameras();
                bind();
            } catch (Exception e) {
                toast(label("failed", "Dual camera is not available on this phone."));
                ui.postDelayed(() -> finishWith(null), 1500);
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void findCameras() {
        for (List<CameraInfo> combo : provider.getAvailableConcurrentCameraInfos()) {
            CameraInfo b = null, fr = null;
            for (CameraInfo ci : combo) {
                if (ci.getLensFacing() == CameraSelector.LENS_FACING_BACK && b == null) b = ci;
                else if (ci.getLensFacing() == CameraSelector.LENS_FACING_FRONT && fr == null) fr = ci;
            }
            if (b != null && fr != null) {
                backSel = b.getCameraSelector();
                frontSel = fr.getCameraSelector();
                concurrent = true;
                return;
            }
        }
        concurrent = false;
        backSel = CameraSelector.DEFAULT_BACK_CAMERA;
        frontSel = CameraSelector.DEFAULT_FRONT_CAMERA;
        hint.setText(label("sequential", "This phone can't use both cameras at once: tap takes the back photo, then the front one."));
    }

    private Recorder recorder(boolean hd) {
        return new Recorder.Builder()
                .setQualitySelector(QualitySelector.from(hd ? Quality.HD : Quality.SD,
                        FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
                .build();
    }

    private void bind() {
        provider.unbindAll();
        backPreview = new Preview.Builder().build();
        frontPreview = new Preview.Builder().build();
        attachSurfaces();
        if (concurrent) {
            backVideo = new VideoCapture.Builder<>(recorder(!frontIsMain)).setMirrorMode(MirrorMode.MIRROR_MODE_ON_FRONT_ONLY).build();
            frontVideo = new VideoCapture.Builder<>(recorder(frontIsMain)).setMirrorMode(MirrorMode.MIRROR_MODE_ON_FRONT_ONLY).build();
            List<ConcurrentCamera.SingleCameraConfig> cfg = new ArrayList<>();
            cfg.add(new ConcurrentCamera.SingleCameraConfig(backSel,
                    new UseCaseGroup.Builder().addUseCase(backPreview).addUseCase(backVideo).build(), this));
            cfg.add(new ConcurrentCamera.SingleCameraConfig(frontSel,
                    new UseCaseGroup.Builder().addUseCase(frontPreview).addUseCase(frontVideo).build(), this));
            try {
                provider.bindToLifecycle(cfg);
                return;
            } catch (Exception e) {
                // e.g. the stream combination is not supported: fall back to preview only
                try {
                    provider.unbindAll();
                    cfg.clear();
                    backVideo = null;
                    frontVideo = null;
                    cfg.add(new ConcurrentCamera.SingleCameraConfig(backSel, new UseCaseGroup.Builder().addUseCase(backPreview).build(), this));
                    cfg.add(new ConcurrentCamera.SingleCameraConfig(frontSel, new UseCaseGroup.Builder().addUseCase(frontPreview).build(), this));
                    provider.bindToLifecycle(cfg);
                    return;
                } catch (Exception e2) {
                    concurrent = false;
                    provider.unbindAll();
                }
            }
        }
        // one camera at a time: show the main camera, the inset shows the last frame / stays dark
        provider.bindToLifecycle(this, frontIsMain ? frontSel : backSel, frontIsMain ? frontPreview : backPreview);
    }

    private void attachSurfaces() {
        backPreview.setSurfaceProvider(frontIsMain ? insetView.getSurfaceProvider() : mainView.getSurfaceProvider());
        frontPreview.setSurfaceProvider(frontIsMain ? mainView.getSurfaceProvider() : insetView.getSurfaceProvider());
    }

    private void swap() {
        if (recording || busy || provider == null) return;
        frontIsMain = !frontIsMain;
        if (concurrent) {
            // new recorders so the main camera records in HD and with sound
            bind();
        } else {
            bind();
        }
    }

    private void applyLayout() {
        int w = root.getWidth(), h = root.getHeight();
        if (w == 0) return;
        FrameLayout.LayoutParams m = (FrameLayout.LayoutParams) mainBox.getLayoutParams();
        FrameLayout.LayoutParams i = (FrameLayout.LayoutParams) insetBox.getLayoutParams();
        if (i == null) i = new FrameLayout.LayoutParams(0, 0);
        if (split) {
            m.width = w; m.height = h / 2; m.gravity = Gravity.TOP; m.topMargin = 0; m.leftMargin = 0;
            i.width = w; i.height = h - h / 2; i.gravity = Gravity.TOP; i.topMargin = h / 2; i.leftMargin = 0;
        } else {
            m.width = w; m.height = h; m.gravity = Gravity.TOP; m.topMargin = 0; m.leftMargin = 0;
            i.width = (int) (w * 0.32f); i.height = (int) (i.width * 4f / 3f); i.gravity = Gravity.TOP | Gravity.START;
            i.topMargin = dp(40); i.leftMargin = dp(12);
        }
        mainBox.setLayoutParams(m);
        insetBox.setLayoutParams(i);
        insetBox.invalidateOutline();
        layoutBtn.setText(split ? label("pip", "Picture in picture") : label("split", "Split"));
    }

    // ---- shutter: tap = photo, hold = video ----------------------------------------------

    @SuppressLint("ClickableViewAccessibility")
    private void setupShutter() {
        final Runnable startVideo = () -> {
            if (concurrent && backVideo != null && frontVideo != null) startRecording();
            else toast(label("noVideo", "Dual video needs a phone that can use both cameras at once."));
        };
        shutter.setOnTouchListener((v, e) -> {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    if (busy) return true;
                    ui.postDelayed(startVideo, 400);
                    v.setTag(Boolean.FALSE);
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    ui.removeCallbacks(startVideo);
                    if (recording) stopRecording();
                    else if (!busy && e.getActionMasked() == MotionEvent.ACTION_UP) takePhoto();
                    return true;
            }
            return true;
        });
    }

    private void toast(String s) {
        android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_LONG).show();
    }

    // ---- photos --------------------------------------------------------------------------

    private RectF rectOf(View v) {
        return new RectF(v.getLeft(), v.getTop(), v.getRight(), v.getBottom());
    }

    private void takePhoto() {
        if (provider == null) return;
        busy = true;
        if (concurrent) {
            Bitmap main = mainView.getBitmap();
            Bitmap inset = insetView.getBitmap();
            finishPhoto(main, inset);
            return;
        }
        // Sequential: grab the main camera, switch, grab the other one.
        Bitmap first = mainView.getBitmap();
        hint.setText(label("second", "Now the other camera…"));
        frontIsMain = !frontIsMain;
        provider.unbindAll();
        provider.bindToLifecycle(this, frontIsMain ? frontSel : backSel, frontIsMain ? frontPreview : backPreview);
        frontPreview.setSurfaceProvider(mainView.getSurfaceProvider());
        backPreview.setSurfaceProvider(mainView.getSurfaceProvider());
        ui.postDelayed(() -> {
            Bitmap second = mainView.getBitmap();
            frontIsMain = !frontIsMain;
            finishPhoto(first, second);
        }, 1600);
    }

    private void finishPhoto(Bitmap main, Bitmap inset) {
        try {
            if (main == null || inset == null) throw new IllegalStateException("no preview frame");
            int w = root.getWidth(), h = root.getHeight();
            Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(out);
            c.drawColor(Color.BLACK);
            Paint p = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
            RectF mr = rectOf(mainBox);
            RectF ir = rectOf(insetBox);
            drawCover(c, main, mr, p, 0);
            drawCover(c, inset, ir, p, split ? 0 : dp(14));
            if (!split) {
                Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
                stroke.setStyle(Paint.Style.STROKE);
                stroke.setStrokeWidth(dp(2));
                stroke.setColor(Color.WHITE);
                c.drawRoundRect(ir, dp(14), dp(14), stroke);
            }
            File f = new File(getCacheDir(), "dual_" + System.currentTimeMillis() + ".jpg");
            try (FileOutputStream o = new FileOutputStream(f)) {
                out.compress(Bitmap.CompressFormat.JPEG, 90, o);
            }
            out.recycle();
            Intent r = new Intent();
            r.putExtra("type", "image");
            r.putExtra("uri", Uri.fromFile(f).toString());
            finishWith(r);
        } catch (Exception e) {
            busy = false;
            toast(label("failed", "Dual camera is not available on this phone."));
        }
    }

    private void drawCover(Canvas c, Bitmap b, RectF dst, Paint p, float radius) {
        float scale = Math.max(dst.width() / b.getWidth(), dst.height() / b.getHeight());
        float sw = dst.width() / scale, sh = dst.height() / scale;
        int sx = (int) ((b.getWidth() - sw) / 2), sy = (int) ((b.getHeight() - sh) / 2);
        Rect src = new Rect(sx, sy, sx + (int) sw, sy + (int) sh);
        c.save();
        if (radius > 0) {
            Path path = new Path();
            path.addRoundRect(dst, radius, radius, Path.Direction.CW);
            c.clipPath(path);
        }
        c.drawBitmap(b, src, dst, p);
        c.restore();
    }

    // ---- videos --------------------------------------------------------------------------

    @SuppressLint("MissingPermission")
    private void startRecording() {
        if (recording) return;
        recording = true;
        finalized = 0;
        layoutBtn.setVisibility(View.INVISIBLE);
        GradientDrawable sd = (GradientDrawable) shutter.getBackground();
        sd.setColor(Color.parseColor("#FF3B30"));
        VideoCapture<Recorder> mainCap = frontIsMain ? frontVideo : backVideo;
        VideoCapture<Recorder> insetCap = frontIsMain ? backVideo : frontVideo;
        fileMain = new File(getCacheDir(), "dual_main_" + System.currentTimeMillis() + ".mp4");
        fileInset = new File(getCacheDir(), "dual_inset_" + System.currentTimeMillis() + ".mp4");
        PendingRecording pm = mainCap.getOutput().prepareRecording(this,
                new FileOutputOptions.Builder(fileMain).setDurationLimitMillis(MAX_VIDEO_MS).build());
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            pm = pm.withAudioEnabled();
        }
        PendingRecording pi = insetCap.getOutput().prepareRecording(this,
                new FileOutputOptions.Builder(fileInset).setDurationLimitMillis(MAX_VIDEO_MS).build());
        recStart = System.currentTimeMillis();
        recMain = pm.start(ContextCompat.getMainExecutor(this), this::onRecordEvent);
        recInset = pi.start(ContextCompat.getMainExecutor(this), this::onRecordEvent);
        tick();
    }

    private void tick() {
        if (!recording) return;
        long s = (System.currentTimeMillis() - recStart) / 1000;
        hint.setText("● " + s + "s / " + (MAX_VIDEO_MS / 1000) + "s");
        ui.postDelayed(this::tick, 250);
    }

    private void stopRecording() {
        long elapsed = System.currentTimeMillis() - recStart;
        if (elapsed < 900) {
            ui.postDelayed(this::stopRecording, 900 - elapsed);
            return;
        }
        if (recMain != null) recMain.stop();
        if (recInset != null) recInset.stop();
        recMain = null;
        recInset = null;
        busy = true;
    }

    private void onRecordEvent(VideoRecordEvent e) {
        if (!(e instanceof VideoRecordEvent.Finalize)) return;
        finalized++;
        if (((VideoRecordEvent.Finalize) e).hasError()
                && ((VideoRecordEvent.Finalize) e).getError() != VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED) {
            // keep going: the other file may still be fine; checked below
        }
        // duration limit stops one of them on its own: stop the other as well
        if (finalized == 1 && recording) stopRecording();
        if (finalized < 2) return;
        recording = false;
        if (fileMain.length() < 1000 || fileInset.length() < 1000) {
            busy = false;
            fileMain.delete();
            fileInset.delete();
            toast(label("failed", "Dual camera is not available on this phone."));
            ((GradientDrawable) shutter.getBackground()).setColor(Color.WHITE);
            layoutBtn.setVisibility(View.VISIBLE);
            return;
        }
        int w = root.getWidth(), h = root.getHeight();
        Intent r = new Intent();
        r.putExtra("type", "video");
        r.putExtra("uri", Uri.fromFile(fileMain).toString());
        r.putExtra("inset", Uri.fromFile(fileInset).toString());
        r.putExtra("layout", split ? "split" : "pip");
        r.putExtra("mainRect", frac(rectOf(mainBox), w, h));
        r.putExtra("insetRect", frac(rectOf(insetBox), w, h));
        r.putExtra("aspect", (double) w / h);
        finishWith(r);
    }

    private static double[] frac(RectF r, int w, int h) {
        return new double[]{r.left / w, r.top / h, r.width() / w, r.height() / h};
    }

    private void finishWith(Intent data) {
        if (recording) {
            if (recMain != null) recMain.stop();
            if (recInset != null) recInset.stop();
        }
        setResult(data != null ? RESULT_OK : RESULT_CANCELED, data);
        finish();
    }

    @Override
    public void onBackPressed() {
        finishWith(null);
    }
}

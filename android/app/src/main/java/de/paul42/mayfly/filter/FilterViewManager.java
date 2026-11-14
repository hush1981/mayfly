package de.paul42.mayfly.filter;

import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.view.View;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.annotations.ReactProp;
import com.facebook.react.views.view.ReactViewGroup;
import com.facebook.react.views.view.ReactViewManager;

/**
 * A plain view container that draws its children through a colour matrix (hardware layer
 * with a ColorMatrixColorFilter). Used for the live filter preview and for playing filtered
 * videos (expo-av renders into a TextureView, which the layer filter applies to).
 * Everything happens on the device; nothing is uploaded.
 */
public class FilterViewManager extends ReactViewManager {
    @NonNull
    @Override
    public String getName() {
        return "MfFilterView";
    }

    @NonNull
    @Override
    public ReactViewGroup createViewInstance(@NonNull ThemedReactContext context) {
        return new ReactViewGroup(context);
    }

    @ReactProp(name = "matrix")
    public void setMatrix(ReactViewGroup view, @Nullable ReadableArray matrix) {
        if (matrix == null || matrix.size() != 20) {
            view.setLayerType(View.LAYER_TYPE_NONE, null);
            return;
        }
        float[] m = new float[20];
        for (int i = 0; i < 20; i++) m[i] = (float) matrix.getDouble(i);
        Paint paint = new Paint();
        paint.setColorFilter(new ColorMatrixColorFilter(new ColorMatrix(m)));
        view.setLayerType(View.LAYER_TYPE_HARDWARE, paint);
    }
}

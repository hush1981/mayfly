import React, { useRef, useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, PanResponder } from 'react-native';
import {
  CameraView, CameraType, useCameraPermissions, useMicrophonePermissions,
} from 'expo-camera';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RootStackParamList } from '../types';
import { Icon } from '../ui/kit';
import { MAX_VIDEO_DURATION_SECONDS } from '../config';
import { colors, shape, typescale } from '../theme';
import { showAlert } from '../ui/dialog';
import { openDualCamera } from '../media/tools';
import { t } from '../i18n';

type FlashMode = 'off' | 'on' | 'auto';
const TIMERS = [0, 3, 10];

type Props = NativeStackScreenProps<RootStackParamList, 'Camera'>;

function pinchDistance(touches: { pageX: number; pageY: number }[]): number {
  const dx = touches[0].pageX - touches[1].pageX;
  const dy = touches[0].pageY - touches[1].pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

export default function CameraScreen({ navigation, route }: Props) {
  const preset = route.params ?? {};
  const insets = useSafeAreaInsets();
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [isRecording, setIsRecording] = useState(false);
  const [zoom, setZoomState] = useState(0);

  const cameraRef = useRef<CameraView>(null);
  const isRecordingRef = useRef(false);
  const zoomRef = useRef(0);
  const lastTapRef = useRef(0);
  const pinchInitDistRef = useRef(0);
  const pinchInitZoomRef = useRef(0);
  // Manual long-press timer (replaces onLongPress to guarantee ordering with onPressOut)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);
  // Track when recording actually started, so stopRecording waits for camera pipeline
  const recordingStartedAtRef = useRef(0);
  const stopRequestedRef = useRef(false);
  const readyRef = useRef<(() => void) | null>(null);
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  // Hands-free: while holding the shutter for a video, slide it up or sideways onto the lock;
  // the recording then continues after letting go, and a tap on the shutter stops it.
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const [lockProgress, setLockProgress] = useState(0);
  const stopTapRef = useRef(false);
  const actionsRef = useRef({ start: () => {}, stop: () => {}, photo: () => {} });
  const [recMs, setRecMs] = useState(0);
  const modeRef = useRef<'picture' | 'video'>('picture');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [screenFlash, setScreenFlash] = useState(false);
  const [captureTick, setCaptureTick] = useState(0);
  const [timer, setTimer] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [grid, setGrid] = useState(false);

  function setZoom(v: number) {
    zoomRef.current = v;
    setZoomState(v);
  }

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      pinchInitDistRef.current = 0;
    },
    onPanResponderMove: (evt) => {
      const t = evt.nativeEvent.touches;
      if (t.length >= 2) {
        const dist = pinchDistance([t[0], t[1]]);
        if (pinchInitDistRef.current === 0) {
          pinchInitDistRef.current = dist;
          pinchInitZoomRef.current = zoomRef.current;
        } else {
          const scale = dist / pinchInitDistRef.current;
          const newZoom = Math.max(0, Math.min(1, pinchInitZoomRef.current + (scale - 1) * 0.6));
          zoomRef.current = newZoom;
          setZoomState(newZoom);
        }
      }
    },
    onPanResponderRelease: (_, state) => {
      const wasPinch = pinchInitDistRef.current > 0;
      pinchInitDistRef.current = 0;
      // Detect double-tap (not a pinch, minimal movement)
      if (!wasPinch && Math.abs(state.dx) < 10 && Math.abs(state.dy) < 10) {
        const now = Date.now();
        if (now - lastTapRef.current < 300) {
          setFacing(f => f === 'back' ? 'front' : 'back');
          lastTapRef.current = 0;
        } else {
          lastTapRef.current = now;
        }
      }
    },
    onPanResponderTerminate: () => {
      pinchInitDistRef.current = 0;
    },
  }), []); // created once — mutable state accessed via refs

  // Shutter gesture on raw touch events (independent of the responder system, which could
  // stay stuck after a recording): tap = photo, hold = video, slide up / sideways = lock.
  const LOCK_DISTANCE = 90;
  const touchStartRef = useRef({ x: 0, y: 0 });
  const touchActiveRef = useRef(false);
  const shutterTouch = useMemo(() => {
    const clearTimer = () => {
      if (longPressTimerRef.current !== null) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
    return {
      onTouchStart: (e: { nativeEvent: { pageX: number; pageY: number } }) => {
        touchActiveRef.current = true;
        touchStartRef.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
        didLongPressRef.current = false;
        stopTapRef.current = false;
        if (lockedRef.current && isRecordingRef.current) {
          stopTapRef.current = true; // locked recording: this tap stops it
          return;
        }
        clearTimer();
        longPressTimerRef.current = setTimeout(() => {
          longPressTimerRef.current = null;
          if (!touchActiveRef.current) return;
          didLongPressRef.current = true;
          actionsRef.current.start();
        }, 400);
      },
      onTouchMove: (e: { nativeEvent: { pageX: number; pageY: number } }) => {
        if (!didLongPressRef.current || lockedRef.current) return;
        const dx = e.nativeEvent.pageX - touchStartRef.current.x;
        const dy = e.nativeEvent.pageY - touchStartRef.current.y;
        const p = Math.max(0, Math.min(1, Math.max(-dy, Math.abs(dx)) / LOCK_DISTANCE));
        setLockProgress(p);
        if (p >= 1) {
          lockedRef.current = true;
          setLocked(true);
        }
      },
      onTouchEnd: () => {
        if (!touchActiveRef.current) return;
        touchActiveRef.current = false;
        clearTimer();
        setLockProgress(0);
        if (stopTapRef.current) {
          stopTapRef.current = false;
          actionsRef.current.stop();
        } else if (!didLongPressRef.current) {
          actionsRef.current.photo();
        } else if (!lockedRef.current) {
          actionsRef.current.stop();
        }
      },
      onTouchCancel: () => {
        if (!touchActiveRef.current) return;
        touchActiveRef.current = false;
        clearTimer();
        setLockProgress(0);
        if (didLongPressRef.current && !lockedRef.current) actionsRef.current.stop();
      },
    };
  }, []);

  if (!camPerm || !micPerm) {
    return <View style={styles.container} />;
  }

  if (!camPerm.granted || !micPerm.granted) {
    return (
      <View style={styles.permContainer}>
        <View style={styles.permCard}>
          <Icon name="camera-outline" size={44} color={colors.primary} />
          <Text style={styles.permTitle}>{t('Camera & mic access needed')}</Text>
          <Text style={styles.permBody}>
            {t('Mayfly needs camera and microphone access to take photos and record videos.')}
          </Text>
          <TouchableOpacity
            style={styles.permBtn}
            onPress={async () => {
              if (!camPerm.granted) await requestCamPerm();
              if (!micPerm.granted) await requestMicPerm();
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.permBtnText}>{t('Grant access')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  async function capturePhoto() {
    if (!cameraRef.current || isRecordingRef.current) return;
    // Front camera "flash": a white screen lights the face for a moment.
    const front = facing === 'front' && flash !== 'off';
    // expo-camera runs view methods with the next native UI batch: without re-renders the
    // capture waits (front flash: until the next tap). Keep UI batches flowing until it is done.
    const pump = setInterval(() => setCaptureTick((n) => n + 1), 100);
    try {
      if (front) {
        setScreenFlash(true);
        await new Promise((r) => setTimeout(r, 450));
      }
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (photo?.uri) navigation.navigate('Compose', { uri: photo.uri, type: 'image', ...preset });
    } catch (_) {
    } finally {
      clearInterval(pump);
      if (front) setScreenFlash(false);
    }
  }

  /** Tap on the shutter: photo now, or after the self-timer (tap again to cancel). */
  function takePhoto() {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
      setCountdown(0);
      return;
    }
    if (!timer) { capturePhoto(); return; }
    let left = timer;
    setCountdown(left);
    countdownRef.current = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        if (countdownRef.current) clearInterval(countdownRef.current);
        countdownRef.current = null;
        setCountdown(0);
        capturePhoto();
      } else {
        setCountdown(left);
      }
    }, 1000);
  }

  async function dualCamera() {
    if (isRecordingRef.current) return;
    try {
      // The dual camera binds the same CameraX provider. Release ours first and rebind it
      // afterwards: expo-camera does not do that by itself (black preview after ✕).
      // Do not remount the CameraView instead: the old view's unbindAll() kills the new one.
      await cameraRef.current?.pausePreview().catch(() => {});
      const r = await openDualCamera().finally(() => { cameraRef.current?.resumePreview().catch(() => {}); });
      if (!r) return;
      if (r.type === 'image') {
        navigation.navigate('Compose', { uri: r.uri, type: 'image', ...preset });
      } else if (r.inset && r.insetRect && r.mainRect) {
        navigation.navigate('Compose', {
          uri: r.uri, type: 'video', ...preset,
          dual: { uri: r.inset, rect: r.insetRect, main: r.mainRect, layout: r.layout ?? 'pip' },
        });
      }
    } catch (e: any) {
      showAlert(t('Dual camera'), e?.message ?? t('Dual camera is not available on this phone.'));
    }
  }

  async function pickFromGallery() {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 0.8,
      videoMaxDuration: MAX_VIDEO_DURATION_SECONDS,
    });
    const a = res.canceled ? undefined : res.assets[0];
    if (!a) return;
    if (a.type === 'video' && (a.duration ?? 0) > (MAX_VIDEO_DURATION_SECONDS + 0.5) * 1000) {
      showAlert(t('Video too long'), t('Videos can be at most {n} seconds long.', { n: MAX_VIDEO_DURATION_SECONDS }));
      return;
    }
    navigation.navigate('Compose', { uri: a.uri, type: a.type === 'video' ? 'video' : 'image', ...preset });
  }

  /**
   * Android (expo-camera 15 / CameraX) only binds the video use case in mode="video".
   * Recording in photo mode never finishes — that was the "video recorded but nothing
   * happens" bug. So: switch to video mode, wait for the camera to reopen, then record.
   */
  function waitForCameraReady(timeoutMs: number): Promise<void> {
    // After a mode switch CameraX first re-reports the *old* session as OPEN, then closes
    // and reopens with the video use case. Recording on the first signal gets killed by the
    // rebind ("stopped before any data"). So wait for the second signal; if a device keeps the
    // camera open and sends only one, continue 1.5 s after it.
    return new Promise((resolve) => {
      let count = 0;
      let afterFirst: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(overall);
        if (afterFirst) clearTimeout(afterFirst);
        readyRef.current = null;
        resolve();
      };
      const overall = setTimeout(finish, timeoutMs);
      readyRef.current = () => {
        count += 1;
        if (count >= 2) finish();
        else afterFirst = setTimeout(finish, 1500);
      };
    });
  }

  async function startRecording() {
    if (!cameraRef.current || isRecordingRef.current) return;
    isRecordingRef.current = true;
    stopRequestedRef.current = false;
    recordingStartedAtRef.current = 0;
    setIsRecording(true);
    let resultUri: string | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    try {
      if (modeRef.current !== 'video') {
        const ready = waitForCameraReady(3000);
        modeRef.current = 'video';
        setMode('video');
        await ready;
        await new Promise((r) => setTimeout(r, 250)); // let the encoder surface settle
      }
      if (!cameraRef.current) throw new Error('Camera closed');
      const pending = cameraRef.current.recordAsync({ maxDuration: MAX_VIDEO_DURATION_SECONDS });
      recordingStartedAtRef.current = Date.now();
      // expo-camera runs view methods with the next native UI batch. Without a re-render the
      // start would wait until the shutter is released (start + stop together = no data).
      // The ticking counter keeps UI batches flowing and shows the recording time.
      setRecMs(1);
      tick = setInterval(() => setRecMs(Date.now() - recordingStartedAtRef.current + 1), 250);
      // Released before the camera was ready: still keep a short clip.
      if (stopRequestedRef.current) setTimeout(() => cameraRef.current?.stopRecording(), 800);
      const video = await pending;
      resultUri = video?.uri;
    } catch (e: any) {
      resultUri = e?.uri;
      if (!resultUri) showAlert(t('Recording failed'), e?.message ?? t('Unknown error'));
    } finally {
      if (tick) clearInterval(tick);
      setRecMs(0);
      isRecordingRef.current = false;
      recordingStartedAtRef.current = 0;
      setIsRecording(false);
      modeRef.current = 'picture';
      setMode('picture');
    }
    lockedRef.current = false;
    setLocked(false);
    if (resultUri) navigation.navigate('Compose', { uri: resultUri, type: 'video', ...preset });
  }

  async function stopRecording() {
    if (!cameraRef.current || !isRecordingRef.current) return;
    if (!recordingStartedAtRef.current) {
      // Still switching to video mode — startRecording stops right after it began.
      stopRequestedRef.current = true;
      return;
    }
    // Wait at least 800 ms from recording start so the encoder produced a valid file
    const elapsed = Date.now() - recordingStartedAtRef.current;
    if (elapsed < 800) {
      await new Promise<void>((r) => setTimeout(r, 800 - elapsed));
    }
    if (isRecordingRef.current) cameraRef.current?.stopRecording();
  }

  actionsRef.current = { start: startRecording, stop: stopRecording, photo: takePhoto };

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        facing={facing}
        // Front camera like a mirror everywhere: the photo / video is saved exactly as the
        // (mirrored) preview shows it.
        mirror
        ref={cameraRef}
        zoom={zoom}
        mode={mode}
        flash={facing === 'back' ? flash : 'off'}
        enableTorch={facing === 'back' && flash === 'on' && isRecording}
        videoQuality="720p"
        onCameraReady={() => readyRef.current?.()}
      >

        {/* Top bar */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.circleBtn}>
            <Icon name="close" size={22} color="#fff" />
          </TouchableOpacity>
          {preset.peerName ? (
            <View style={styles.toChip}>
              <Text style={styles.toText}>{t('To {name}', { name: preset.peerName })}</Text>
            </View>
          ) : null}
          <View style={{ flex: 1 }} />
          {zoom > 0.01 && (
            <TouchableOpacity onPress={() => setZoom(0)} style={[styles.circleBtn, styles.zoomBadge]}>
              <Text style={styles.zoomText}>{Math.round(zoom * 10 * 10) / 10}×</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* collapsable={false}: a view with opacity 1 and no background counts as "layout only" and
            gets flattened; toggling the opacity would then create it later — CameraView trap again. */}
        <View collapsable={false} style={[StyleSheet.absoluteFill, { opacity: grid ? 1 : 0 }]} pointerEvents="none">
          <View style={[styles.gridV, { left: '33.33%' }]} />
          <View style={[styles.gridV, { left: '66.66%' }]} />
          <View style={[styles.gridH, { top: '33.33%' }]} />
          <View style={[styles.gridH, { top: '66.66%' }]} />
        </View>

        <View collapsable={false} style={[StyleSheet.absoluteFill, styles.countdown, { opacity: countdown > 0 ? 1 : 0 }]} pointerEvents="none">
          <Text style={styles.countdownText}>{countdown || ''}</Text>
          {/* invisible pixel whose opacity changes while a photo is taken = a native UI batch */}
          <View style={{ width: 1, height: 1, opacity: captureTick % 2 ? 0.01 : 0.02 }} />
        </View>

        <View collapsable={false} style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: screenFlash ? 1 : 0 }]} pointerEvents="none" />

        {/* Always mounted: expo-camera reorders its native children when one is added
            (bringToFront), so adding/removing direct children here desyncs React's view
            indexes — that made the shutter disappear after a recording. Toggle opacity instead. */}
        {(
          <View collapsable={false} style={[styles.recTop, { top: insets.top + 64, opacity: isRecording ? 1 : 0 }]} pointerEvents="none">
            <View style={styles.recordingPill}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingText}>
                {recMs > 0 ? `${Math.floor(recMs / 1000)}s / ${MAX_VIDEO_DURATION_SECONDS}s` : t('Starting…')}
                {locked ? '  ·  🔒' : ''}
              </Text>
            </View>
          </View>
        )}

        {/* Gesture area: fills the space between top bar and bottom bar.
            Handles pinch-to-zoom and double-tap to flip. */}
        <View style={styles.gestureArea} {...panResponder.panHandlers} />

        {/* Side tools: after the gesture area so they get the touches (always mounted, see the note above) */}
        <View collapsable={false} style={[styles.sideTools, { top: insets.top + 60, opacity: isRecording ? 0 : 1 }]} pointerEvents={isRecording ? 'none' : 'box-none'}>
          <TouchableOpacity
            onPress={() => setFlash((f) => (f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'))}
            style={styles.circleBtn}
            accessibilityLabel={t('Flash')}
          >
            <Icon name={flash === 'off' ? 'flash-off' : flash === 'on' ? 'flash' : 'flash-auto'} size={22} color={flash === 'off' ? '#fff' : colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setTimer((x) => TIMERS[(TIMERS.indexOf(x) + 1) % TIMERS.length])}
            style={styles.circleBtn}
            accessibilityLabel={t('Self-timer')}
          >
            <Icon name={timer ? 'timer-outline' : 'timer-off-outline'} size={22} color={timer ? colors.primary : '#fff'} />
            <Text style={[styles.toolBadge, { opacity: timer ? 1 : 0 }]}>{timer}s</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setGrid((g) => !g)} style={styles.circleBtn} accessibilityLabel={t('Grid')}>
            <Icon name={grid ? 'grid' : 'grid-off'} size={22} color={grid ? colors.primary : '#fff'} />
          </TouchableOpacity>
          <TouchableOpacity onPress={dualCamera} style={styles.circleBtn} accessibilityLabel={t('Dual camera')}>
            <Icon name="camera-switch-outline" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Bottom controls */}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 20 }]}>
          {isRecording ? (
            <Text style={styles.hint}>{locked ? t('Locked — tap the shutter to stop') : t('Slide up onto the lock to keep recording')}</Text>
          ) : (
            <Text style={styles.hint}>{t('Tap · photo  ·  Hold · video (slide up to lock)  ·  2× tap · flip')}</Text>
          )}

          <View
            pointerEvents="none"
            collapsable={false}
            style={[
              styles.lockTarget,
              { bottom: insets.bottom + 20 + 76 + 22 },
              locked && styles.lockTargetOn,
              { opacity: !isRecording ? 0 : locked ? 1 : 0.55 + lockProgress * 0.45, transform: [{ scale: 1 + lockProgress * 0.25 }] },
            ]}
          >
            <Icon name={locked ? 'lock' : 'lock-open-variant-outline'} size={22} color={locked ? '#000' : '#fff'} />
            {!locked && <Icon name="chevron-up" size={16} color="#fff" />}
          </View>

          <View style={styles.shutterRow}>
            {/* Flip button (also reachable via double-tap on camera view) */}
            <TouchableOpacity
              onPress={() => setFacing(f => f === 'back' ? 'front' : 'back')}
              style={styles.circleBtn}
            >
              <Icon name="camera-flip-outline" size={22} color="#fff" />
            </TouchableOpacity>

            {/* Shutter: tap = photo, hold = video, release = stop, slide onto the lock = hands-free */}
            <View
              {...shutterTouch}
              collapsable={false}
              style={[styles.shutter, isRecording && styles.shutterRecording]}
              accessibilityRole="button"
              accessibilityLabel={locked ? t('Stop recording') : t('Shutter')}
            >
              <View style={[styles.shutterInner, !isRecording && { opacity: 0 }]} />
            </View>

            <TouchableOpacity onPress={pickFromGallery} style={styles.circleBtn} accessibilityLabel={t('Gallery')}>
              <Icon name="image-multiple-outline" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },

  permContainer: {
    flex: 1, backgroundColor: colors.background,
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  permCard: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: shape.extraLarge,
    padding: 32, alignItems: 'center', gap: 12, width: '100%',
  },
  permIcon: { fontSize: 48, marginBottom: 4 },
  permTitle: { ...typescale.headlineSmall, color: colors.onSurface, textAlign: 'center' },
  permBody: {
    ...typescale.bodyMedium,
    color: colors.onSurfaceVariant, textAlign: 'center', lineHeight: 20,
  },
  permBtn: {
    backgroundColor: colors.primary, borderRadius: shape.full,
    paddingVertical: 16, paddingHorizontal: 32, marginTop: 8,
  },
  permBtnText: { ...typescale.labelLarge, color: colors.onPrimary, fontSize: 15 },

  topBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, gap: 8,
  },
  toChip: {
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: shape.full,
    paddingHorizontal: 12, height: 32, justifyContent: 'center',
  },
  toText: { ...typescale.labelLarge, color: '#fff' },
  lockTarget: {
    position: 'absolute', alignSelf: 'center',
    width: 46, height: 64, borderRadius: 23,
    backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center',
  },
  lockTargetOn: { backgroundColor: colors.primary, height: 46 },
  circleBtn: {
    width: 44, height: 44, borderRadius: shape.full,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', alignItems: 'center',
  },
  circleBtnText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  zoomBadge: { paddingHorizontal: 10 },
  sideTools: { position: 'absolute', right: 12, gap: 10 },
  toolBadge: { position: 'absolute', bottom: 2, color: colors.primary, fontSize: 9, fontWeight: '800' },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.55)' },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.55)' },
  countdown: { alignItems: 'center', justifyContent: 'center' },
  countdownText: { color: '#fff', fontSize: 120, fontWeight: '900', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 12 },
  zoomText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // Fills the middle — absorbs double-tap & pinch gestures
  gestureArea: { flex: 1 },

  bottomBar: {
    alignItems: 'center',
    paddingTop: 12,
    gap: 14,
  },
  hint: { color: 'rgba(255,255,255,0.75)', ...typescale.labelSmall },
  recTop: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  recordingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: shape.full,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  recordingDot: {
    width: 8, height: 8, borderRadius: shape.full, backgroundColor: colors.error,
  },
  recordingText: { color: '#fff', ...typescale.labelMedium },

  shutterRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%', paddingHorizontal: 40,
  },
  circleBtnPlaceholder: { width: 44, height: 44 },
  shutter: {
    width: 76, height: 76, borderRadius: shape.full,
    backgroundColor: '#fff',
    borderWidth: 5, borderColor: 'rgba(255,255,255,0.35)',
    justifyContent: 'center', alignItems: 'center',
  },
  shutterRecording: {
    backgroundColor: colors.error,
    borderColor: 'rgba(255,75,75,0.35)',
  },
  shutterInner: {
    width: 28, height: 28, borderRadius: shape.small, backgroundColor: '#fff',
  },
});

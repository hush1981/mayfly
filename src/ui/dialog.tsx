/**
 * App-wide dialogs and action sheets in Mayfly's own look (instead of the system's
 * Alert): a card that slides up from the bottom, large rounded corners, full-width
 * buttons within thumb reach. `showAlert` has the same signature as Alert.alert, so it
 * can be called from anywhere (also outside components).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated, BackHandler, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, shape, typescale } from '../theme';
import { Icon, IconName } from './kit';
import { t } from '../i18n';

export interface AlertButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

export interface SheetAction {
  label: string;
  icon?: IconName;
  destructive?: boolean;
  onPress: () => void;
}

interface DialogSpec {
  kind: 'alert' | 'sheet';
  title?: string;
  message?: string;
  icon?: IconName;
  buttons?: AlertButton[];
  actions?: SheetAction[];
  /** Optional custom content above the actions (e.g. a reaction row). */
  header?: (close: () => void) => React.ReactNode;
  /** Text field (prompt dialogs). */
  input?: { initial: string; placeholder?: string; maxLength?: number; value: { current: string } };
}

let current: DialogSpec | null = null;
const queue: DialogSpec[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function push(spec: DialogSpec) {
  if (current) queue.push(spec);
  else current = spec;
  emit();
}

function next() {
  current = queue.shift() ?? null;
  emit();
}

function guessIcon(title: string, buttons?: AlertButton[]): IconName | undefined {
  if (buttons?.some((b) => b.style === 'destructive')) return 'alert-outline';
  if (/fail|error|could not|invalid|not available/i.test(title)) return 'alert-circle-outline';
  return undefined;
}

/** Drop-in replacement for Alert.alert(title, message, buttons). */
export function showAlert(title: string, message?: string, buttons?: AlertButton[], opts?: { icon?: IconName }) {
  push({ kind: 'alert', title, message, buttons, icon: opts?.icon ?? guessIcon(title, buttons) });
}

/** Asks a yes/no question; resolves true when the confirm button was pressed. */
export function ask(opts: {
  title: string; message?: string; confirm: string; cancel?: string; destructive?: boolean; icon?: IconName;
}): Promise<boolean> {
  return new Promise((resolve) => {
    push({
      kind: 'alert',
      title: opts.title,
      message: opts.message,
      icon: opts.icon ?? (opts.destructive ? 'alert-outline' : undefined),
      buttons: [
        { text: opts.cancel ?? t('Cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: opts.confirm, style: opts.destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
    });
  });
}

/** Asks for a line of text; resolves null when cancelled. */
export function promptText(opts: {
  title: string; message?: string; initial?: string; placeholder?: string; confirm?: string; maxLength?: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const value = { current: opts.initial ?? '' };
    push({
      kind: 'alert',
      title: opts.title,
      message: opts.message,
      input: { initial: opts.initial ?? '', placeholder: opts.placeholder, maxLength: opts.maxLength, value },
      buttons: [
        { text: t('Cancel'), style: 'cancel', onPress: () => resolve(null) },
        { text: opts.confirm ?? t('Save'), onPress: () => resolve(value.current) },
      ],
    });
  });
}

/** Action menu (e.g. long-press on a message). */
export function showSheet(opts: {
  title?: string; message?: string; actions: SheetAction[]; header?: (close: () => void) => React.ReactNode;
}) {
  push({ kind: 'sheet', ...opts });
}

/** Rendered once at the root of the app. */
export function DialogHost() {
  const [spec, setSpec] = useState<DialogSpec | null>(current);
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);

  useEffect(() => {
    const l = () => setSpec(current);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  useEffect(() => {
    if (!spec) return;
    closingRef.current = false;
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [spec, anim]);

  function close(after?: () => void) {
    if (closingRef.current) return;
    closingRef.current = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      next();
      after?.();
    };
    Animated.timing(anim, { toValue: 0, duration: 160, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(finish);
    // Never let a lost animation callback block every later dialog.
    setTimeout(finish, 600);
  }

  function cancel() {
    if (!spec) return;
    const c = spec.buttons?.find((b) => b.style === 'cancel');
    close(c?.onPress);
  }

  useEffect(() => {
    if (!spec) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { cancel(); return true; });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  if (!spec) return null;

  const buttons = spec.kind === 'alert'
    ? (spec.buttons && spec.buttons.length > 0 ? spec.buttons : [{ text: t('OK') }])
    : [];
  // Primary action first (thumb), cancel last.
  const ordered = [...buttons.filter((b) => b.style !== 'cancel'), ...buttons.filter((b) => b.style === 'cancel')];
  const single = ordered.length === 1;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={cancel}>
      <Animated.View style={[styles.scrim, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={cancel} />
      </Animated.View>
      <Animated.View
        style={[styles.card, { paddingBottom: 16 + insets.bottom, opacity: anim, transform: [{ translateY }] }]}
      >
        <View style={styles.handle} />
        {spec.icon && (
          <View style={styles.iconWrap}>
            <Icon name={spec.icon} size={26} color={spec.buttons?.some((b) => b.style === 'destructive') ? colors.error : colors.primaryText} />
          </View>
        )}
        {spec.title ? <Text style={[styles.title, spec.kind === 'sheet' && styles.sheetTitle]}>{spec.title}</Text> : null}
        {spec.message ? <Text style={[styles.message, spec.kind === 'sheet' && styles.sheetMessage]}>{spec.message}</Text> : null}
        {spec.header?.(() => close())}
        {spec.input && (
          <TextInput
            autoFocus
            defaultValue={spec.input.initial}
            placeholder={spec.input.placeholder}
            placeholderTextColor={colors.outline}
            maxLength={spec.input.maxLength ?? 40}
            selectionColor={colors.primaryText}
            onChangeText={(t) => { spec.input!.value.current = t; }}
            style={styles.input}
          />
        )}

        {spec.kind === 'alert' ? (
          <View style={styles.buttons}>
            {ordered.map((b, i) => {
              const destructive = b.style === 'destructive';
              const isCancel = b.style === 'cancel';
              const primary = !isCancel && !destructive && (i === 0 || single);
              return (
                <TouchableOpacity
                  key={`${b.text}-${i}`}
                  style={[
                    styles.btn,
                    primary && styles.btnPrimary,
                    destructive && styles.btnDestructive,
                    isCancel && styles.btnCancel,
                    !primary && !destructive && !isCancel && styles.btnTonal,
                  ]}
                  onPress={() => close(b.onPress)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[
                      styles.btnText,
                      primary && { color: colors.onPrimary },
                      destructive && { color: colors.onErrorContainer },
                      isCancel && { color: colors.onSurfaceVariant },
                    ]}
                  >
                    {b.text}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ) : (
          <ScrollView style={styles.actions} bounces={false}>
            {spec.actions?.map((a, i) => (
              <TouchableOpacity key={`${a.label}-${i}`} style={styles.action} onPress={() => close(a.onPress)} activeOpacity={0.7}>
                {a.icon && <Icon name={a.icon} size={22} color={a.destructive ? colors.error : colors.onSurface} />}
                <Text style={[styles.actionText, a.destructive && { color: colors.error }]}>{a.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[styles.btn, styles.btnCancel, { marginTop: 6 }]} onPress={() => close()} activeOpacity={0.8}>
              <Text style={[styles.btnText, { color: colors.onSurfaceVariant }]}>{t('Cancel')}</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  card: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: colors.surfaceContainer,
    borderTopLeftRadius: shape.extraLarge, borderTopRightRadius: shape.extraLarge,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.outlineVariant,
    paddingHorizontal: 20, paddingTop: 10,
    maxHeight: '85%',
  },
  handle: {
    alignSelf: 'center', width: 36, height: 4, borderRadius: 2,
    backgroundColor: colors.outline, opacity: 0.5, marginBottom: 14,
  },
  iconWrap: {
    alignSelf: 'flex-start', width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.surfaceContainerHigh,
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
  },
  title: { ...typescale.titleLarge, fontWeight: '700', color: colors.onSurface, fontSize: 20 },
  sheetTitle: { fontSize: 17, marginBottom: 2 },
  message: { ...typescale.bodyMedium, color: colors.onSurfaceVariant, marginTop: 8, lineHeight: 20, fontSize: 15 },
  sheetMessage: { marginTop: 2, fontSize: 13 },
  buttons: { marginTop: 20, gap: 8 },
  btn: { height: 50, borderRadius: shape.large, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnPrimary: { backgroundColor: colors.primary },
  btnDestructive: { backgroundColor: colors.errorContainer },
  btnTonal: { backgroundColor: colors.surfaceContainerHigh },
  btnCancel: { backgroundColor: 'transparent' },
  btnText: { ...typescale.labelLarge, fontSize: 16, fontWeight: '600', color: colors.onSurface },
  actions: { marginTop: 8 },
  input: {
    marginTop: 16, height: 50, borderRadius: shape.medium, paddingHorizontal: 14,
    backgroundColor: colors.surfaceContainerHigh, color: colors.onSurface, fontSize: 16,
    borderWidth: 1, borderColor: colors.outlineVariant,
  },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    height: 52, paddingHorizontal: 6,
    borderRadius: shape.medium,
  },
  actionText: { ...typescale.bodyLarge, color: colors.onSurface, fontSize: 16 },
});

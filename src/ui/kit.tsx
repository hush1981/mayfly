/** Small shared UI building blocks — compact, flat, no glass/blur surfaces. */
import React, { useState } from 'react';
import {
  ActivityIndicator, Image, StyleProp, StyleSheet, Text, TextInput, TextInputProps,
  TouchableOpacity, View, ViewStyle,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { colors, shape, typescale } from '../theme';
import { ChatMoment, canReplay } from '../store/chatStore';
import { t } from '../i18n';

export type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({ name, size = 22, color = colors.onSurface }: { name: IconName; size?: number; color?: string }) {
  return <MaterialCommunityIcons name={name} size={size} color={color} />;
}

export function IconButton({
  name, onPress, color = colors.onSurface, size = 22, style, filled, accessibilityLabel,
}: {
  name: IconName; onPress: () => void; color?: string; size?: number;
  style?: StyleProp<ViewStyle>; filled?: boolean; accessibilityLabel?: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[kit.iconBtn, filled && kit.iconBtnFilled, style]}
      hitSlop={6}
      accessibilityLabel={accessibilityLabel}
      activeOpacity={0.7}
    >
      <Icon name={name} size={size} color={color} />
    </TouchableOpacity>
  );
}

export function Avatar({
  uri, name, size = 40, token, tint = colors.primaryContainer, textColor = colors.onPrimaryContainer, icon,
}: {
  uri?: string | null; name: string; size?: number; token?: string;
  tint?: string; textColor?: string; icon?: IconName;
}) {
  const [failed, setFailed] = useState(false);
  const r = size / 2;
  if (uri && !failed) {
    return (
      <Image
        source={{ uri, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
        style={{ width: size, height: size, borderRadius: r, backgroundColor: tint }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: r, backgroundColor: tint, alignItems: 'center', justifyContent: 'center' }}>
      {icon ? (
        <Icon name={icon} size={size * 0.5} color={textColor} />
      ) : (
        <Text style={{ color: textColor, fontSize: size * 0.42, fontWeight: '600' }}>
          {(name[0] ?? '?').toUpperCase()}
        </Text>
      )}
    </View>
  );
}

export function Button({
  label, onPress, kind = 'primary', loading, disabled, icon, style,
}: {
  label: string; onPress: () => void; kind?: 'primary' | 'tonal' | 'text' | 'danger';
  loading?: boolean; disabled?: boolean; icon?: IconName; style?: StyleProp<ViewStyle>;
}) {
  const bg = kind === 'primary' ? colors.primary
    : kind === 'tonal' ? colors.surfaceContainerHigh
    : kind === 'danger' ? colors.errorContainer : 'transparent';
  const fg = kind === 'primary' ? colors.onPrimary
    : kind === 'danger' ? colors.onErrorContainer
    : kind === 'text' ? colors.primaryText : colors.onSurface;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
      style={[kit.btn, { backgroundColor: bg }, (disabled || loading) && { opacity: 0.5 }, style]}
    >
      {loading ? <ActivityIndicator color={fg} size="small" /> : (
        <>
          {icon && <Icon name={icon} size={18} color={fg} />}
          <Text style={[kit.btnText, { color: fg }]}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

export function Field({ label, style, ...props }: TextInputProps & { label: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[kit.field, focused && kit.fieldFocused]}>
      <Text style={[kit.fieldLabel, focused && { color: colors.primaryText }]}>{label}</Text>
      <TextInput
        {...props}
        style={[kit.fieldInput, style]}
        placeholderTextColor={colors.outline}
        selectionColor={colors.primaryText}
        onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
      />
    </View>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={kit.section}>{children}</Text>;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('now');
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Icon + label + colour describing the state of a moment or message, from my point of view.
 *  Colours by kind: texts / voice blue, photos yellow, videos purple. */
/** "1 member" / "{n} members". */
export function membersText(n: number): string {
  return n === 1 ? t('1 member') : t('{n} members', { n });
}

export function momentState(s: ChatMoment): { icon: IconName; label: string; color: string; strong: boolean } {
  if (s.kind === 'system') return { icon: 'information-outline', label: s.text ?? '', color: colors.outline, strong: false };
  if (s.unsent) return { icon: 'undo-variant', label: s.dir === 'out' ? t('You unsent a message') : t('Unsent a message'), color: colors.outline, strong: false };
  if (s.kind === 'text') {
    const preview = (s.text ?? '').replace(/\s+/g, ' ').slice(0, 60);
    if (s.dir === 'in') {
      return s.readAt
        ? { icon: 'message-text-outline', label: preview, color: colors.onSurfaceVariant, strong: false }
        : { icon: 'message-text', label: preview || t('New message'), color: colors.kindText, strong: true };
    }
    return {
      icon: s.status === 'pending' ? 'clock-outline' : s.peerReadAt ? 'check-all' : 'check',
      label: t('You: {text}', { text: preview }), color: colors.kindText, strong: false,
    };
  }
  if (s.kind === 'voice') {
    if (s.dir === 'in') {
      return s.status === 'pending' || !s.readAt
        ? { icon: 'microphone', label: t('New voice message'), color: colors.kindText, strong: true }
        : { icon: 'microphone-outline', label: t('Voice message'), color: colors.onSurfaceVariant, strong: false };
    }
    return { icon: 'microphone-outline', label: s.peerReadAt ? t('Voice message · listened') : t('You: voice message'), color: colors.kindText, strong: false };
  }
  const video = s.mediaType === 'video';
  const accent = video ? colors.kindVideo : colors.kindPhoto;
  if (s.saved && s.file) {
    return { icon: video ? 'play-box-outline' : 'image-outline', label: video ? t('Saved video') : t('Saved photo'), color: accent, strong: false };
  }
  if (s.dir === 'in') {
    switch (s.status) {
      case 'pending':
        return { icon: video ? 'video' : 'image', label: video ? t('New video') : t('New photo'), color: accent, strong: true };
      case 'opened':
        return canReplay(s)
          ? { icon: 'replay', label: t('Opened · 1 more view'), color: accent, strong: false }
          : { icon: 'eye-check-outline', label: t('Opened'), color: colors.onSurfaceVariant, strong: false };
      case 'replayed':
        return { icon: 'replay', label: t('Viewed again'), color: colors.onSurfaceVariant, strong: false };
      case 'expired':
        return { icon: 'timer-sand-empty', label: t('Expired unopened'), color: colors.outline, strong: false };
    }
  }
  switch (s.status) {
    case 'pending':
      return { icon: 'send', label: video ? t('Sent video') : t('Sent photo'), color: accent, strong: false };
    case 'opened': {
      const n = Object.keys(s.openedBy ?? {}).length;
      return { icon: 'eye-check-outline', label: n > 0 ? t('Opened by {n}', { n }) : t('Opened'), color: accent, strong: false };
    }
    case 'replayed':
      return { icon: 'replay', label: t('Opened · viewed again'), color: accent, strong: false };
    case 'expired':
      return { icon: 'timer-sand-empty', label: t('Not opened'), color: colors.outline, strong: false };
  }
}

export const kit = StyleSheet.create({
  iconBtn: {
    width: 40, height: 40, borderRadius: shape.full,
    alignItems: 'center', justifyContent: 'center',
  },
  iconBtnFilled: { backgroundColor: colors.surfaceContainerHigh },
  btn: {
    height: 46, borderRadius: shape.medium, paddingHorizontal: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  btnText: { ...typescale.labelLarge, fontSize: 15 },
  field: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: shape.medium,
    borderWidth: 1, borderColor: colors.outlineVariant,
    paddingHorizontal: 14, paddingTop: 7, paddingBottom: 4,
  },
  fieldFocused: { borderColor: colors.primary },
  fieldLabel: { ...typescale.labelSmall, color: colors.onSurfaceVariant },
  fieldInput: { ...typescale.bodyLarge, color: colors.onSurface, paddingVertical: 4, paddingHorizontal: 0 },
  section: {
    ...typescale.labelMedium, color: colors.onSurfaceVariant,
    textTransform: 'uppercase', letterSpacing: 0.8,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6,
  },
});

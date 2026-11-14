// Material Design 3 Expressive — tonal palette seeded from brand teal (#2DD4BF)

// Themes: "black" (pure black surfaces for AMOLED screens, the default), "dark" (cool dark grey)
// and "light" (white).
// The choice is read synchronously at startup (styles are created when modules load), so a
// change applies after restarting the app.
import * as SecureStore from 'expo-secure-store';

export type ThemeName = 'black' | 'dark' | 'light';
const THEME_KEY = 'mayfly_theme';

function readTheme(): ThemeName {
  try {
    const v = SecureStore.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : 'black';
  } catch {
    return 'black';
  }
}

export const themeName: ThemeName = readTheme();

export function saveThemeName(t: ThemeName) {
  SecureStore.setItem(THEME_KEY, t);
}

const dark = {
  // Primary (teal)
  primary:              '#2DD4BF',
  onPrimary:            '#00201C',
  primaryContainer:     '#00504A',
  onPrimaryContainer:   '#9EF2E4',

  // Secondary (cool neutral)
  secondary:            '#B0CCC6',
  onSecondary:          '#1B3531',
  secondaryContainer:   '#324B47',
  onSecondaryContainer: '#CCE8E2',

  // Tertiary (muted green — group accent)
  tertiary:             '#A8CDA0',
  onTertiary:           '#143017',
  tertiaryContainer:    '#2A4727',
  onTertiaryContainer:  '#C4E9BA',

  // Error
  error:                '#FFB4AB',
  onError:              '#690005',
  errorContainer:       '#93000A',
  onErrorContainer:     '#FFDAD6',

  // Surfaces
  background:                '#0F1413',
  onBackground:              '#DEE4E2',
  surface:                   '#0F1413',
  onSurface:                 '#DEE4E2',
  surfaceVariant:            '#3F4947',
  onSurfaceVariant:          '#BEC9C6',
  surfaceContainer:          '#1B2120',
  surfaceContainerLow:       '#171D1C',
  surfaceContainerHigh:      '#252B2A',
  surfaceContainerHighest:   '#303635',

  // Utility
  outline:         '#899390',
  outlineVariant:  '#3F4947',
  inverseSurface:  '#DEE4E2',
  inverseOnSurface:'#2B3231',
  inversePrimary:  '#006B5F',
  scrim:           '#000000',

  /** Brand teal used as a text / icon colour (darker in the light theme to stay readable). */
  primaryText: '#2DD4BF',

  // Message kinds: texts blue, photos teal, videos purple
  kindText: '#4DA3FF',
  kindPhoto: '#2DD4BF',
  kindVideo: '#B98CFF',
};

const black: typeof dark = {
  ...dark,
  secondary:            '#C9C9C9',
  background:                '#000000',
  onBackground:              '#F2F2F2',
  surface:                   '#000000',
  onSurface:                 '#F2F2F2',
  surfaceVariant:            '#2E2E2E',
  onSurfaceVariant:          '#A6A6A6',
  surfaceContainerLow:       '#080808',
  surfaceContainer:          '#111111',
  surfaceContainerHigh:      '#1B1B1B',
  surfaceContainerHighest:   '#262626',
  outline:         '#737373',
  outlineVariant:  '#262626',
};

const light: typeof dark = {
  ...dark,
  primary:              '#2DD4BF',
  onPrimary:            '#00201C',
  primaryContainer:     '#B2F5EA',
  onPrimaryContainer:   '#00201C',
  secondary:            '#4A635F',
  onSecondary:          '#FFFFFF',
  secondaryContainer:   '#CCE8E2',
  onSecondaryContainer: '#051F1C',
  tertiary:             '#2E6B30',
  onTertiary:           '#FFFFFF',
  tertiaryContainer:    '#C6EBBE',
  onTertiaryContainer:  '#0D2A10',
  error:                '#B3261E',
  onError:              '#FFFFFF',
  errorContainer:       '#F9DEDC',
  onErrorContainer:     '#410E0B',
  background:                '#FFFFFF',
  onBackground:              '#151515',
  surface:                   '#FFFFFF',
  onSurface:                 '#151515',
  surfaceVariant:            '#E4E3DD',
  onSurfaceVariant:          '#5B5A55',
  surfaceContainerLow:       '#F7F7F4',
  surfaceContainer:          '#F1F1ED',
  surfaceContainerHigh:      '#E9E9E4',
  surfaceContainerHighest:   '#DEDED8',
  outline:         '#8B8A84',
  outlineVariant:  '#D9D8D2',
  inverseSurface:  '#2F2F2C',
  inverseOnSurface:'#F2F1EC',
  inversePrimary:  '#2DD4BF',
  scrim:           '#000000',
  primaryText: '#0F766E',
  kindText: '#1A73E8',
  kindPhoto: '#0F766E',
  kindVideo: '#7C3AED',
};

export const colors = themeName === 'dark' ? dark : themeName === 'light' ? light : black;
export const isLightTheme = themeName === 'light';


// Shape corner radii (dp) — Expressive uses large/extra-large shapes
export const shape = {
  none:       0,
  extraSmall: 4,
  small:      8,
  medium:     12,
  large:      16,
  extraLarge: 28,
  full:       9999,
};

// Type scale — weight as TextStyle fontWeight strings
export const typescale = {
  displayLarge:   { fontSize: 57, fontWeight: '400' as const, letterSpacing: -0.25 },
  displayMedium:  { fontSize: 45, fontWeight: '400' as const },
  headlineLarge:  { fontSize: 32, fontWeight: '400' as const },
  headlineMedium: { fontSize: 28, fontWeight: '400' as const },
  headlineSmall:  { fontSize: 24, fontWeight: '400' as const },
  titleLarge:     { fontSize: 22, fontWeight: '400' as const },
  titleMedium:    { fontSize: 16, fontWeight: '500' as const, letterSpacing: 0.15 },
  titleSmall:     { fontSize: 14, fontWeight: '500' as const, letterSpacing: 0.1 },
  bodyLarge:      { fontSize: 16, fontWeight: '400' as const, letterSpacing: 0.5 },
  bodyMedium:     { fontSize: 14, fontWeight: '400' as const, letterSpacing: 0.25 },
  bodySmall:      { fontSize: 12, fontWeight: '400' as const, letterSpacing: 0.4 },
  labelLarge:     { fontSize: 14, fontWeight: '500' as const, letterSpacing: 0.1 },
  labelMedium:    { fontSize: 12, fontWeight: '500' as const, letterSpacing: 0.5 },
  labelSmall:     { fontSize: 11, fontWeight: '500' as const, letterSpacing: 0.5 },
};

// Elevation tint opacities applied on top of surface color
export const elevation = {
  level0: 'transparent',
  level1: 'rgba(45,212,191,0.05)',   // 5%  primary tint
  level2: 'rgba(45,212,191,0.08)',   // 8%
  level3: 'rgba(45,212,191,0.11)',   // 11%
  level4: 'rgba(45,212,191,0.12)',   // 12%
  level5: 'rgba(45,212,191,0.14)',   // 14%
};

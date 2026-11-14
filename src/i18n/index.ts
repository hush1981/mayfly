/**
 * Translations. English text is the key; other languages map it (see de.ts). The language
 * follows the phone unless chosen in the profile; like the theme it is read once at
 * startup (texts in StyleSheets / module constants), so a change applies after a restart.
 *
 *   t('Send to {name}', { name })
 */
import { NativeModules } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import de from './de';

export type Lang = 'en' | 'de';
export type LangSetting = 'system' | Lang;

const KEY = 'mayfly_lang';
const DICTS: Record<Lang, Record<string, string> | null> = { en: null, de };

function systemLang(): Lang {
  let loc = '';
  try { loc = Intl.DateTimeFormat().resolvedOptions().locale ?? ''; } catch (_) {}
  if (!loc) loc = String(NativeModules.I18nManager?.localeIdentifier ?? '');
  return loc.toLowerCase().startsWith('de') ? 'de' : 'en';
}

function readSetting(): LangSetting {
  try {
    const v = SecureStore.getItem(KEY);
    return v === 'en' || v === 'de' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const langSetting: LangSetting = readSetting();
export const lang: Lang = langSetting === 'system' ? systemLang() : langSetting;

export function saveLangSetting(v: LangSetting) {
  SecureStore.setItem(KEY, v);
}

export function t(s: string, vars?: Record<string, string | number>): string {
  let out = DICTS[lang]?.[s] ?? s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

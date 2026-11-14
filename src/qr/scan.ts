/**
 * Offline QR scanning via the native ZXing scanner (android/.../qr/QrScanActivity).
 * No Google Play Services / ML Kit involved.
 */
import { NativeModules } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { showAlert } from '../ui/dialog';
import { t } from '../i18n';

const Native = NativeModules.MayflyQrDecoder as
  | { scan(): Promise<string | null>; decodeFile(uri: string): Promise<string | null> }
  | undefined;

/** Opens the full-screen scanner; resolves with the QR text, or null if cancelled. */
export async function scanQr(): Promise<string | null> {
  if (!Native) throw new Error('QR scanning is not available on this device');
  return Native.scan();
}

/** Decodes a QR code from an image the user picks (e.g. a screenshot a friend sent). */
export async function scanQrFromImage(): Promise<string | null> {
  if (!Native) throw new Error('QR scanning is not available on this device');
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 });
  const uri = res.canceled ? undefined : res.assets[0]?.uri;
  if (!uri) return null;
  const text = await Native.decodeFile(uri);
  if (!text) throw new Error(t('No QR code found in that image.'));
  return text;
}

/** Lets the user choose camera or image, then returns the QR text (null = cancelled). */
export function chooseAndScanQr(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    showAlert(t('Scan code'), undefined, [
      { text: t('Cancel'), style: 'cancel', onPress: () => resolve(null) },
      { text: t('From image'), onPress: () => scanQrFromImage().then(resolve, reject) },
      { text: t('Camera'), onPress: () => scanQr().then(resolve, reject) },
    ], { icon: 'qrcode-scan' });
  });
}

/** Headless JS task started by the native push service when the app is not running. */
import { initServerUrl } from '../api/client';
import { getToken } from '../store/session';
import { flushChatStore } from '../store/chatStore';
import { syncNow } from '../sync/sync';
import { notifyNew } from './notify';

export default async function pushTask(): Promise<void> {
  try {
    await initServerUrl();
    if (!(await getToken())) return;
    const { newIncoming, notices } = await syncNow();
    await flushChatStore();
    await notifyNew(newIncoming, notices);
  } catch (_) {
    // nothing to show
  }
}

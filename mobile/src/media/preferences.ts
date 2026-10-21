import * as SecureStore from 'expo-secure-store';
import { loadDirectConnections } from '../direct-agent/settings';
export type MediaPreferences = { visionId: string; speechId: string };
const key = (profile: string) => 'pia.media.connections.' + profile.replace(/[^a-zA-Z0-9_.-]/g, '_');
export async function loadMediaPreferences(profile: string): Promise<MediaPreferences> {
  const value = await SecureStore.getItemAsync(key(profile));
  try { const p = JSON.parse(value || '{}'); return { visionId: typeof p.visionId === 'string' ? p.visionId : '', speechId: typeof p.speechId === 'string' ? p.speechId : '' }; }
  catch { return { visionId: '', speechId: '' }; }
}
export async function saveMediaPreferences(profile: string, prefs: MediaPreferences) {
  await SecureStore.setItemAsync(key(profile), JSON.stringify(prefs));
}
export async function mediaConnections(profile: string) {
  const [config, prefs] = await Promise.all([loadDirectConnections(profile), loadMediaPreferences(profile)]);
  const pick = (id: string) => config.connections.find(c => c.id === (id || config.activeId));
  const vision = pick(prefs.visionId), speech = pick(prefs.speechId);
  if (!vision || !speech) throw new Error('Подключение для медиа удалено. Выберите его заново в настройках.');
  return { vision, speech };
}

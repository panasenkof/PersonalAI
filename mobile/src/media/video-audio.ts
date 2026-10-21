import { Directory, File, Paths, FileMode } from 'expo-file-system';
import * as Crypto from 'expo-crypto';

export function monoWav(channels: Float32Array[], rate: number): Uint8Array {
  if (!channels.length || !channels[0].length) throw new Error('В видео нет доступной звуковой дорожки.');
  const count = channels[0].length;
  if (count > rate * 600) throw new Error('Для разбора звука выберите видео до 10 минут.');
  const bytes = new Uint8Array(44 + count * 2); const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const sample = Math.max(-1, Math.min(1, channels.reduce((sum, c) => sum + (c[i] || 0), 0) / channels.length));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
export async function videoAudio(uri: string, signal?: AbortSignal): Promise<string> {
  const { decodeAudioData } = require('react-native-audio-api') as typeof import('react-native-audio-api');
  const audio = await decodeAudioData(uri, 16000);
  if (signal?.aborted) throw new Error('Разбор остановлен.');
  const bytes = monoWav(Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)), audio.sampleRate);
  const dir = new Directory(Paths.cache, 'persai-previews'); dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, Crypto.randomUUID() + '.wav'); file.create();
  const handle = file.open(FileMode.WriteOnly);
  try { handle.writeBytes(bytes); } catch (e) { handle.close(); if (file.exists) file.delete(); throw e; }
  finally { try { handle.close(); } catch {} }
  return file.uri;
}

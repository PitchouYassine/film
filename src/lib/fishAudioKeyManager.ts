import {
  FishAudioSettingsSummary,
  FishConnectionStatus,
  FishVoiceModel,
} from '../types/studio';
import { idbGet, idbSet, idbDelete } from './browserStorage';

const FISH_API_BASE = 'https://api.fish.audio';
const STORE_NAME = 'appSettings';
const KEY_NAME = 'fishAudioApiKey';
const META_KEY_NAME = 'fishAudioConnectionMeta';

const LANGUAGE_TO_ISO: Record<string, string> = {
  English: 'en',
  French: 'fr',
  Arabic: 'ar',
  Spanish: 'es',
  German: 'de',
  Portuguese: 'pt',
  Italian: 'it',
  Turkish: 'tr',
  Hindi: 'hi',
};

export interface LocalConnectionMeta {
  connectionStatus: FishConnectionStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export function maskApiKey(rawKey: string): string {
  const trimmed = (rawKey || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return '••••••••';
  const cleanTail = trimmed.slice(-4);
  return `••••••••••••${cleanTail}`;
}

async function isIndexedDbReady(): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') return false;
    await idbGet(STORE_NAME, META_KEY_NAME);
    return true;
  } catch {
    return false;
  }
}

export async function getStoredFishApiKey(): Promise<string> {
  try {
    const entry = await idbGet<string | { key?: string; value?: string }>(STORE_NAME, KEY_NAME);
    if (!entry) return '';
    if (typeof entry === 'string') return entry.trim();
    if (typeof entry === 'object' && typeof entry.value === 'string') return entry.value.trim();
    return '';
  } catch {
    return '';
  }
}

export async function getFishAudioSettingsSummary(): Promise<FishAudioSettingsSummary> {
  const idbAvailable = await isIndexedDbReady();
  const key = idbAvailable ? await getStoredFishApiKey() : '';
  let meta: LocalConnectionMeta | null = null;
  if (idbAvailable) {
    try {
      const rawMeta = await idbGet<LocalConnectionMeta>(STORE_NAME, META_KEY_NAME);
      if (rawMeta && typeof rawMeta === 'object') {
        meta = rawMeta;
      }
    } catch {
      meta = null;
    }
  }

  const isConfigured = Boolean(key);
  let connectionStatus: FishConnectionStatus = meta?.connectionStatus || 'not_connected';
  if (!isConfigured) {
    connectionStatus = 'not_connected';
  }

  return {
    configured: isConfigured,
    source: isConfigured ? 'local_storage' : 'none',
    maskedKey: isConfigured ? maskApiKey(key) : null,
    secureStorageAvailable: idbAvailable,
    secureStorageMode: 'local_indexeddb',
    secureStorageDetail: idbAvailable
      ? 'Stored locally in your browser (IndexedDB). Local IndexedDB storage is unencrypted and is not equivalent to encrypted server-side secret storage. Your key remains on this device and is never sent to any database, analytics service, or third-party storage.'
      : 'Browser IndexedDB storage is unavailable or blocked in this browsing context.',
    connectionStatus,
    lastCheckedAt: meta?.lastCheckedAt || null,
    lastError: isConfigured ? meta?.lastError || null : null,
  };
}

export async function saveStoredFishApiKey(rawKey: string): Promise<FishAudioSettingsSummary> {
  const trimmed = (rawKey || '').trim();
  if (!trimmed || trimmed === 'MY_FISH_API_KEY') {
    throw new Error('Please enter a valid Fish Audio API key.');
  }

  await idbSet(STORE_NAME, KEY_NAME, trimmed);

  const meta: LocalConnectionMeta = {
    connectionStatus: 'not_connected',
    lastCheckedAt: null,
    lastError: null,
  };
  await idbSet(STORE_NAME, META_KEY_NAME, meta);

  return getFishAudioSettingsSummary();
}

export async function deleteStoredFishApiKey(): Promise<FishAudioSettingsSummary> {
  await idbDelete(STORE_NAME, KEY_NAME);
  await idbDelete(STORE_NAME, META_KEY_NAME);
  return getFishAudioSettingsSummary();
}

export async function testFishAudioConnection(candidateKey?: string): Promise<{
  ok: boolean;
  connectionStatus: FishConnectionStatus;
  message: string;
  settings: FishAudioSettingsSummary;
}> {
  const testingUnsaved = Boolean(candidateKey && candidateKey.trim());
  const keyToUse = testingUnsaved ? candidateKey!.trim() : await getStoredFishApiKey();

  if (!keyToUse || keyToUse === 'MY_FISH_API_KEY') {
    if (!testingUnsaved) {
      await idbSet(STORE_NAME, META_KEY_NAME, {
        connectionStatus: 'not_connected',
        lastCheckedAt: new Date().toISOString(),
        lastError: 'No Fish Audio API key configured.',
      }).catch(() => {});
    }
    const settings = await getFishAudioSettingsSummary();
    return {
      ok: false,
      connectionStatus: 'not_connected',
      message: 'No Fish Audio API key is saved yet. Paste your key above and click Save API Key.',
      settings,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    // Official Fish Audio API verification endpoint: GET /wallet/self/api-credit with Authorization: Bearer <key>
    const res = await fetch(`${FISH_API_BASE}/wallet/self/api-credit`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${keyToUse}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { credit?: number | string };
      const creditNote =
        data.credit !== undefined && data.credit !== null ? ` (Credit: ${data.credit})` : '';
      const checkedAt = new Date().toISOString();

      if (!testingUnsaved) {
        await idbSet(STORE_NAME, META_KEY_NAME, {
          connectionStatus: 'connected',
          lastCheckedAt: checkedAt,
          lastError: null,
        }).catch(() => {});
      }

      const settings = await getFishAudioSettingsSummary();
      return {
        ok: true,
        connectionStatus: 'connected',
        message: `Connected successfully to Fish Audio API${creditNote}.`,
        settings,
      };
    }

    if (res.status === 401 || res.status === 403) {
      const message = 'Authentication failed (HTTP 401/403): invalid or expired Fish Audio API key.';
      if (!testingUnsaved) {
        await idbSet(STORE_NAME, META_KEY_NAME, {
          connectionStatus: 'error',
          lastCheckedAt: new Date().toISOString(),
          lastError: message,
        }).catch(() => {});
      }
      const settings = await getFishAudioSettingsSummary();
      return { ok: false, connectionStatus: 'error', message, settings };
    }

    if (res.status === 405) {
      const message =
        'Fish Audio returned HTTP 405 (Method Not Allowed). This does not mean your API key is invalid; check that the request uses GET /wallet/self/api-credit.';
      if (!testingUnsaved) {
        await idbSet(STORE_NAME, META_KEY_NAME, {
          connectionStatus: 'error',
          lastCheckedAt: new Date().toISOString(),
          lastError: message,
        }).catch(() => {});
      }
      const settings = await getFishAudioSettingsSummary();
      return { ok: false, connectionStatus: 'error', message, settings };
    }

    const rawText = await res.text().catch(() => '');
    const message = `Fish Audio API error (${res.status}): ${rawText.slice(0, 150) || 'Unknown error'}`;
    if (!testingUnsaved) {
      await idbSet(STORE_NAME, META_KEY_NAME, {
        connectionStatus: 'error',
        lastCheckedAt: new Date().toISOString(),
        lastError: message,
      }).catch(() => {});
    }
    const settings = await getFishAudioSettingsSummary();
    return { ok: false, connectionStatus: 'error', message, settings };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = (err as Error)?.name === 'AbortError';
    const message = isTimeout
      ? 'Connection timed out after 12s while reaching api.fish.audio.'
      : err instanceof Error
      ? err.message
      : 'Network error connecting to Fish Audio API.';

    if (!testingUnsaved) {
      await idbSet(STORE_NAME, META_KEY_NAME, {
        connectionStatus: 'error',
        lastCheckedAt: new Date().toISOString(),
        lastError: message,
      }).catch(() => {});
    }
    const settings = await getFishAudioSettingsSummary();
    return { ok: false, connectionStatus: 'error', message, settings };
  }
}

export async function fetchFishVoicesFromBrowser(
  apiKey: string,
  params?: { query?: string; selfOnly?: boolean; language?: string; pageSize?: number }
): Promise<{ voices: FishVoiceModel[]; total: number }> {
  const qs = new URLSearchParams();
  qs.set('page_size', String(params?.pageSize || 24));
  qs.set('sort_by', 'task_count');
  if (params?.selfOnly) qs.set('self', 'true');
  if (params?.query?.trim()) qs.set('title', params.query.trim());
  if (params?.language && LANGUAGE_TO_ISO[params.language]) {
    qs.set('language', LANGUAGE_TO_ISO[params.language]);
  }

  const res = await fetch(`${FISH_API_BASE}/model?${qs.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let msg = `Fish Audio API error (${res.status})`;
    try {
      const parsed = JSON.parse(raw) as { message?: string; detail?: string; error?: string };
      msg = parsed.message || parsed.detail || parsed.error || msg;
    } catch {
      if (raw.trim()) msg = `${msg}: ${raw.trim().slice(0, 180)}`;
    }
    throw new Error(msg);
  }

  const payload = (await res.json()) as {
    total?: number;
    items?: Array<{
      _id?: string;
      id?: string;
      title?: string;
      description?: string;
      languages?: string[];
      tags?: string[];
      visibility?: string;
      cover_image?: string;
      author?: { nickname?: string; name?: string };
    }>;
  };

  const voices: FishVoiceModel[] = (payload.items || [])
    .map((item) => ({
      id: item._id || item.id || '',
      title: item.title || 'Untitled Voice',
      description: item.description || '',
      languages: Array.isArray(item.languages) ? item.languages : [],
      author: item.author?.nickname || item.author?.name || 'Fish Audio',
      tags: Array.isArray(item.tags) ? item.tags : [],
      visibility: item.visibility,
      coverImage: item.cover_image,
    }))
    .filter((v) => Boolean(v.id));

  return {
    voices,
    total: Number(payload.total || voices.length),
  };
}

export async function validateFishVoiceInBrowser(
  apiKey: string | null | undefined,
  voiceId: string
): Promise<{
  valid: boolean;
  checked: boolean;
  voiceId: string;
  title?: string;
  description?: string;
  languages?: string[];
  message: string;
}> {
  const cleanId = voiceId.trim();
  if (!cleanId) throw new Error('Fish Audio Voice ID cannot be empty.');
  if (/\s/.test(cleanId)) throw new Error('Fish Audio Voice ID cannot contain spaces.');
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(cleanId)) {
    throw new Error(
      `Invalid Fish Audio Voice ID format "${cleanId}". Enter the exact alphanumeric model/reference ID from Fish Audio.`
    );
  }

  const key = (apiKey || '').trim();
  if (!key) {
    return {
      valid: true,
      checked: false,
      voiceId: cleanId,
      message: 'Fish Audio API key is not configured yet; Voice ID saved unverified.',
    };
  }

  const res = await fetch(`${FISH_API_BASE}/model/${encodeURIComponent(cleanId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
    },
  });

  if (res.status === 404 || res.status === 400 || res.status === 422) {
    throw new Error(
      `Invalid Fish Audio Voice ID "${cleanId}": no matching voice model was found on Fish Audio.`
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'Authentication failed while verifying Fish Audio Voice ID. Check your API key in Settings.'
    );
  }
  if (!res.ok) {
    throw new Error(`Fish Audio voice validation failed (HTTP ${res.status}).`);
  }

  const data = (await res.json().catch(() => ({}))) as {
    _id?: string;
    id?: string;
    title?: string;
    description?: string;
    languages?: string[];
  };

  return {
    valid: true,
    checked: true,
    voiceId: data._id || data.id || cleanId,
    title: data.title,
    description: data.description,
    languages: Array.isArray(data.languages) ? data.languages : undefined,
    message: data.title ? `Verified Fish Audio voice "${data.title}".` : 'Verified Fish Audio Voice ID.',
  };
}

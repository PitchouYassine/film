import {
  CaptionSegment,
  CloudAssetKind,
  DefaultStudioPreferences,
  FilmstripFrame,
  FishAudioSettingsSummary,
  FishConnectionStatus,
  FishVoiceModel,
  GeminiVoiceName,
  PresetCategory,
  Project,
  ProjectAudioWaveforms,
  RenderJob,
  SavedFishVoice,
  SavedFontAsset,
  StyleApplyScope,
  StyleMissingVoiceWarning,
  StudioPreset,
  StudioPresetAssetRef,
  SupportedLanguage,
  SyncMode,
  SystemStatus,
  VideoMetadata,
} from '../types/studio';
import type { FontCatalogItem } from './fontCatalog';
import { indexedDbStore } from './indexedDbStore';
import {
  compressVideoInBrowser,
  createSampleVideoInBrowser,
  detectOriginalCaptionsInBrowser,
  extractAudioTrackInBrowser,
  extractProjectWaveformsInBrowser,
  extractTimelineFilmstripInBrowser,
  generateThumbnailsInBrowser,
  probeVideoInBrowser,
  resolveMediaBlob,
  trimAndMergeDubClipsInBrowser,
} from './clientMediaEngine';
import { renderProjectExportInBrowser } from './clientExportRenderer';

export interface LocalAssetManifestItem {
  localUrl: string;
  bucket: string;
  filename: string;
  assetKind: CloudAssetKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  exists: boolean;
  exceedsFree50MbCap: boolean;
  necessaryForCloudSync: boolean;
}

export const API_BASE_URL = (
  (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE_URL) ||
  (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_BACKEND_URL) ||
  (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_APP_URL) ||
  ''
).replace(/\/+$/, '');

export function resolveApiUrl(path: string): string {
  if (!path) return '';
  if (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('blob:') ||
    path.startsWith('data:')
  ) {
    return path;
  }
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${cleanPath}` : cleanPath;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const fullUrl = resolveApiUrl(url);
  const res = await fetch(fullUrl, init);
  const raw = await res.text();
  let data: Record<string, unknown> | null = null;
  if (raw) {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    let errMsg = typeof data?.error === 'string' ? data.error : '';
    if (!errMsg) {
      if (res.status === 405) {
        errMsg = `Request failed (405 Method Not Allowed): Static hosting rejected ${
          init?.method || 'POST'
        } request to ${url}. Ensure Cloudflare Pages Functions are deployed.`;
      } else {
        errMsg = `Request failed (${res.status})`;
      }
    }
    throw new Error(errMsg);
  }
  if (!data) {
    throw new Error('Server returned an unexpected non-JSON response. Please try again.');
  }
  return data as T;
}

let cachedSystemStatus: SystemStatus | null = null;
let statusInflight: Promise<SystemStatus> | null = null;

async function getCapabilities(): Promise<SystemStatus> {
  if (cachedSystemStatus) return cachedSystemStatus;
  if (!statusInflight) {
    statusInflight = request<SystemStatus>('/api/system/status')
      .then((s) => {
        cachedSystemStatus = s;
        return s;
      })
      .finally(() => {
        statusInflight = null;
      });
  }
  return statusInflight;
}

async function shouldUseBrowserMedia(): Promise<boolean> {
  try {
    const caps = await getCapabilities();
    return caps.runtime === 'cloudflare-pages' || !caps.ffmpegAvailable;
  } catch {
    return false;
  }
}

const clientJobsMap = new Map<string, RenderJob>();

function makeClientJob(params: {
  projectId: string;
  type: RenderJob['type'];
  stage: string;
  progress?: number;
}): RenderJob {
  const now = new Date().toISOString();
  const job: RenderJob = {
    id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: params.projectId,
    type: params.type,
    status: 'processing',
    progress: params.progress ?? 4,
    stage: params.stage,
    etaSeconds: null,
    outputUrl: null,
    outputSize: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  clientJobsMap.set(job.id, job);
  void request('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  }).catch(() => {});
  return { ...job };
}

function patchClientJob(jobId: string, patch: Partial<RenderJob>, syncD1 = false): RenderJob | null {
  const existing = clientJobsMap.get(jobId);
  if (!existing) return null;
  const next: RenderJob = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  clientJobsMap.set(jobId, next);
  if (syncD1 || next.status !== 'processing') {
    void request(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }
  return next;
}

async function storeAssetBlobHybrid(params: {
  projectId: string | null;
  bucket: string;
  kind: string;
  filename: string;
  blob: Blob;
  forceLocalOnly?: boolean;
}): Promise<{ url: string; storedIn: 'r2' | 'd1' | 'client-only' }> {
  const caps = await getCapabilities().catch(() => null);
  const canTryServer = !params.forceLocalOnly && (Boolean(caps?.r2Available) || params.blob.size <= 650_000);
  const fallbackUrl = `/media/${params.bucket}/${params.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  if (canTryServer) {
    try {
      const fd = new FormData();
      fd.append('file', params.blob, params.filename);
      if (params.projectId) fd.append('projectId', params.projectId);
      fd.append('bucket', params.bucket);
      fd.append('kind', params.kind);
      fd.append('filename', params.filename);
      const res = await request<{ url: string; storedIn: 'r2' | 'd1' | 'client-only' }>(
        '/api/assets/upload',
        { method: 'POST', body: fd }
      );
      await indexedDbStore.cacheMediaByUrl(res.url, params.blob, params.filename, params.blob.type);
      return { url: res.url, storedIn: res.storedIn };
    } catch {
      // Fallback safely to IndexedDB URL cache
    }
  }

  await indexedDbStore.cacheMediaByUrl(fallbackUrl, params.blob, params.filename, params.blob.type);
  return { url: fallbackUrl, storedIn: 'client-only' };
}

function decodeBase64ToBlob(b64: string, mimeType = 'audio/mpeg'): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export interface PresetApplyOptions {
  captionPresetId?: string | null;
  filterPresetId?: string | null;
  editingPresetId?: string | null;
  styleId?: string | null;
  applyDefaults?: boolean;
  applyDefaultStyle?: boolean;
}

export interface PresetWarning {
  presetName: string;
  missingAssets: StudioPresetAssetRef[];
}

export const api = {
  getSystemStatus: async () => {
    const s = await request<SystemStatus>('/api/system/status');
    cachedSystemStatus = s;
    return s;
  },

  getFishAudioSettings: () =>
    request<FishAudioSettingsSummary>('/api/settings/fish-audio'),

  saveFishApiKey: (apiKey: string) =>
    request<FishAudioSettingsSummary>('/api/settings/fish-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    }),

  testFishAudioConnection: (apiKey?: string) =>
    request<{
      ok: boolean;
      connectionStatus: FishConnectionStatus;
      message: string;
      settings: FishAudioSettingsSummary;
    }>('/api/settings/fish-api-key/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }),

  deleteFishApiKey: () =>
    request<FishAudioSettingsSummary>('/api/settings/fish-api-key', {
      method: 'DELETE',
    }),

  getDefaultPreferences: () =>
    request<{ preferences: DefaultStudioPreferences; defaultStyle: StudioPreset | null }>(
      '/api/settings/preferences'
    ),

  updateDefaultPreferences: (patch: Partial<DefaultStudioPreferences>) =>
    request<{ preferences: DefaultStudioPreferences; defaultStyle: StudioPreset | null }>(
      '/api/settings/preferences',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }
    ),

  getSupabaseSchema: () => request<{ sql: string }>('/api/system/supabase-schema'),

  getLocalStorageUsage: async () => {
    const remote = await request<{
      totalBytes: number;
      buckets: Record<string, { bytes: number; files: number }>;
    }>('/api/system/storage-usage');
    if (await shouldUseBrowserMedia()) {
      const local = await indexedDbStore.getCachedMediaUsage();
      const mergedBuckets: Record<string, { bytes: number; files: number }> = { ...remote.buckets };
      for (const [b, info] of Object.entries(local.buckets)) {
        const cur = mergedBuckets[b] || { bytes: 0, files: 0 };
        mergedBuckets[b] = {
          bytes: Math.max(cur.bytes, info.bytes),
          files: Math.max(cur.files, info.files),
        };
      }
      return {
        totalBytes: Object.values(mergedBuckets).reduce((acc, x) => acc + x.bytes, 0),
        buckets: mergedBuckets,
      };
    }
    return remote;
  },

  runCleanup: async () => {
    const res = await request<{ removedFiles?: number; cleanedFiles?: number }>(
      '/api/system/cleanup',
      { method: 'POST' }
    );
    return { removedFiles: res.removedFiles ?? res.cleanedFiles ?? 0 };
  },

  getProjectAssetManifest: async (projectId: string) => {
    const res = await request<{
      assets: LocalAssetManifestItem[];
      totalBytes: number;
      necessaryBytes: number;
      oversizedCount: number;
    }>(`/api/projects/${projectId}/asset-manifest`);
    if (await shouldUseBrowserMedia()) {
      let total = 0;
      const enriched = await Promise.all(
        (res.assets || []).map(async (item) => {
          const cached = await indexedDbStore.getCachedMediaByUrl(item.localUrl);
          const sizeBytes = item.sizeBytes || cached?.sizeBytes || 0;
          total += sizeBytes;
          return {
            ...item,
            exists: item.exists || Boolean(cached),
            sizeBytes,
            exceedsFree50MbCap: sizeBytes > 50 * 1024 * 1024,
          };
        })
      );
      return {
        assets: enriched,
        totalBytes: total,
        necessaryBytes: total,
        oversizedCount: enriched.filter((a) => a.exceedsFree50MbCap).length,
      };
    }
    return res;
  },

  compressProjectVideo: async (
    projectId: string,
    preset: 'under-45mb' | '720p-compact' | '480p-compact',
    target: 'source' | 'final-export' = 'source'
  ) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      const res = await compressVideoInBrowser(project, preset, target, resolveApiUrl);
      const bucket = target === 'final-export' ? 'exports' : 'uploads';
      const stored = await storeAssetBlobHybrid({
        projectId,
        bucket,
        kind: target === 'final-export' ? 'export' : 'video',
        filename: `${projectId.slice(0, 8)}_${Date.now()}_${res.filename}`,
        blob: res.blob,
      });
      const patch: Partial<Project> =
        target === 'final-export'
          ? {
              lastExportUrl: stored.url,
              lastExportSize: res.compressedBytes,
              lastExportedAt: new Date().toISOString(),
            }
          : {
              sourceVideoUrl: stored.url,
              sourceFilename: res.filename,
              metadata: res.metadata,
            };
      const updated = await api.updateProject(projectId, patch);
      return {
        project: updated.project,
        compressedUrl: stored.url,
        filename: res.filename,
        originalSourceUrl: res.originalUrl,
        originalBytes: res.originalBytes,
        compressedBytes: res.compressedBytes,
        metadata: res.metadata,
        target,
      };
    }

    return request<{
      project: Project;
      compressedUrl: string;
      filename: string;
      originalSourceUrl: string;
      originalBytes: number;
      compressedBytes: number;
      metadata: VideoMetadata;
      target: 'source' | 'final-export';
    }>(`/api/projects/${projectId}/compress-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset, target }),
    });
  },

  saveProjectThumbnail: async (
    projectId: string,
    params: {
      blob: Blob;
      label: string;
      width: number;
      height: number;
      format: 'png' | 'jpg';
      setAsCover?: boolean;
    }
  ) => {
    const fd = new FormData();
    fd.append('file', params.blob, `thumb.${params.format}`);
    fd.append('label', params.label);
    fd.append('width', String(params.width));
    fd.append('height', String(params.height));
    fd.append('format', params.format);
    fd.append('setAsCover', params.setAsCover ? 'true' : 'false');
    const res = await request<{
      thumbnail: {
        id: string;
        url: string;
        label: string;
        width: number;
        height: number;
        format: 'png' | 'jpg';
        createdAt: string;
      };
      project: Project;
    }>(`/api/projects/${projectId}/thumbnails/save`, {
      method: 'POST',
      body: fd,
    });
    if (res.thumbnail?.url) {
      await indexedDbStore.cacheMediaByUrl(
        res.thumbnail.url,
        params.blob,
        `thumb.${params.format}`,
        params.blob.type
      );
    }
    return res;
  },

  upsertProjectFromCloud: (project: Project) =>
    request<{ project: Project }>('/api/projects/upsert-from-cloud', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project }),
    }),

  detectOriginalCaptions: async (projectId: string) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      const detected = await detectOriginalCaptionsInBrowser(project, resolveApiUrl);
      const updated = await api.updateProject(projectId, {
        subtitleRemoval: detected.subtitleRemoval,
        blurs: detected.blurs,
      });
      return {
        project: updated.project,
        detections: detected.detections,
        ocrAvailable: detected.ocrAvailable,
        method: detected.method,
        analysisMessage: detected.analysisMessage,
        framesAnalyzed: detected.framesAnalyzed,
      };
    }

    return request<{
      project: Project;
      detections: NonNullable<Project['subtitleRemoval']>['detections'];
      ocrAvailable: boolean;
      method: 'hybrid' | 'ocr' | 'visual' | 'unavailable';
      analysisMessage: string;
      framesAnalyzed: number;
    }>(`/api/projects/${projectId}/blurs/detect-captions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  },

  hydrateAssetFromBlob: async (
    projectId: string,
    params: {
      blob: Blob;
      bucket: string;
      filename: string;
      assetKind: CloudAssetKind;
      mimeType: string;
      targetLocalUrl?: string;
    }
  ) => {
    if (await shouldUseBrowserMedia()) {
      const targetUrl =
        params.targetLocalUrl || `/media/${params.bucket}/${params.filename}`;
      await indexedDbStore.cacheMediaByUrl(targetUrl, params.blob, params.filename, params.mimeType);
      return {
        localUrl: targetUrl,
        filePath: targetUrl,
        sizeBytes: params.blob.size,
      };
    }
    const fd = new FormData();
    fd.append('file', params.blob, params.filename);
    fd.append('bucket', params.bucket);
    fd.append('filename', params.filename);
    fd.append('assetKind', params.assetKind);
    fd.append('mimeType', params.mimeType);
    if (params.targetLocalUrl) fd.append('targetLocalUrl', params.targetLocalUrl);
    return request<{ localUrl: string; filePath: string; sizeBytes: number }>(
      `/api/projects/${projectId}/hydrate-asset`,
      {
        method: 'POST',
        body: fd,
      }
    );
  },

  listFishVoices: (params?: { query?: string; selfOnly?: boolean; language?: string }) => {
    const qs = new URLSearchParams();
    if (params?.query) qs.set('q', params.query);
    if (params?.selfOnly) qs.set('self', 'true');
    if (params?.language) qs.set('language', params.language);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ voices: FishVoiceModel[]; total: number }>(`/api/fish/voices${suffix}`);
  },

  listSavedFishVoices: () =>
    request<{ voices: SavedFishVoice[] }>('/api/fish/saved-voices'),

  validateSavedFishVoice: (voiceId: string) =>
    request<{
      valid: boolean;
      checked: boolean;
      voiceId: string;
      title?: string;
      description?: string;
      languages?: string[];
      message: string;
    }>('/api/fish/saved-voices/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voiceId }),
    }),

  previewSavedFishVoice: (params: { voiceId?: string; text?: string }) =>
    request<{ audioUrl: string }>('/api/fish/saved-voices/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  createSavedFishVoice: (params: {
    name: string;
    voiceId: string;
    description?: string;
    language?: string;
    sampleUrl?: string;
    previewText?: string;
    isDefault?: boolean;
    skipRemoteValidation?: boolean;
  }) =>
    request<{ voice: SavedFishVoice; voices: SavedFishVoice[]; validationMessage?: string }>(
      '/api/fish/saved-voices',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }
    ),

  rebuildFishDubTrack: async (
    projectId: string,
    params?: { generatedClips?: Project['voice']['generatedClips'] }
  ) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      const clips = params?.generatedClips ?? project.voice.generatedClips ?? [];
      if (clips.length === 0) {
        const res = await request<{
          project: Project;
          fullDubUrl: string;
          clips: Project['voice']['generatedClips'];
        }>(`/api/projects/${projectId}/dubbing/rebuild-track`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ generatedClips: [], fullDubUrl: '' }),
        });
        return res;
      }

      const loadedClips = await Promise.all(
        clips.map(async (c) => ({
          segmentId: c.segmentId,
          start: c.start,
          end: c.end,
          audioUrl: c.audioUrl,
          blob: await resolveMediaBlob(c.audioUrl, resolveApiUrl),
          text: c.text,
          speaker: c.speaker,
          speed: c.speed,
        }))
      );
      const merged = await trimAndMergeDubClipsInBrowser({
        captions: project.captions,
        clips: loadedClips,
        syncMode: project.voice.syncMode,
        continuousPauseMs: project.voice.continuousPauseMs,
        originalDuration: project.metadata?.duration || 15,
      });
      const storedDub = await storeAssetBlobHybrid({
        projectId,
        bucket: 'audio',
        kind: 'voice',
        filename: `fish_dub_rebuilt_${projectId.slice(0, 8)}_${Date.now()}.mp3`,
        blob: merged.fullDubBlob,
      });
      return request<{
        project: Project;
        fullDubUrl: string;
        clips: Project['voice']['generatedClips'];
      }>(`/api/projects/${projectId}/dubbing/rebuild-track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generatedClips: merged.generatedClips,
          fullDubUrl: storedDub.url,
          syncPlan: merged.syncPlan,
        }),
      });
    }

    return request<{
      project: Project;
      fullDubUrl: string;
      clips: Project['voice']['generatedClips'];
    }>(`/api/projects/${projectId}/dubbing/rebuild-track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
  },

  updateSavedFishVoice: (
    id: string,
    params: {
      name?: string;
      voiceId?: string;
      description?: string;
      language?: string;
      sampleUrl?: string;
      previewText?: string;
      isDefault?: boolean;
      skipRemoteValidation?: boolean;
    }
  ) =>
    request<{ voice: SavedFishVoice; voices: SavedFishVoice[] }>(`/api/fish/saved-voices/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  duplicateSavedFishVoice: (id: string) =>
    request<{ voice: SavedFishVoice; voices: SavedFishVoice[] }>(
      `/api/fish/saved-voices/${id}/duplicate`,
      { method: 'POST' }
    ),

  deleteSavedFishVoice: (id: string) =>
    request<{ deleted: boolean; voices: SavedFishVoice[] }>(`/api/fish/saved-voices/${id}`, {
      method: 'DELETE',
    }),

  listCustomFonts: () => request<{ fonts: SavedFontAsset[] }>('/api/fonts'),

  getFontCatalog: () =>
    request<{ builtin: FontCatalogItem[]; custom: SavedFontAsset[] }>('/api/fonts/catalog'),

  ensureFont: (family: string, weight = 700, italic = false) =>
    request<{
      available: boolean;
      family: string;
      resolvedWeight: number;
      italic: boolean;
      url?: string;
      source?: 'builtin' | 'custom' | 'system';
      exportCompatible?: boolean;
      error?: string;
    }>(
      `/api/fonts/ensure?family=${encodeURIComponent(family)}&weight=${weight}&italic=${italic ? '1' : '0'}`
    ),

  uploadCustomFont: async (file: File, family?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (family) fd.append('family', family);
    const res = await request<{ font: SavedFontAsset; fonts: SavedFontAsset[]; exportCompatible?: boolean }>(
      '/api/fonts',
      {
        method: 'POST',
        body: fd,
      }
    );
    if (res.font?.url) {
      await indexedDbStore.cacheMediaByUrl(res.font.url, file, file.name, file.type);
    }
    return res;
  },

  deleteCustomFont: (id: string) =>
    request<{ deleted: boolean; fonts: SavedFontAsset[] }>(`/api/fonts/${id}`, {
      method: 'DELETE',
    }),

  listPresets: (category?: PresetCategory) =>
    request<{ presets: StudioPreset[] }>(
      category ? `/api/presets?category=${encodeURIComponent(category)}` : '/api/presets'
    ),

  createPreset: (params: {
    category: PresetCategory;
    name: string;
    description?: string;
    isDefault?: boolean;
    thumbnailStyle?: StudioPreset['thumbnailStyle'];
    payload: Record<string, unknown>;
    assetRefs?: StudioPresetAssetRef[];
  }) =>
    request<{ preset: StudioPreset; presets: StudioPreset[] }>('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  updatePreset: (
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      isDefault: boolean;
      thumbnailStyle: StudioPreset['thumbnailStyle'];
      payload: Record<string, unknown>;
      assetRefs: StudioPresetAssetRef[];
    }>
  ) =>
    request<{ preset: StudioPreset; presets: StudioPreset[] }>(`/api/presets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deletePreset: (id: string) =>
    request<{ deleted: boolean; presets: StudioPreset[] }>(`/api/presets/${id}`, {
      method: 'DELETE',
    }),

  importPresets: (bundle: unknown) =>
    request<{ importedCount: number; imported: StudioPreset[]; presets: StudioPreset[] }>(
      '/api/presets/import',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
      }
    ),

  exportPresetsUrl: '/api/presets/export',

  listStyles: () =>
    request<{ styles: StudioPreset[]; defaultStyleId: string | null }>('/api/styles'),

  createStyle: (params: {
    name: string;
    description?: string;
    isDefault?: boolean;
    projectId?: string;
    thumbnailDataUrl?: string;
    thumbnailImageUrl?: string;
    thumbnailStyle?: StudioPreset['thumbnailStyle'];
    payload?: Record<string, unknown>;
    assetRefs?: StudioPresetAssetRef[];
  }) =>
    request<{ style: StudioPreset; styles: StudioPreset[] }>('/api/styles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  updateStyle: (
    id: string,
    patch: Partial<{
      name: string;
      description: string;
      isDefault: boolean;
      fromProjectId: string;
      thumbnailDataUrl: string;
      thumbnailImageUrl: string;
      thumbnailStyle: StudioPreset['thumbnailStyle'];
      payload: Record<string, unknown>;
      assetRefs: StudioPresetAssetRef[];
    }>
  ) =>
    request<{ style: StudioPreset; styles: StudioPreset[] }>(`/api/styles/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  duplicateStyle: (id: string) =>
    request<{ style: StudioPreset; styles: StudioPreset[] }>(`/api/styles/${id}/duplicate`, {
      method: 'POST',
    }),

  deleteStyle: (id: string) =>
    request<{ deleted: boolean; styles: StudioPreset[] }>(`/api/styles/${id}`, {
      method: 'DELETE',
    }),

  applyStyleToProject: (projectId: string, styleId: string, scope: StyleApplyScope = 'all') =>
    request<{
      project: Project;
      warnings: PresetWarning[];
      voiceMissingWarning: StyleMissingVoiceWarning | null;
    }>(`/api/projects/${projectId}/apply-style`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ styleId, scope }),
    }),

  listProjects: () => request<{ projects: Project[] }>('/api/projects'),

  createProject: (name: string, presetOpts?: PresetApplyOptions) =>
    request<{
      project: Project;
      presetWarnings?: PresetWarning[];
      voiceMissingWarning?: StyleMissingVoiceWarning | null;
    }>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...(presetOpts || {}) }),
    }),

  applyPresetsToProject: (projectId: string, presetOpts: PresetApplyOptions) =>
    request<{ project: Project; presetWarnings?: PresetWarning[] }>(
      `/api/projects/${projectId}/apply-presets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(presetOpts),
      }
    ),

  getProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}`),

  updateProject: (id: string, patch: Partial<Project>) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  deleteProject: (id: string) =>
    request<{ deleted: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  createSampleVideo: async (projectId: string) => {
    if (await shouldUseBrowserMedia()) {
      const sample = await createSampleVideoInBrowser();
      const storedVideo = await storeAssetBlobHybrid({
        projectId,
        bucket: 'uploads',
        kind: 'video',
        filename: `${projectId.slice(0, 8)}_${Date.now()}_${sample.filename}`,
        blob: sample.blob,
      });
      let thumbnailUrl: string | null = sample.thumbnailDataUrl;
      if (sample.thumbnailDataUrl) {
        try {
          const thumbBlob = await (await fetch(sample.thumbnailDataUrl)).blob();
          const storedThumb = await storeAssetBlobHybrid({
            projectId,
            bucket: 'thumbs',
            kind: 'thumbnail',
            filename: `thumb_${projectId.slice(0, 8)}_${Date.now()}.jpg`,
            blob: thumbBlob,
          });
          thumbnailUrl = storedThumb.url;
        } catch {
          // keep data URL thumbnail
        }
      }
      const dur = Math.max(0.5, sample.metadata.duration || 8);
      return api.updateProject(projectId, {
        sourceVideoUrl: storedVideo.url,
        sourceFilename: sample.filename,
        thumbnailUrl,
        metadata: sample.metadata,
        waveformPeaks: sample.waveformPeaks,
        videoClips: [
          {
            id: 'vclip_main',
            label: sample.filename,
            sourceStart: 0,
            sourceEnd: dur,
            timelineStart: 0,
            speed: 1.0,
            audioUnlinked: false,
          },
        ],
        originalAudioClips: [],
      });
    }

    return request<{ project: Project }>(`/api/projects/${projectId}/sample-video`, {
      method: 'POST',
    });
  },

  uploadLogo: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await request<{ project: Project; logo?: { url: string } }>(
      `/api/projects/${projectId}/logo`,
      {
        method: 'POST',
        body: fd,
      }
    );
    const latestUrl = res.logo?.url || res.project?.logos?.[res.project.logos.length - 1]?.url;
    if (latestUrl) {
      await indexedDbStore.cacheMediaByUrl(latestUrl, file, file.name, file.type);
    }
    return { project: res.project };
  },

  uploadCanvasBackground: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await request<{ project: Project; url: string; filename: string }>(
      `/api/projects/${projectId}/canvas-bg`,
      {
        method: 'POST',
        body: fd,
      }
    );
    if (res.url) {
      await indexedDbStore.cacheMediaByUrl(res.url, file, res.filename || file.name, file.type);
    }
    return res;
  },

  uploadMusic: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await request<{ project: Project }>(`/api/projects/${projectId}/music`, {
      method: 'POST',
      body: fd,
    });
    if (res.project?.voice?.bgMusicUrl) {
      await indexedDbStore.cacheMediaByUrl(res.project.voice.bgMusicUrl, file, file.name, file.type);
    }
    return res;
  },

  uploadSfx: async (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await request<{ project: Project }>(`/api/projects/${projectId}/sfx`, {
      method: 'POST',
      body: fd,
    });
    if (res.project?.voice?.sfxUrl) {
      await indexedDbStore.cacheMediaByUrl(res.project.voice.sfxUrl, file, file.name, file.type);
    }
    return res;
  },

  uploadMask: (projectId: string, blurId: string, maskBase64: string) =>
    request<{ maskUrl: string; assetId: string }>(`/api/projects/${projectId}/mask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blurId, maskBase64 }),
    }),

  extractAudio: async (projectId: string) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      const extracted = await extractAudioTrackInBrowser(
        project,
        { format: 'mp3', bitrate: '192k' },
        resolveApiUrl
      );
      const stored = await storeAssetBlobHybrid({
        projectId,
        bucket: 'audio',
        kind: 'audio',
        filename: `${projectId.slice(0, 8)}_extracted_${Date.now()}.mp3`,
        blob: extracted.blob,
      });
      return {
        audioUrl: stored.url,
        downloadUrl: stored.url,
        filename: extracted.filename,
      };
    }

    return request<{ audioUrl: string; downloadUrl: string; filename: string }>(
      `/api/projects/${projectId}/audio/extract`,
      { method: 'POST' }
    );
  },

  transcribe: async (projectId: string, params?: { provider?: 'fish' | 'gemini'; sourceLanguage?: string }) => {
    if (await shouldUseBrowserMedia()) {
      return api.transcribeWithFish(projectId, params?.sourceLanguage);
    }
    return request<{ project: Project; detectedLanguage: string; segmentCount: number }>(
      `/api/projects/${projectId}/transcribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      }
    );
  },

  transcribeWithFish: async (projectId: string, sourceLanguage?: string) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      const extracted = await extractAudioTrackInBrowser(
        project,
        { format: 'mp3', mono: true, sampleRate: 16000, bitrate: '48k' },
        resolveApiUrl
      );
      const fd = new FormData();
      fd.append('audio', extracted.blob, 'speech_track.mp3');
      if (sourceLanguage) fd.append('sourceLanguage', sourceLanguage);
      fd.append('duration', String(extracted.durationSec));
      return request<{ project: Project; detectedLanguage: string; segmentCount: number }>(
        `/api/projects/${projectId}/dubbing/transcribe`,
        {
          method: 'POST',
          body: fd,
        }
      );
    }

    return request<{ project: Project; detectedLanguage: string; segmentCount: number }>(
      `/api/projects/${projectId}/dubbing/transcribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceLanguage }),
      }
    );
  },

  importCaptions: (projectId: string, content: string) =>
    request<{ project: Project; count: number }>(`/api/projects/${projectId}/captions/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),

  translate: (
    projectId: string,
    targetLanguage: SupportedLanguage,
    preserveProperNouns: boolean
  ) =>
    request<{ project: Project }>(`/api/projects/${projectId}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLanguage, preserveProperNouns }),
    }),

  previewFishDub: (
    projectId: string,
    params: { text: string; referenceId?: string; speakingSpeed: number }
  ) =>
    request<{ audioUrl: string }>(`/api/projects/${projectId}/dubbing/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  generateFishDub: async (
    projectId: string,
    params: { voice: Project['voice']; captions?: CaptionSegment[]; useTranslated?: boolean }
  ) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      const sourceCaptions =
        params.captions && params.captions.length > 0 ? params.captions : project.captions;
      if (!sourceCaptions || sourceCaptions.length === 0) {
        throw new Error('No caption segments available to generate Fish Audio dubbing.');
      }
      const useTranslated = params.useTranslated !== false;
      const job = makeClientJob({
        projectId,
        type: 'voice',
        stage: `Synthesizing ${sourceCaptions.length} segments with Fish Audio...`,
        progress: 5,
      });

      void (async () => {
        try {
          const synthClips: Array<{
            segmentId: string;
            start: number;
            end: number;
            audioUrl: string;
            blob: Blob;
            text: string;
            speaker?: string;
            speed: number;
          }> = [];

          for (let i = 0; i < sourceCaptions.length; i++) {
            const seg = sourceCaptions[i];
            const spokenText = (useTranslated ? seg.translatedText || seg.text : seg.text).trim();
            if (!spokenText) continue;

            const pct = Math.min(64, Math.round(6 + ((i + 1) / sourceCaptions.length) * 56));
            patchClientJob(job.id, {
              progress: pct,
              stage: `Synthesizing segment ${i + 1} of ${sourceCaptions.length} via Fish Audio`,
            });

            const segRes = await request<{
              segmentId: string;
              audioUrl: string;
              audioBase64?: string;
            }>(`/api/projects/${projectId}/dubbing/synthesize-segment`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                segmentId: seg.id,
                text: spokenText,
                referenceId: params.voice.fishReferenceId || project.voice.fishReferenceId,
                returnBase64: true,
              }),
            });

            const segBlob = segRes.audioBase64
              ? decodeBase64ToBlob(segRes.audioBase64, 'audio/mpeg')
              : await resolveMediaBlob(segRes.audioUrl, resolveApiUrl);
            const segUrl = segRes.audioUrl || `/media/audio/fish_seg_${projectId.slice(0, 8)}_${seg.id}.mp3`;
            await indexedDbStore.cacheMediaByUrl(segUrl, segBlob, `seg_${seg.id}.mp3`, 'audio/mpeg');

            synthClips.push({
              segmentId: seg.id,
              start: seg.start,
              end: seg.end,
              audioUrl: segUrl,
              blob: segBlob,
              text: spokenText,
              speaker: seg.speaker,
              speed: 1.0,
            });
          }

          if (synthClips.length === 0) {
            throw new Error('No non-empty caption segments could be synthesized.');
          }

          const merged = await trimAndMergeDubClipsInBrowser({
            captions: sourceCaptions,
            clips: synthClips,
            syncMode: params.voice.syncMode,
            continuousPauseMs: params.voice.continuousPauseMs,
            originalDuration: project.metadata?.duration || 15,
            onProgress: (pct, stage) => patchClientJob(job.id, { progress: pct, stage }),
          });

          patchClientJob(job.id, { progress: 95, stage: 'Saving merged dub track...' }, true);
          const storedDub = await storeAssetBlobHybrid({
            projectId,
            bucket: 'audio',
            kind: 'voice',
            filename: `fish_dub_${projectId.slice(0, 8)}_${Date.now()}.mp3`,
            blob: merged.fullDubBlob,
          });

          await api.updateProject(projectId, {
            voice: {
              ...project.voice,
              ...params.voice,
              enabled: true,
              provider: 'fish',
              voiceMuted: false,
              speakingSpeed: 1.0,
              generatedClips: merged.generatedClips,
              fullDubUrl: storedDub.url,
              syncPlan: merged.syncPlan,
            },
          });

          patchClientJob(
            job.id,
            {
              status: 'completed',
              progress: 100,
              stage: 'Fish Audio dubbing completed',
              outputUrl: storedDub.url,
              outputSize: merged.fullDubBlob.size,
              etaSeconds: 0,
            },
            true
          );
        } catch (err) {
          patchClientJob(
            job.id,
            {
              status: 'failed',
              stage: 'Fish Audio dubbing failed',
              error: err instanceof Error ? err.message : String(err),
            },
            true
          );
        }
      })();

      return { job };
    }

    return request<{ job: RenderJob }>(
      `/api/projects/${projectId}/dubbing/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }
    );
  },

  resyncFishDub: async (projectId: string, syncMode: SyncMode, continuousPauseMs?: number) => {
    const res = await request<{ project: Project }>(`/api/projects/${projectId}/dubbing/resync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncMode, continuousPauseMs }),
    });
    if ((await shouldUseBrowserMedia()) && res.project.voice.generatedClips?.length) {
      return api.rebuildFishDubTrack(projectId, {
        generatedClips: res.project.voice.generatedClips,
      });
    }
    return res;
  },

  regenerateFishSegments: async (
    projectId: string,
    params: {
      segmentIds: string[];
      captions?: CaptionSegment[];
      voice?: Partial<Project['voice']>;
      useTranslated?: boolean;
    }
  ) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      const sourceCaptions =
        params.captions && params.captions.length > 0 ? params.captions : project.captions;
      const targetIds = new Set(params.segmentIds || []);
      const useTranslated = params.useTranslated !== false;
      const existingClipMap = new Map(
        (project.voice.generatedClips || []).map((c) => [c.segmentId, c])
      );
      const referenceId = params.voice?.fishReferenceId ?? project.voice.fishReferenceId;

      const combinedClips: Array<{
        segmentId: string;
        start: number;
        end: number;
        audioUrl: string;
        blob: Blob;
        text: string;
        speaker?: string;
        speed?: number;
      }> = [];

      const regeneratedIds: string[] = [];
      for (const seg of sourceCaptions) {
        const spokenText = (useTranslated ? seg.translatedText || seg.text : seg.text).trim();
        if (!spokenText) continue;

        if (targetIds.has(seg.id) || !existingClipMap.has(seg.id)) {
          const segRes = await request<{
            segmentId: string;
            audioUrl: string;
            audioBase64?: string;
          }>(`/api/projects/${projectId}/dubbing/synthesize-segment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              segmentId: seg.id,
              text: spokenText,
              referenceId,
              returnBase64: true,
            }),
          });
          const blob = segRes.audioBase64
            ? decodeBase64ToBlob(segRes.audioBase64, 'audio/mpeg')
            : await resolveMediaBlob(segRes.audioUrl, resolveApiUrl);
          const url = segRes.audioUrl || `/media/audio/fish_seg_${projectId.slice(0, 8)}_${seg.id}.mp3`;
          await indexedDbStore.cacheMediaByUrl(url, blob, `seg_${seg.id}.mp3`, 'audio/mpeg');
          combinedClips.push({
            segmentId: seg.id,
            start: seg.start,
            end: seg.end,
            audioUrl: url,
            blob,
            text: spokenText,
            speaker: seg.speaker,
            speed: existingClipMap.get(seg.id)?.speed ?? 1.0,
          });
          regeneratedIds.push(seg.id);
        } else {
          const existing = existingClipMap.get(seg.id)!;
          const blob = await resolveMediaBlob(existing.audioUrl, resolveApiUrl);
          combinedClips.push({
            segmentId: existing.segmentId,
            start: seg.start,
            end: seg.end,
            audioUrl: existing.audioUrl,
            blob,
            text: spokenText,
            speaker: existing.speaker,
            speed: existing.speed,
          });
        }
      }

      const merged = await trimAndMergeDubClipsInBrowser({
        captions: sourceCaptions,
        clips: combinedClips,
        syncMode: params.voice?.syncMode || project.voice.syncMode,
        continuousPauseMs: params.voice?.continuousPauseMs ?? project.voice.continuousPauseMs,
        originalDuration: project.metadata?.duration || 15,
      });

      const storedDub = await storeAssetBlobHybrid({
        projectId,
        bucket: 'audio',
        kind: 'voice',
        filename: `fish_dub_regen_${projectId.slice(0, 8)}_${Date.now()}.mp3`,
        blob: merged.fullDubBlob,
      });

      const updated = await api.updateProject(projectId, {
        voice: {
          ...project.voice,
          ...(params.voice || {}),
          enabled: true,
          provider: 'fish',
          generatedClips: merged.generatedClips,
          fullDubUrl: storedDub.url,
          syncPlan: merged.syncPlan,
        },
      });

      return {
        project: updated.project,
        regeneratedIds,
        fullDubUrl: storedDub.url,
      };
    }

    return request<{
      project: Project;
      regeneratedIds: string[];
      fullDubUrl: string;
    }>(`/api/projects/${projectId}/dubbing/regenerate-segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  },

  previewVoice: (
    projectId: string,
    params: {
      text: string;
      voiceName: GeminiVoiceName;
      style: string;
      targetLanguage: SupportedLanguage;
      speakingSpeed: number;
    }
  ) =>
    request<{ audioUrl: string }>(`/api/projects/${projectId}/voice/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  generateVoiceover: (
    projectId: string,
    params: { voice: Project['voice']; useTranslated: boolean }
  ) =>
    request<{ project: Project; fullDubUrl: string }>(
      `/api/projects/${projectId}/voice/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }
    ),

  autoDubVideo: (
    projectId: string,
    params: { voice: Project['voice']; preserveProperNouns?: boolean }
  ) =>
    request<{
      project: Project;
      sourceLanguage: string;
      targetLanguage: SupportedLanguage;
      fullDubUrl: string;
    }>(`/api/projects/${projectId}/voice/auto-dub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  generateThumbnails: async (projectId: string) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      return generateThumbnailsInBrowser(project, resolveApiUrl);
    }

    return request<{
      thumbnails: string[];
      sourceMode?: 'final-export' | 'edited-source';
      suggestedTitle: string;
      suggestedSubtitle: string;
      suggestedTitles?: string[];
      translationMissingWarning?: boolean;
    }>(`/api/projects/${projectId}/thumbnails/generate`, { method: 'POST' });
  },

  startExport: async (projectId: string, exportSettings: Project['exportSettings']) => {
    if (await shouldUseBrowserMedia()) {
      const updatedRes = await api.updateProject(projectId, { exportSettings });
      const projectToRender = updatedRes.project;
      const job = makeClientJob({
        projectId,
        type: 'render',
        stage: 'Preparing browser FFmpeg WebAssembly MP4 render...',
        progress: 2,
      });

      let lastSyncedPct = 0;
      void (async () => {
        try {
          const rendered = await renderProjectExportInBrowser({
            project: projectToRender,
            resolveUrlFn: resolveApiUrl,
            onProgress: (pct, stage, etaSec) => {
              const shouldSync = pct - lastSyncedPct >= 15 || pct === 100;
              if (shouldSync) lastSyncedPct = pct;
              patchClientJob(job.id, { progress: pct, stage, etaSeconds: etaSec }, shouldSync);
            },
          });

          patchClientJob(job.id, { progress: 98, stage: 'Saving rendered MP4 & updating project...' }, true);
          const storedExport = await storeAssetBlobHybrid({
            projectId,
            bucket: 'exports',
            kind: 'export',
            filename: rendered.filename,
            blob: rendered.blob,
          });
          const exportedAt = new Date().toISOString();
          await api.updateProject(projectId, {
            lastExportUrl: storedExport.url,
            lastExportSize: rendered.sizeBytes,
            lastExportedAt: exportedAt,
          });

          patchClientJob(
            job.id,
            {
              status: 'completed',
              progress: 100,
              stage: 'Export completed',
              outputUrl: storedExport.url,
              outputSize: rendered.sizeBytes,
              etaSeconds: 0,
            },
            true
          );
        } catch (err) {
          patchClientJob(
            job.id,
            {
              status: 'failed',
              stage: 'Export failed',
              error: err instanceof Error ? err.message : String(err),
            },
            true
          );
        }
      })();

      return { job };
    }

    return request<{ job: RenderJob }>(`/api/projects/${projectId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exportSettings }),
    });
  },

  listProjectJobs: async (projectId: string) => {
    const res = await request<{ jobs: RenderJob[] }>(`/api/projects/${projectId}/jobs`);
    const merged = new Map<string, RenderJob>();
    for (const j of res.jobs || []) merged.set(j.id, j);
    for (const j of clientJobsMap.values()) {
      if (j.projectId === projectId) merged.set(j.id, j);
    }
    return {
      jobs: Array.from(merged.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    };
  },

  getJob: async (jobId: string) => {
    const local = clientJobsMap.get(jobId);
    if (local) return { job: { ...local } };
    return request<{ job: RenderJob }>(`/api/jobs/${jobId}`);
  },

  listAllJobs: async () => {
    const res = await request<{ jobs: RenderJob[] }>('/api/jobs');
    const merged = new Map<string, RenderJob>();
    for (const j of res.jobs || []) merged.set(j.id, j);
    for (const j of clientJobsMap.values()) merged.set(j.id, j);
    return {
      jobs: Array.from(merged.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    };
  },

  uploadVideoDirect: async (projectId: string, file: File) => {
    if (await shouldUseBrowserMedia()) {
      return uploadVideoChunked({
        projectId,
        file,
        onProgress: () => {},
      }).then((project) => ({
        project,
        metadata: project.metadata as VideoMetadata,
      }));
    }
    const fd = new FormData();
    fd.append('file', file);
    return request<{ project: Project; metadata: VideoMetadata }>(`/api/projects/${projectId}/video`, {
      method: 'POST',
      body: fd,
    });
  },

  getTimelineFilmstrip: async (projectId: string, frames?: number) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      return extractTimelineFilmstripInBrowser(project, frames || 32, resolveApiUrl);
    }
    return request<{ frames: FilmstripFrame[]; duration: number }>(
      frames
        ? `/api/projects/${projectId}/timeline-filmstrip?frames=${frames}`
        : `/api/projects/${projectId}/timeline-filmstrip`
    );
  },

  getAudioWaveforms: async (projectId: string) => {
    if (await shouldUseBrowserMedia()) {
      const { project } = await api.getProject(projectId);
      return extractProjectWaveformsInBrowser(project, resolveApiUrl);
    }
    return request<ProjectAudioWaveforms>(`/api/projects/${projectId}/audio-waveforms`);
  },
};

export async function uploadVideoChunked(params: {
  projectId: string;
  file: File;
  onProgress: (pct: number, stage: string) => void;
}): Promise<Project> {
  const { projectId, file, onProgress } = params;
  const browserMode = await shouldUseBrowserMedia();

  if (browserMode) {
    onProgress(5, 'Analyzing video & audio streams in browser...');
    const probed = await probeVideoInBrowser(file, file.name);
    const CHUNK_SIZE = 5 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

    onProgress(18, 'Preparing storage session...');
    const initRes = await request<{
      uploadId: string;
      totalChunks: number;
      storageMode?: 'r2' | 'indexeddb-local';
      suggestedUrl?: string;
    }>('/api/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        filename: file.name,
        totalSize: file.size,
        totalChunks,
      }),
    });

    if (initRes.storageMode === 'r2') {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const buffer = await file.slice(start, end).arrayBuffer();
        const chunkUrl = resolveApiUrl(`/api/uploads/${initRes.uploadId}/chunk?index=${i}`);
        const chunkRes = await fetch(chunkUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buffer,
        });
        if (!chunkRes.ok) {
          const errData = await chunkRes.json().catch(() => ({}));
          throw new Error((errData as { error?: string }).error || `Chunk ${i + 1} upload failed`);
        }
        onProgress(Math.round(20 + ((i + 1) / totalChunks) * 70), `Uploading chunk ${i + 1} of ${totalChunks}...`);
      }

      onProgress(93, 'Finalizing project metadata in D1...');
      const completeRes = await request<{ project: Project }>(
        `/api/uploads/${initRes.uploadId}/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            metadata: probed.metadata,
            thumbnailDataUrl: probed.thumbnailDataUrl || undefined,
            waveformPeaks: probed.waveformPeaks,
          }),
        }
      );
      if (completeRes.project.sourceVideoUrl) {
        await indexedDbStore.cacheMediaByUrl(
          completeRes.project.sourceVideoUrl,
          file,
          file.name,
          file.type
        );
      }
      onProgress(100, 'Upload complete');
      return completeRes.project;
    }

    // Free Zero-Card Cloudflare D1 + Browser IndexedDB Local Binary Flow
    onProgress(65, 'Caching source video locally in IndexedDB...');
    const localVideoUrl =
      initRes.suggestedUrl ||
      `/media/uploads/${projectId.slice(0, 8)}_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await indexedDbStore.cacheMediaByUrl(localVideoUrl, file, file.name, file.type);

    let thumbnailUrl: string | null = probed.thumbnailDataUrl;
    if (probed.thumbnailBlob) {
      const savedThumb = await storeAssetBlobHybrid({
        projectId,
        bucket: 'thumbs',
        kind: 'thumbnail',
        filename: `thumb_${projectId.slice(0, 8)}_${Date.now()}.jpg`,
        blob: probed.thumbnailBlob,
      });
      thumbnailUrl = savedThumb.url;
    }

    onProgress(90, 'Saving video metadata & waveform to Cloudflare D1...');
    const dur = Math.max(0.5, probed.metadata.duration || 10);
    const { project } = await api.updateProject(projectId, {
      sourceVideoUrl: localVideoUrl,
      sourceFilename: file.name,
      thumbnailUrl,
      metadata: probed.metadata,
      waveformPeaks: probed.waveformPeaks,
      videoClips: [
        {
          id: 'vclip_main',
          label: file.name,
          sourceStart: 0,
          sourceEnd: dur,
          timelineStart: 0,
          speed: 1.0,
          audioUnlinked: false,
        },
      ],
      originalAudioClips: [],
    });

    onProgress(100, 'Upload complete');
    return project;
  }

  // Standard Node.js Express server chunked upload flow
  const CHUNK_SIZE = 5 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  onProgress(2, 'Initializing chunked upload...');
  const initRes = await request<{ uploadId: string; totalChunks: number }>('/api/uploads/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      filename: file.name,
      totalSize: file.size,
      totalChunks,
    }),
  });

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const slice = file.slice(start, end);
    const buffer = await slice.arrayBuffer();

    const chunkUrl = resolveApiUrl(`/api/uploads/${initRes.uploadId}/chunk?index=${i}`);
    const chunkRes = await fetch(chunkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    if (!chunkRes.ok) {
      const errData = await chunkRes.json().catch(() => ({}));
      throw new Error(
        (errData as { error?: string }).error || `Chunk ${i + 1} upload failed (${chunkRes.status})`
      );
    }

    const pct = Math.round(5 + ((i + 1) / totalChunks) * 80);
    onProgress(pct, `Uploading chunk ${i + 1} of ${totalChunks}...`);
  }

  onProgress(90, 'Analyzing video streams & extracting audio waveform...');
  const completeRes = await request<{ project: Project }>(
    `/api/uploads/${initRes.uploadId}/complete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    }
  );

  onProgress(100, 'Upload complete');
  return completeRes.project;
}

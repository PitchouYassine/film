import { Project, StudioPreset, SavedFishVoice, SavedFontAsset, DefaultStudioPreferences } from '../types/studio';
import { idbGet, idbSet, idbList, idbDelete } from './browserStorage';

const DEFAULT_PREFERENCES: DefaultStudioPreferences = {
  autoApplyDefaultStyleOnImport: true,
  defaultStyleId: null,
  defaultTargetLanguage: 'English',
  defaultSyncMode: 'flexible',
};

export async function handleLocalApiFallback<T>(url: string, init?: RequestInit): Promise<T | undefined> {
  const method = (init?.method || 'GET').toUpperCase();
  const parsedUrl = new URL(url, 'http://localhost');
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/system/status' && method === 'GET') {
    return {
      geminiConfigured: false,
      fishConfigured: false,
      ffmpegAvailable: true,
      ffprobeAvailable: true,
      ffmpegVersion: 'wasm-browser',
      storageDir: 'indexeddb',
      maxUploadSizeMb: 2048,
      tempRetentionHours: 24,
      supportedVideoFormats: ['MP4', 'MOV', 'MKV'],
      supportedLogoFormats: ['PNG', 'SVG'],
    } as unknown as T;
  }

  if (pathname === '/api/projects' && method === 'GET') {
    const projects = await idbList<Project>('projects');
    return { projects: projects || [] } as unknown as T;
  }

  if (pathname === '/api/projects' && method === 'POST') {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const id = crypto.randomUUID();
    const name = body.name || `Recap Project ${new Date().toLocaleDateString()}`;
    const newProj: Project = {
      id,
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceVideoUrl: null,
      sourceFilename: null,
      thumbnailUrl: null,
      metadata: null,
      waveformPeaks: [],
      captions: [],
      subtitleStyle: {
        enabled: false,
        mode: 'word-by-word',
        chunkSize: 3,
        wordsPerDisplay: 3,
        highlightBehavior: 'color',
        transitionDurationMs: 180,
        timingOffsetSec: 0,
        template: 'tiktok',
        fontFamily: 'Montserrat',
        fontSize: 42,
        fontWeight: 'bold',
        fontWeightNum: 700,
        italic: false,
        underline: false,
        primaryColor: '#FFFFFF',
        highlightColor: '#FFD700',
        outlineColor: '#000000',
        outlineWidth: 2,
        backgroundColor: '#00000088',
        backgroundOpacity: 60,
        borderRadius: 0,
        paddingH: 12,
        paddingV: 8,
        shadowEnabled: true,
        shadowColor: '#000000',
        shadowBlur: 8,
        letterSpacing: 0,
        lineSpacing: 1.2,
        textAlign: 'center',
        position: 'bottom',
        posX: 50,
        posY: 85,
        marginV: 40,
        uppercase: false,
        useTranslated: false,
        animationPreset: 'none',
      },
      translation: { sourceLanguage: 'English', targetLanguage: 'English', preserveProperNouns: true },
      voice: {
        enabled: false,
        provider: 'fish',
        syncMode: 'flexible',
        targetLanguage: 'English',
        gender: 'female',
        voiceName: 'Puck',
        style: 'narrative',
        narrationStyle: 'cinematic',
        speakingSpeed: 1.0,
        voiceVolume: 1.0,
        timingOffsetSec: 0,
        preserveOriginalAudio: true,
        originalAudioVolume: 0.3,
        fadeInSec: 0.5,
        fadeOutSec: 0.5,
        bgMusicVolume: 0.2,
        generatedClips: [],
      },
      blurs: [],
      logos: [],
      videoEffects: {
        filterPreset: 'cinematic',
        filterIntensity: 100,
        filterStack: [],
        adjustments: { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, sharpness: 0, vignette: 0, fade: 0 },
        effects: [],
        compareMode: false,
      },
      canvas: {
        aspectRatio: '9:16',
        customWidth: 1080,
        customHeight: 1920,
        zoom: 1.0,
        offsetX: 0,
        offsetY: 0,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0,
        cropLeft: 0,
        backgroundType: 'solid',
        bgColor: '#0B0B0F',
        bgImageScale: 1.0,
        bgImageOffsetX: 0,
        bgImageOffsetY: 0,
        bgBlurIntensity: 20,
        bgBlurBrightness: 100,
        bgBlurOpacity: 100,
      },
      exportSettings: {
        aspectRatio: '9:16',
        resolution: '1080p',
        fitMode: 'blur-pad',
        format: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        applyBlur: true,
        applyLogo: true,
        applyVideoEffects: true,
        applyCaptions: false,
        applyDubbing: true,
        applyAudioMix: true,
      },
      lastExportUrl: null,
      lastExportSize: null,
      lastExportedAt: null,
      videoClips: [],
      originalAudioClips: [],
    };
    await idbSet('projects', id, newProj);
    return { project: newProj, presetWarnings: [] } as unknown as T;
  }

  const projMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (projMatch) {
    const projId = projMatch[1];
    if (method === 'GET') {
      const proj = await idbGet<Project>('projects', projId);
      if (!proj) throw new Error('Project not found');
      return { project: proj } as unknown as T;
    }
    if (method === 'PATCH') {
      const patch = init?.body ? JSON.parse(String(init.body)) : {};
      const proj = await idbGet<Project>('projects', projId);
      if (!proj) throw new Error('Project not found');
      const updated = { ...proj, ...patch, updatedAt: new Date().toISOString() };
      await idbSet('projects', projId, updated);
      return { project: updated } as unknown as T;
    }
    if (method === 'DELETE') {
      await idbDelete('projects', projId);
      return { deleted: true } as unknown as T;
    }
  }

  if (pathname === '/api/presets' && method === 'GET') {
    const presets = await idbList<StudioPreset>('presets');
    return { presets: presets || [] } as unknown as T;
  }

  if (pathname === '/api/styles' && method === 'GET') {
    const presets = await idbList<StudioPreset>('presets');
    const styles = (presets || []).filter(p => p.category === 'style');
    return { styles, defaultStyleId: null } as unknown as T;
  }

  if (pathname === '/api/settings/preferences' && method === 'GET') {
    const prefs = (await idbGet<DefaultStudioPreferences>('settings', 'preferences')) || DEFAULT_PREFERENCES;
    return { preferences: prefs, defaultStyle: null } as unknown as T;
  }

  if (pathname === '/api/settings/preferences' && method === 'PATCH') {
    const patch = init?.body ? JSON.parse(String(init.body)) : {};
    const prefs = ((await idbGet<DefaultStudioPreferences>('settings', 'preferences')) || DEFAULT_PREFERENCES);
    const updated = { ...prefs, ...patch };
    await idbSet('settings', 'preferences', updated);
    return { preferences: updated, defaultStyle: null } as unknown as T;
  }

  if (pathname === '/api/settings/fish-audio' && method === 'GET') {
    return { configured: false, connectionStatus: 'not_connected' } as unknown as T;
  }

  if (pathname === '/api/fish/voices' && method === 'GET') {
    return { voices: [], total: 0 } as unknown as T;
  }

  if (pathname === '/api/fish/saved-voices' && method === 'GET') {
    const voices = (await idbList<SavedFishVoice>('saved_fish_voices')) || [];
    return { voices } as unknown as T;
  }

  if (pathname === '/api/fonts' && method === 'GET') {
    const fonts = (await idbList<SavedFontAsset>('fonts')) || [];
    return { fonts } as unknown as T;
  }

  return undefined;
}

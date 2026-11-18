import {
  deleteSavedFishApiKey,
  getFishSettingsSummary,
  resolveFishApiKey,
  saveFishApiKey,
} from '../_lib/crypto.ts';
import {
  getSavedFishVoices,
  requireDb,
  saveSavedFishVoices,
} from '../_lib/d1.ts';
import {
  listFishVoices,
  synthesizeFishSpeech,
  testFishAudioConnection,
  validateFishVoiceId,
} from '../_lib/fish.ts';
import {
  errorJson,
  jsonResponse,
  optionsResponse,
  readJsonBody,
} from '../_lib/http.ts';
import type { SavedFishVoice } from '../../src/types/studio.ts';
import type { Env } from '../_lib/types.ts';

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return optionsResponse(request);
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  try {
    if (pathname.endsWith('/api/settings/fish-audio')) {
      if (method === 'GET') {
        return jsonResponse(await getFishSettingsSummary(env), 200, request);
      }
    }

    if (pathname.endsWith('/api/settings/fish-api-key')) {
      if (method === 'POST') {
        const body = await readJsonBody<{ apiKey?: string }>(request);
        const summary = await saveFishApiKey(
          env,
          typeof body.apiKey === 'string' ? body.apiKey : ''
        );
        return jsonResponse(summary, 200, request);
      }
      if (method === 'DELETE') {
        return jsonResponse(await deleteSavedFishApiKey(env), 200, request);
      }
    }

    if (pathname.endsWith('/api/settings/fish-api-key/test')) {
      if (method === 'POST') {
        const body = await readJsonBody<{ apiKey?: string }>(request).catch(() => ({}));
        const candidateKey =
          typeof (body as { apiKey?: unknown }).apiKey === 'string'
            ? String((body as { apiKey?: string }).apiKey)
            : undefined;
        return jsonResponse(await testFishAudioConnection(env, candidateKey), 200, request);
      }
    }

    if (pathname.endsWith('/api/fish/voices')) {
      if (method === 'GET') {
        const query = url.searchParams.get('q') || undefined;
        const selfOnly = url.searchParams.get('self') === 'true';
        const language = url.searchParams.get('language') || undefined;
        return jsonResponse(await listFishVoices(env, { query, selfOnly, language }), 200, request);
      }
    }

    if (pathname.endsWith('/api/fish/saved-voices')) {
      const db = requireDb(env);
      if (method === 'GET') {
        return jsonResponse({ voices: await getSavedFishVoices(db) }, 200, request);
      }
      if (method === 'POST') {
        const body = await readJsonBody<Record<string, unknown>>(request);
        const name = String(body.name || '').trim();
        const voiceId = String(body.voiceId || '').trim();
        if (!name) return errorJson('Narrator name is required.', 400, request);
        if (!voiceId) return errorJson('Fish Audio Voice ID is required.', 400, request);

        let validated = false;
        let validationMessage = 'Saved without remote verification.';
        if (!body.skipRemoteValidation) {
          const check = await validateFishVoiceId(env, voiceId);
          validated = check.checked && check.valid;
          validationMessage = check.message;
        }

        const now = new Date().toISOString();
        const existing = await getSavedFishVoices(db);
        const setDefault = Boolean(body.isDefault);
        const newVoice = {
          id: crypto.randomUUID(),
          name,
          voiceId,
          ...(typeof body.description === 'string' && body.description.trim()
            ? { description: body.description.trim() }
            : {}),
          ...(typeof body.language === 'string' && body.language.trim()
            ? { language: body.language.trim() }
            : {}),
          ...(typeof body.sampleUrl === 'string' && body.sampleUrl.trim()
            ? { sampleUrl: body.sampleUrl.trim() }
            : {}),
          ...(typeof body.previewText === 'string' && body.previewText.trim()
            ? { previewText: body.previewText.trim() }
            : {}),
          validated,
          isDefault: setDefault || existing.length === 0,
          createdAt: now,
          updatedAt: now,
        };
        const next = existing
          .map((v: SavedFishVoice) => (newVoice.isDefault ? { ...v, isDefault: false } : v))
          .concat(newVoice);
        await saveSavedFishVoices(db, next);
        return jsonResponse({ voice: newVoice, voices: next, validationMessage }, 201, request);
      }
    }

    if (pathname.endsWith('/api/fish/saved-voices/validate')) {
      if (method === 'POST') {
        const body = await readJsonBody<{ voiceId?: string }>(request);
        return jsonResponse(await validateFishVoiceId(env, String(body.voiceId || '')), 200, request);
      }
    }

    if (pathname.endsWith('/api/fish/saved-voices/preview')) {
      if (method === 'POST') {
        const body = await readJsonBody<{ voiceId?: string; text?: string }>(request);
        const text =
          String(body.text || '').trim() ||
          'Everything changed the moment the vault door swung open in silence.';
        const synth = await synthesizeFishSpeech(env, {
          projectId: 'global-voice-preview',
          text,
          referenceId: typeof body.voiceId === 'string' ? body.voiceId.trim() : undefined,
          filenamePrefix: 'fish_preview_global',
        });
        if (synth.storedIn === 'client-only') {
          const b64 = btoa(String.fromCharCode(...synth.bytes));
          return jsonResponse({ audioUrl: `data:audio/mpeg;base64,${b64}` }, 200, request);
        }
        return jsonResponse({ audioUrl: synth.audioUrl }, 200, request);
      }
    }

    return errorJson('Fish Audio API endpoint not found', 404, request);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    return errorJson(err instanceof Error ? err.message : String(err), status, request);
  }
};

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit3,
  Languages,
  Loader2,
  Mic,
  Music,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Volume2,
  Wand2,
} from 'lucide-react';
import {
  CaptionSegment,
  FishVoiceModel,
  NavPage,
  Project,
  RenderJob,
  SavedFishVoice,
  SupportedLanguage,
  VoiceConfig,
} from '../types/studio';
import { api } from '../lib/api';
import { formatTimecode } from '../lib/formatters';
import {
  createWorkflowUpdate,
  validateProjectReadyForEditor,
} from '../lib/workflowStages';
import { VideoStudioPlayer } from '../components/VideoStudioPlayer';
import { ExternalGeminiTranslatorPanel } from '../components/ExternalGeminiTranslatorPanel';
import { TimelineSyncCard } from '../components/TimelineSyncCard';
import { NarratorSelector } from '../components/NarratorSelector';

interface VoiceStudioPageProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  onTimeUpdate: (time: number) => void;
  onSeek: (time: number) => void;
  previewEffects: boolean;
  onTogglePreviewEffects: (val: boolean) => void;
  onNavigate?: (page: NavPage) => void;
  onValidatedContinue?: (validatedProject: Project) => void;
}

const SOURCE_LANGUAGES = [
  'Auto',
  'English',
  'French',
  'Arabic',
  'Spanish',
  'German',
  'Portuguese',
  'Italian',
  'Turkish',
  'Hindi',
];

const DUB_TARGET_LANGUAGES: SupportedLanguage[] = [
  'French',
  'Arabic',
  'English',
  'Spanish',
  'German',
  'Portuguese',
];

export function VoiceStudioPage({
  project,
  onProjectUpdated,
  videoRef,
  currentTime,
  onTimeUpdate,
  onSeek,
  previewEffects,
  onTogglePreviewEffects,
  onNavigate,
  onValidatedContinue,
}: VoiceStudioPageProps) {
  const musicInputRef = useRef<HTMLInputElement>(null);
  const segAudioRef = useRef<HTMLAudioElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  const [playingSegmentId, setPlayingSegmentId] = useState<string | null>(null);
  const [busyValidate, setBusyValidate] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [fishConfigured, setFishConfigured] = useState<boolean | null>(null);
  const [sourceLanguage, setSourceLanguage] = useState<string>(
    project.translation.sourceLanguage || 'Auto'
  );
  const [targetLanguage, setTargetLanguage] = useState<SupportedLanguage>(
    DUB_TARGET_LANGUAGES.includes(project.voice.targetLanguage)
      ? project.voice.targetLanguage
      : 'French'
  );
  const [preserveProperNouns, setPreserveProperNouns] = useState<boolean>(
    project.translation.preserveProperNouns
  );
  const [translationMode, setTranslationMode] = useState<'auto' | 'external-gemini'>('auto');

  // Compact Progressive Disclosure Toggles
  const [voiceBrowserOpen, setVoiceBrowserOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Fish Audio Voices Browser & Saved Voice Library
  const [voices, setVoices] = useState<FishVoiceModel[]>([]);
  const [voiceQuery, setVoiceQuery] = useState('');
  const [selfVoicesOnly, setSelfVoicesOnly] = useState(false);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [savedVoices, setSavedVoices] = useState<SavedFishVoice[]>([]);
  const [newVoiceName, setNewVoiceName] = useState('');
  const [newVoiceId, setNewVoiceId] = useState('');
  const [setAsDefaultOnSave, setSetAsDefaultOnSave] = useState(false);
  const [editingSavedVoiceId, setEditingSavedVoiceId] = useState<string | null>(null);
  const [editVoiceName, setEditVoiceName] = useState('');
  const [editVoiceId, setEditVoiceId] = useState('');
  const [busySavedVoice, setBusySavedVoice] = useState(false);

  // Operation States
  const [busyTranscribe, setBusyTranscribe] = useState(false);
  const [busyTranslate, setBusyTranslate] = useState(false);
  const [busyPreview, setBusyPreview] = useState(false);
  const [busyGenerate, setBusyGenerate] = useState(false);
  const [busyRegenSegments, setBusyRegenSegments] = useState(false);
  const [busyMusic, setBusyMusic] = useState(false);
  const [focusAudioOverflowSignal, setFocusAudioOverflowSignal] = useState(0);

  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [activeDubJob, setActiveDubJob] = useState<RenderJob | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const voice = project.voice;

  useEffect(() => {
    const loadConfig = () => {
      void api
        .getSystemStatus()
        .then((s) => setFishConfigured(s.fishConfigured))
        .catch(() => setFishConfigured(null));
    };
    loadConfig();
    void api
      .listSavedFishVoices()
      .then(({ voices: sv }) => setSavedVoices(sv))
      .catch(() => {});

    window.addEventListener('focus', loadConfig);
    return () => window.removeEventListener('focus', loadConfig);
  }, []);

  useEffect(() => {
    setSourceLanguage(project.translation.sourceLanguage || 'Auto');
    setActiveDubJob(null);
    void api
      .listProjectJobs(project.id)
      .then(({ jobs }) => {
        const runningVoice = jobs.find(
          (j) => j.type === 'voice' && (j.status === 'queued' || j.status === 'processing')
        );
        if (runningVoice) {
          setActiveDubJob(runningVoice);
        }
      })
      .catch(() => {});
  }, [project.id, project.translation.sourceLanguage]);

  const loadFishVoices = async (opts?: { q?: string; self?: boolean }) => {
    setLoadingVoices(true);
    setVoicesError(null);
    try {
      const res = await api.listFishVoices({
        query: opts?.q ?? voiceQuery,
        selfOnly: opts?.self ?? selfVoicesOnly,
      });
      setVoices(res.voices);
    } catch (err) {
      setVoicesError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingVoices(false);
    }
  };

  useEffect(() => {
    if (fishConfigured) {
      void loadFishVoices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fishConfigured]);

  // Poll active Fish Audio dubbing job
  useEffect(() => {
    if (
      !activeDubJob ||
      (activeDubJob.status !== 'queued' && activeDubJob.status !== 'processing')
    ) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const res = await api.getJob(activeDubJob.id);
        setActiveDubJob(res.job);
        if (res.job.status === 'completed') {
          const pRes = await api.getProject(project.id);
          const nextWorkflow = createWorkflowUpdate(pRes.project.workflow, {
            completeStage: 'voice',
            modifiedStage: 'voice',
            hasExistingExport: Boolean(pRes.project.lastExportUrl),
          });
          const { project: syncedProject } = await api.updateProject(project.id, {
            workflow: nextWorkflow,
          });
          onProjectUpdated(syncedProject);
          setStatusMsg(
            `Generated ${syncedProject.voice.generatedClips.length} narration clip(s).`
          );
        } else if (res.job.status === 'failed') {
          setErrorMsg(res.job.error || 'Voice generation failed.');
        }
      } catch {
        // ignore transient poll error
      }
    }, 700);

    return () => clearInterval(timer);
  }, [activeDubJob, project.id, onProjectUpdated]);

  const updateVoice = async (patch: Partial<VoiceConfig>) => {
    const nextVoice: VoiceConfig = { ...voice, ...patch, provider: 'fish' };
    const nextWorkflow = createWorkflowUpdate(project.workflow, {
      visitStage: 'voice',
      modifiedStage: 'voice',
      hasExistingExport: Boolean(project.lastExportUrl),
    });
    onProjectUpdated({ ...project, voice: nextVoice, workflow: nextWorkflow });
    const { project: saved } = await api.updateProject(project.id, {
      voice: nextVoice,
      workflow: nextWorkflow,
    });
    onProjectUpdated(saved);
  };

  const handleSaveFishVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = newVoiceName.trim();
    const trimmedId = newVoiceId.trim();
    if (!trimmedName || !trimmedId) return;
    setErrorMsg(null);
    setBusySavedVoice(true);
    try {
      const res = await api.createSavedFishVoice({
        name: trimmedName,
        voiceId: trimmedId,
        isDefault: setAsDefaultOnSave,
      });
      setSavedVoices(res.voices);
      setNewVoiceName('');
      setNewVoiceId('');
      setSetAsDefaultOnSave(false);
      await updateVoice({
        fishReferenceId: res.voice.voiceId,
        fishVoiceTitle: res.voice.name,
      });
      setStatusMsg(`Saved voice "${res.voice.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySavedVoice(false);
    }
  };

  const handleUseSavedVoice = async (savedVoice: SavedFishVoice) => {
    await updateVoice({
      fishReferenceId: savedVoice.voiceId,
      fishVoiceTitle: savedVoice.name,
    });
    setStatusMsg(`Voice selected: ${savedVoice.name}`);
  };

  const handleSetDefaultSavedVoice = async (savedVoice: SavedFishVoice) => {
    setErrorMsg(null);
    setBusySavedVoice(true);
    try {
      const res = await api.updateSavedFishVoice(savedVoice.id, { isDefault: true });
      setSavedVoices(res.voices);
      await updateVoice({
        fishReferenceId: savedVoice.voiceId,
        fishVoiceTitle: savedVoice.name,
      });
      setStatusMsg(`Set "${savedVoice.name}" as default.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySavedVoice(false);
    }
  };

  const handleSaveEditedSavedVoice = async (id: string) => {
    const trimmedName = editVoiceName.trim();
    const trimmedId = editVoiceId.trim();
    if (!trimmedName || !trimmedId) return;
    setErrorMsg(null);
    setBusySavedVoice(true);
    try {
      const oldVoice = savedVoices.find((v) => v.id === id);
      const res = await api.updateSavedFishVoice(id, {
        name: trimmedName,
        voiceId: trimmedId,
      });
      setSavedVoices(res.voices);
      setEditingSavedVoiceId(null);
      if (oldVoice && voice.fishReferenceId === oldVoice.voiceId) {
        await updateVoice({
          fishReferenceId: res.voice.voiceId,
          fishVoiceTitle: res.voice.name,
        });
      }
      setStatusMsg(`Updated voice "${res.voice.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySavedVoice(false);
    }
  };

  const handleDeleteSavedVoice = async (savedVoice: SavedFishVoice) => {
    setErrorMsg(null);
    setBusySavedVoice(true);
    try {
      const res = await api.deleteSavedFishVoice(savedVoice.id);
      setSavedVoices(res.voices);
      if (editingSavedVoiceId === savedVoice.id) {
        setEditingSavedVoiceId(null);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySavedVoice(false);
    }
  };

  const persistCaptionsDebounced = (nextCaptions: CaptionSegment[]) => {
    const nextWorkflow = createWorkflowUpdate(project.workflow, {
      visitStage: 'voice',
      modifiedStage: 'translator',
      hasGeneratedDub: Boolean(project.voice.fullDubUrl),
      hasGeneratedCaptions: Boolean(project.subtitleStyle.captionSync),
      hasExistingExport: Boolean(project.lastExportUrl),
    });
    onProjectUpdated({ ...project, captions: nextCaptions, workflow: nextWorkflow });
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void api
        .updateProject(project.id, { captions: nextCaptions, workflow: nextWorkflow })
        .then(({ project: saved }) => {
          onProjectUpdated(saved);
        });
    }, 450);
  };

  const handleTranscribeFish = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyTranscribe(true);
    try {
      const res = await api.transcribeWithFish(project.id, sourceLanguage);
      onProjectUpdated(res.project);
      setSourceLanguage(res.detectedLanguage);
      setStatusMsg(
        `Extracted ${res.segmentCount} segments (${res.detectedLanguage}).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTranscribe(false);
    }
  };

  const handleTranslate = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyTranslate(true);
    try {
      await api.updateProject(project.id, {
        captions: project.captions,
        translation: {
          ...project.translation,
          sourceLanguage,
          targetLanguage,
          preserveProperNouns,
        },
        voice: { ...voice, targetLanguage, provider: 'fish' },
      });
      const res = await api.translate(project.id, targetLanguage, preserveProperNouns);
      onProjectUpdated(res.project);
      setStatusMsg(`Translated ${res.project.captions.length} segments to ${targetLanguage}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTranslate(false);
    }
  };

  const handlePreviewVoice = async () => {
    setErrorMsg(null);
    setBusyPreview(true);
    try {
      const firstSeg = project.captions[0];
      const sampleText =
        (firstSeg && (firstSeg.translatedText || firstSeg.text)) ||
        (targetLanguage === 'French'
          ? 'Tout a bascule au moment ou la porte du coffre s est ouverte en silence.'
          : targetLanguage === 'Arabic'
          ? 'تغير كل شيء في اللحظة التي انفتح فيها باب الخزنة في صمت تام.'
          : targetLanguage === 'Spanish'
          ? 'Todo cambio en el momento en que la puerta de la boveda se abrio en silencio.'
          : targetLanguage === 'German'
          ? 'Alles anderte sich in dem Moment, als sich die Tresortur lautlos offnete.'
          : targetLanguage === 'Portuguese'
          ? 'Tudo mudou no momento em que a porta do cofre se abriu em silencio.'
          : 'Everything changed the moment the vault door swung open in silence.');

      const res = await api.previewFishDub(project.id, {
        text: sampleText,
        referenceId: voice.fishReferenceId,
        speakingSpeed: 1.0,
      });
      setPreviewAudioUrl(res.audioUrl);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPreview(false);
    }
  };

  const handleGenerateDub = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyGenerate(true);
    try {
      const hasTranslations = project.captions.some((c) => Boolean(c.translatedText?.trim()));
      const res = await api.generateFishDub(project.id, {
        voice: { ...voice, targetLanguage, provider: 'fish', speakingSpeed: 1.0, enabled: true },
        captions: project.captions,
        useTranslated: hasTranslations,
      });
      setActiveDubJob(res.job);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyGenerate(false);
    }
  };

  const handleRegenerateSelectedSegments = async (segmentIds: string[]) => {
    if (segmentIds.length === 0) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setBusyRegenSegments(true);
    try {
      const hasTranslations = project.captions.some((c) => Boolean(c.translatedText?.trim()));
      const res = await api.regenerateFishSegments(project.id, {
        segmentIds,
        captions: project.captions,
        voice: { ...voice, targetLanguage, provider: 'fish', speakingSpeed: 1.0, enabled: true },
        useTranslated: hasTranslations,
      });
      onProjectUpdated(res.project);
      setStatusMsg(`Regenerated ${res.regeneratedIds.length} segment(s).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRegenSegments(false);
    }
  };

  const handleMusicUpload = async (file: File) => {
    setErrorMsg(null);
    setBusyMusic(true);
    try {
      const res = await api.uploadMusic(project.id, file);
      onProjectUpdated(res.project);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMusic(false);
    }
  };

  const updateSegment = (id: string, patch: Partial<CaptionSegment>) => {
    const next = project.captions.map((c) => (c.id === id ? { ...c, ...patch } : c));
    persistCaptionsDebounced(next);
  };

  const addSegment = () => {
    const last = project.captions[project.captions.length - 1];
    const start = last ? Number(last.end.toFixed(2)) : 0;
    const end = Number(
      Math.min(project.metadata?.duration || start + 4, start + 3).toFixed(2)
    );
    const next: CaptionSegment[] = [
      ...project.captions,
      {
        id: `seg_${Date.now()}`,
        start,
        end: Math.max(start + 0.5, end),
        text: '',
        translatedText: '',
      },
    ];
    persistCaptionsDebounced(next);
  };

  const removeSegment = (id: string) => {
    const next = project.captions.filter((c) => c.id !== id);
    persistCaptionsDebounced(next);
  };

  const isDubGenerating =
    busyGenerate ||
    Boolean(
      activeDubJob &&
        (activeDubJob.status === 'queued' || activeDubJob.status === 'processing')
    );

  const pendingRegenIds = project.translation.pendingRegenerateSegmentIds || [];

  const syncWarnings = (voice.generatedClips || [])
    .map((clip, idx) => {
      const slotDur = clip.slotDuration ?? Math.max(0.2, clip.end - clip.start);
      const overflow =
        clip.overflowSeconds ?? Math.max(0, Math.round((clip.duration - slotDur) * 100) / 100);
      return { clip, idx, slotDur, overflow };
    })
    .filter((item) => item.overflow > 0.15);

  const toggleSegmentAudioPreview = (segmentId: string, audioUrl: string) => {
    if (playingSegmentId === segmentId && segAudioRef.current) {
      segAudioRef.current.pause();
      setPlayingSegmentId(null);
      return;
    }
    if (segAudioRef.current) {
      segAudioRef.current.pause();
    }
    const audio = new Audio(audioUrl);
    segAudioRef.current = audio;
    setPlayingSegmentId(segmentId);
    audio.onended = () => setPlayingSegmentId(null);
    audio.onerror = () => {
      setPlayingSegmentId(null);
      setErrorMsg('Unable to play generated audio for this segment.');
    };
    void audio.play().catch(() => {
      setPlayingSegmentId(null);
      setErrorMsg('Browser blocked audio preview playback.');
    });
  };

  useEffect(() => {
    return () => {
      segAudioRef.current?.pause();
    };
  }, []);

  const validation = validateProjectReadyForEditor(project, activeDubJob?.status ?? null);

  useEffect(() => {
    if (validation.valid && validationError) {
      setValidationError(null);
    }
  }, [validation.valid, validationError]);

  const handleValidateAndContinue = async () => {
    setErrorMsg(null);
    setValidationError(null);

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    const check = validateProjectReadyForEditor(project, activeDubJob?.status ?? null);
    if (!check.valid) {
      setValidationError(check.errors.join(' '));
      return;
    }

    setBusyValidate(true);
    try {
      const nextWorkflow = createWorkflowUpdate(project.workflow, {
        completeStage: 'voice',
        visitStage: 'editor',
        clearAttentionFor: 'voice',
        hasExistingExport: Boolean(project.lastExportUrl),
      });
      const nextVoice: VoiceConfig = {
        ...project.voice,
        provider: 'fish',
        speakingSpeed: 1.0,
        enabled: true,
      };
      const { project: saved } = await api.updateProject(project.id, {
        captions: project.captions,
        translation: {
          ...project.translation,
          sourceLanguage,
          targetLanguage,
          preserveProperNouns,
        },
        voice: nextVoice,
        workflow: nextWorkflow,
      });
      onProjectUpdated(saved);
      if (onValidatedContinue) {
        onValidatedContinue(saved);
      } else {
        onNavigate?.('editor');
      }
    } catch (err) {
      setValidationError(
        err instanceof Error ? err.message : 'Failed to validate project metadata.'
      );
    } finally {
      setBusyValidate(false);
    }
  };

  // Active voice selector value
  const voiceSelectValue = voice.fishReferenceId
    ? `id:${voice.fishReferenceId}`
    : '';

  const matchedSavedVoice = savedVoices.find(
    (s) => s.voiceId === (voice.fishReferenceId || '').trim()
  );
  const matchedCatalogVoice = voices.find(
    (v) => v.id === (voice.fishReferenceId || '').trim()
  );

  return (
    <div className="p-3 sm:p-5 max-w-[1560px] mx-auto space-y-4">
      {/* Compact Header with Readiness Summary & Single Primary Validate CTA */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.08] pb-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-lg sm:text-xl font-display font-bold tracking-tight text-white">
            Translation &amp; Voice Generation
          </h1>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
            <span
              className={`px-2 py-0.5 rounded border ${
                validation.translationValid
                  ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                  : 'bg-zinc-900 border-white/[0.08] text-zinc-400'
              }`}
            >
              {validation.summary.translatedCount}/{validation.summary.totalSegments} translated
            </span>
            <span
              className={`px-2 py-0.5 rounded border ${
                validation.audioCompleted
                  ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                  : 'bg-zinc-900 border-white/[0.08] text-zinc-400'
              }`}
            >
              {isDubGenerating
                ? 'Generating audio...'
                : validation.audioCompleted
                ? `${validation.summary.matchedAudioCount}/${validation.summary.totalSegments} clips ready`
                : 'Audio pending'}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void handleValidateAndContinue()}
          disabled={busyValidate}
          className="min-h-[40px] px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs sm:text-sm font-semibold text-white flex items-center justify-center gap-2 shrink-0 cursor-pointer shadow-lg shadow-violet-600/25"
        >
          {busyValidate ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <CheckCircle2 className="w-4 h-4" />
          )}
          <span>VALIDATE &amp; CONTINUE TO EDIT</span>
        </button>
      </div>

      {/* Actionable Banners (only shown when needed) */}
      {fishConfigured === false && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>Fish Audio API key is not connected. Add it in Settings to transcribe and generate voices.</span>
          </div>
          {onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-xs font-semibold text-amber-100 flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>Open Settings</span>
            </button>
          )}
        </div>
      )}

      {validationError && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2"
        >
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{validationError}</span>
        </div>
      )}

      {errorMsg && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {statusMsg && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{statusMsg}</span>
        </div>
      )}

      {/* Main Responsive Two-Column Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* LEFT COLUMN: Video Preview, Generated Audio Playback & Collapsible Advanced Settings */}
        <div className="xl:col-span-5 space-y-3.5">
          <VideoStudioPlayer
            project={project}
            currentTime={currentTime}
            onTimeUpdate={onTimeUpdate}
            videoRef={videoRef}
            previewEffects={previewEffects}
            onTogglePreviewEffects={onTogglePreviewEffects}
            drawMode="none"
          />

          {(previewAudioUrl || voice.fullDubUrl) && (
            <div className="p-3.5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-2.5">
              {previewAudioUrl && (
                <div className="space-y-1">
                  <div className="text-[11px] font-medium text-zinc-300">Voice Preview</div>
                  <audio src={previewAudioUrl} controls autoPlay className="w-full h-9" />
                </div>
              )}

              {voice.fullDubUrl && (
                <div className={`space-y-1 ${previewAudioUrl ? 'pt-2 border-t border-white/[0.06]' : ''}`}>
                  <div className="text-[11px] font-medium text-emerald-300 flex items-center justify-between gap-2">
                    <span>Full Dub Track ({voice.generatedClips.length} clips)</span>
                    <a
                      href={`${voice.fullDubUrl}?download=1`}
                      className="font-mono text-violet-300 hover:text-violet-200"
                    >
                      Download MP3
                    </a>
                  </div>
                  <audio src={voice.fullDubUrl} controls className="w-full h-9" />
                </div>
              )}
            </div>
          )}

          {/* Collapsible Advanced Settings */}
          <div className="rounded-xl bg-[#111115] border border-white/[0.08] overflow-hidden">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="w-full px-4 py-3 flex items-center justify-between text-xs font-semibold text-zinc-200 hover:text-white hover:bg-white/[0.03] cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-violet-400" />
                <span>Advanced Settings</span>
                <span className="text-[11px] font-normal text-zinc-500">
                  Sync, mixing, voice IDs, style
                </span>
              </span>
              {advancedOpen ? (
                <ChevronDown className="w-4 h-4 text-zinc-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-zinc-400" />
              )}
            </button>

            {advancedOpen && (
              <div className="p-3.5 pt-2 border-t border-white/[0.08] space-y-4">
                {/* Timeline Sync Modes */}
                <TimelineSyncCard
                  project={project}
                  onProjectUpdated={onProjectUpdated}
                  onSeek={onSeek}
                  compact
                />

                {/* Audio Mixing */}
                <div className="p-3.5 rounded-xl bg-[#16161B] border border-white/[0.07] space-y-3">
                  <div className="text-xs font-semibold text-white">Audio Mixing</div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Narrator Volume</span>
                        <span className="font-mono text-zinc-200">
                          {Math.round(voice.voiceVolume * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.1}
                        max={1.8}
                        step={0.05}
                        value={voice.voiceVolume}
                        onChange={(e) => void updateVoice({ voiceVolume: Number(e.target.value) })}
                        className="mt-1 w-full accent-violet-500"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between text-[11px] text-zinc-400">
                        <span>Timing Offset</span>
                        <span className="font-mono text-zinc-200">
                          {voice.timingOffsetSec >= 0 ? '+' : ''}
                          {(voice.timingOffsetSec || 0).toFixed(2)}s
                        </span>
                      </div>
                      <input
                        type="range"
                        min={-2.5}
                        max={2.5}
                        step={0.05}
                        value={voice.timingOffsetSec || 0}
                        onChange={(e) =>
                          void updateVoice({ timingOffsetSec: Number(e.target.value) })
                        }
                        className="mt-1 w-full accent-violet-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-white/[0.06]">
                    <div className="space-y-1.5">
                      <label className="flex items-center justify-between text-xs text-zinc-200 cursor-pointer">
                        <span>Keep Original Audio</span>
                        <input
                          type="checkbox"
                          checked={voice.preserveOriginalAudio}
                          onChange={(e) =>
                            void updateVoice({ preserveOriginalAudio: e.target.checked })
                          }
                          className="accent-violet-500"
                        />
                      </label>
                      {voice.preserveOriginalAudio && (
                        <div>
                          <div className="flex justify-between text-[11px] text-zinc-400">
                            <span>Original Level</span>
                            <span className="font-mono">
                              {Math.round(voice.originalAudioVolume * 100)}%
                            </span>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={1.2}
                            step={0.05}
                            value={voice.originalAudioVolume}
                            onChange={(e) =>
                              void updateVoice({ originalAudioVolume: Number(e.target.value) })
                            }
                            className="mt-1 w-full accent-violet-500"
                          />
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-zinc-300 flex items-center gap-1.5">
                          <Music className="w-3.5 h-3.5 text-zinc-400" />
                          Music
                        </span>
                        <input
                          ref={musicInputRef}
                          type="file"
                          accept=".mp3,.wav,.aac,.m4a,.ogg,audio/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleMusicUpload(f);
                            e.target.value = '';
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => musicInputRef.current?.click()}
                          disabled={busyMusic}
                          className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 cursor-pointer"
                        >
                          {busyMusic ? 'Uploading...' : voice.bgMusicUrl ? 'Replace' : 'Add Track'}
                        </button>
                      </div>
                      {voice.bgMusicFilename && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px] text-zinc-400">
                            <span className="truncate">{voice.bgMusicFilename}</span>
                            <button
                              type="button"
                              onClick={() =>
                                void updateVoice({
                                  bgMusicFilename: undefined,
                                  bgMusicUrl: undefined,
                                })
                              }
                              className="text-red-400 hover:text-red-300 ml-2 cursor-pointer"
                            >
                              Remove
                            </button>
                          </div>
                          <input
                            type="range"
                            min={0.02}
                            max={1}
                            step={0.02}
                            value={voice.bgMusicVolume}
                            onChange={(e) =>
                              void updateVoice({ bgMusicVolume: Number(e.target.value) })
                            }
                            className="w-full accent-violet-500"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Narration Style, Translation Options & Direct Reference ID */}
                <div className="p-3.5 rounded-xl bg-[#16161B] border border-white/[0.07] space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] text-zinc-400">Narration Style</label>
                      <select
                        value={voice.narrationStyle || 'cinematic'}
                        onChange={(e) =>
                          void updateVoice({
                            narrationStyle: e.target.value as 'cinematic' | 'natural',
                          })
                        }
                        className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 cursor-pointer"
                      >
                        <option value="cinematic">Cinematic</option>
                        <option value="natural">Natural</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] text-zinc-400">Direct Voice ID</label>
                      <input
                        type="text"
                        value={voice.fishReferenceId || ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          const match = savedVoices.find((s) => s.voiceId === val.trim());
                          onProjectUpdated({
                            ...project,
                            voice: {
                              ...voice,
                              fishReferenceId: val,
                              fishVoiceTitle: match
                                ? match.name
                                : val
                                ? `Voice Reference ${val.slice(0, 8)}...`
                                : 'Default Fish Audio Voice',
                            },
                          });
                        }}
                        onBlur={(e) => {
                          const trimmed = e.target.value.trim();
                          const match = savedVoices.find((s) => s.voiceId === trimmed);
                          void updateVoice({
                            fishReferenceId: trimmed,
                            fishVoiceTitle: match
                              ? match.name
                              : trimmed
                              ? `Voice Reference ${trimmed.slice(0, 8)}...`
                              : 'Default Fish Audio Voice (s2.1-pro-free)',
                          });
                        }}
                        placeholder="Paste reference_id..."
                        className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs font-mono text-zinc-100 placeholder:text-zinc-600"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/[0.06]">
                    <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={preserveProperNouns}
                        onChange={(e) => setPreserveProperNouns(e.target.checked)}
                        className="accent-violet-500"
                      />
                      Preserve names &amp; titles during translation
                    </label>
                    <span className="text-[11px] font-mono text-zinc-400">Speed: 1.00x</span>
                  </div>
                </div>

                {/* Saved Voice IDs Library CRUD */}
                <div className="p-3.5 rounded-xl bg-[#16161B] border border-white/[0.07] space-y-2.5">
                  <div className="text-xs font-semibold text-white">
                    Saved Voice IDs ({savedVoices.length})
                  </div>

                  {savedVoices.length > 0 && (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                      {savedVoices.map((sv) => {
                        const isSelected = voice.fishReferenceId === sv.voiceId;
                        const isEditing = editingSavedVoiceId === sv.id;

                        if (isEditing) {
                          return (
                            <div
                              key={sv.id}
                              className="p-2 rounded-lg bg-zinc-900 border border-violet-500/40 space-y-2"
                            >
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <input
                                  type="text"
                                  value={editVoiceName}
                                  onChange={(e) => setEditVoiceName(e.target.value)}
                                  placeholder="Voice name"
                                  className="bg-[#111115] border border-white/[0.08] rounded px-2 py-1 text-xs text-zinc-100"
                                />
                                <input
                                  type="text"
                                  value={editVoiceId}
                                  onChange={(e) => setEditVoiceId(e.target.value)}
                                  placeholder="Fish Audio Voice ID"
                                  className="bg-[#111115] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono text-zinc-100"
                                />
                              </div>
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingSavedVoiceId(null)}
                                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-300 cursor-pointer"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    busySavedVoice || !editVoiceName.trim() || !editVoiceId.trim()
                                  }
                                  onClick={() => void handleSaveEditedSavedVoice(sv.id)}
                                  className="px-2.5 py-1 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-[11px] font-semibold text-white flex items-center gap-1 cursor-pointer"
                                >
                                  <Check className="w-3 h-3" />
                                  Save
                                </button>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={sv.id}
                            className={`px-2.5 py-1.5 rounded-lg border flex items-center justify-between gap-2 text-xs ${
                              isSelected
                                ? 'bg-violet-600/15 border-violet-500/50 text-white'
                                : 'bg-zinc-900/70 border-white/[0.06] text-zinc-300'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => void handleUseSavedVoice(sv)}
                              className="flex-1 text-left min-w-0 cursor-pointer"
                            >
                              <div className="font-medium truncate flex items-center gap-1.5">
                                <span>{sv.name}</span>
                                {sv.isDefault && (
                                  <span className="text-[10px] font-mono text-amber-300">
                                    Default
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] font-mono text-zinc-500 truncate">
                                {sv.voiceId}
                              </div>
                            </button>

                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => void handleSetDefaultSavedVoice(sv)}
                                title="Set as default voice"
                                className={`p-1 rounded hover:bg-zinc-800 cursor-pointer ${
                                  sv.isDefault
                                    ? 'text-amber-400'
                                    : 'text-zinc-500 hover:text-amber-300'
                                }`}
                              >
                                <Star
                                  className={`w-3.5 h-3.5 ${sv.isDefault ? 'fill-amber-400' : ''}`}
                                />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingSavedVoiceId(sv.id);
                                  setEditVoiceName(sv.name);
                                  setEditVoiceId(sv.voiceId);
                                }}
                                title="Edit saved voice"
                                className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDeleteSavedVoice(sv)}
                                title="Delete saved voice"
                                className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <form
                    onSubmit={handleSaveFishVoice}
                    className="pt-2 border-t border-white/[0.06] space-y-2"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={newVoiceName}
                        onChange={(e) => setNewVoiceName(e.target.value)}
                        placeholder="Custom voice name"
                        className="bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500"
                      />
                      <input
                        type="text"
                        value={newVoiceId}
                        onChange={(e) => setNewVoiceId(e.target.value)}
                        placeholder="Fish voiceId"
                        className="bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs font-mono text-zinc-100 placeholder:text-zinc-500"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={setAsDefaultOnSave}
                          onChange={(e) => setSetAsDefaultOnSave(e.target.checked)}
                          className="accent-violet-500"
                        />
                        Default for new projects
                      </label>
                      <button
                        type="submit"
                        disabled={busySavedVoice || !newVoiceName.trim() || !newVoiceId.trim()}
                        className="px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Save Voice
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: 1. Translation -> 2. Voice & Audio -> 3. Segments */}
        <div className="xl:col-span-7 space-y-3.5">
          {/* Step 1: Translation */}
          <section className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                <Languages className="w-4 h-4 text-violet-400" />
                1. Translation
              </h2>

              <div className="flex items-center bg-zinc-900 border border-white/[0.08] rounded-lg p-0.5">
                <button
                  type="button"
                  onClick={() => setTranslationMode('auto')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    translationMode === 'auto'
                      ? 'bg-violet-600 text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Auto
                </button>
                <button
                  type="button"
                  onClick={() => setTranslationMode('external-gemini')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    translationMode === 'external-gemini'
                      ? 'bg-violet-600 text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  External Gemini
                </button>
              </div>
            </div>

            {translationMode === 'external-gemini' ? (
              <ExternalGeminiTranslatorPanel
                project={project}
                onProjectUpdated={onProjectUpdated}
                sourceLanguage={sourceLanguage}
                targetLanguage={targetLanguage}
                onChangeTargetLanguage={(nextLang) => {
                  setTargetLanguage(nextLang);
                  void updateVoice({ targetLanguage: nextLang });
                }}
                preserveProperNouns={preserveProperNouns}
                onChangePreserveProperNouns={setPreserveProperNouns}
                allowedTargetLanguages={DUB_TARGET_LANGUAGES}
                focusAudioOverflowSignal={focusAudioOverflowSignal}
                onApprovedSuccess={(count, lang) => {
                  setStatusMsg(`Approved ${count} translated segment(s) (${lang}).`);
                }}
              />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="text-[11px] text-zinc-400">Source Language</label>
                    <select
                      value={sourceLanguage}
                      onChange={(e) => setSourceLanguage(e.target.value)}
                      className="mt-1 w-full bg-[#18181D] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-zinc-100"
                    >
                      {SOURCE_LANGUAGES.map((l) => (
                        <option key={l} value={l}>
                          {l === 'Auto' ? 'Auto-Detect' : l}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] text-zinc-400">Target Language</label>
                    <select
                      value={targetLanguage}
                      onChange={(e) => {
                        const nextLang = e.target.value as SupportedLanguage;
                        setTargetLanguage(nextLang);
                        void updateVoice({ targetLanguage: nextLang });
                      }}
                      className="mt-1 w-full bg-[#18181D] border border-white/[0.08] rounded-lg px-2.5 py-2 text-xs text-zinc-100"
                    >
                      {DUB_TARGET_LANGUAGES.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={handleTranscribeFish}
                    disabled={!project.sourceVideoUrl || busyTranscribe}
                    className="min-h-[38px] py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {busyTranscribe ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Mic className="w-3.5 h-3.5 text-violet-400" />
                    )}
                    {busyTranscribe ? 'Transcribing...' : 'Transcribe Audio'}
                  </button>

                  <button
                    type="button"
                    onClick={handleTranslate}
                    disabled={project.captions.length === 0 || busyTranslate}
                    className="min-h-[38px] py-2 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {busyTranslate ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="w-3.5 h-3.5 text-violet-400" />
                    )}
                    {busyTranslate ? 'Translating...' : `Translate to ${targetLanguage}`}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Step 2: Voice & Audio Generation */}
          <section className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-violet-400" />
                2. Voice &amp; Audio Generation
              </h2>

              <button
                type="button"
                onClick={() => setVoiceBrowserOpen((v) => !v)}
                className="text-xs font-medium text-violet-300 hover:text-violet-200 flex items-center gap-1 cursor-pointer"
              >
                <Search className="w-3.5 h-3.5" />
                <span>{voiceBrowserOpen ? 'Hide Voice Catalog' : 'Browse Voices'}</span>
              </button>
            </div>

            {/* Voice Selector Component */}
            <div className="space-y-3">
              <NarratorSelector
                savedVoices={savedVoices}
                catalogVoices={voices}
                selectedVoiceId={voice.fishReferenceId}
                selectedVoiceTitle={voice.fishVoiceTitle}
                onSelectVoice={(voiceId, voiceTitle) => {
                  void updateVoice({
                    fishReferenceId: voiceId,
                    fishVoiceTitle: voiceTitle,
                  });
                }}
                onOpenSettings={() => onNavigate?.('settings')}
              />

              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={handlePreviewVoice}
                  disabled={busyPreview}
                  className="min-h-[38px] px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-medium text-zinc-100 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  {busyPreview ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5 text-violet-400" />
                  )}
                  <span>Preview</span>
                </button>

                <button
                  type="button"
                  onClick={handleGenerateDub}
                  disabled={isDubGenerating || project.captions.length === 0}
                  className="min-h-[38px] px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer"
                >
                  {isDubGenerating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Mic className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {isDubGenerating
                      ? `Generating (${Math.round(activeDubJob?.progress || 0)}%)...`
                      : 'Generate Voice'}
                  </span>
                </button>
              </div>
            </div>

            {/* Expandable Fish Audio Catalog Browser */}
            {voiceBrowserOpen && (
              <div className="p-3 rounded-lg bg-[#16161B] border border-white/[0.07] space-y-2.5">
                <div className="flex flex-wrap gap-2">
                  <div className="relative flex-1 min-w-[160px]">
                    <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={voiceQuery}
                      onChange={(e) => setVoiceQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void loadFishVoices({ q: voiceQuery });
                      }}
                      placeholder="Search Fish Audio voices..."
                      className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500"
                    />
                  </div>

                  <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-white/[0.08] text-[11px] text-zinc-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selfVoicesOnly}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSelfVoicesOnly(checked);
                        void loadFishVoices({ self: checked });
                      }}
                      className="accent-violet-500"
                    />
                    My Voices
                  </label>

                  <button
                    type="button"
                    onClick={() => void loadFishVoices()}
                    disabled={loadingVoices}
                    className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingVoices ? 'animate-spin' : ''}`} />
                    Fetch
                  </button>
                </div>

                {voicesError && (
                  <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-1.5">
                    {voicesError}
                  </div>
                )}

                {voices.length > 0 && (
                  <div className="max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1.5 pr-1">
                    <button
                      type="button"
                      onClick={() =>
                        void updateVoice({
                          fishReferenceId: '',
                          fishVoiceTitle: 'Default Fish Audio Voice (s2.1-pro-free)',
                        })
                      }
                      className={`text-left p-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                        !voice.fishReferenceId
                          ? 'bg-violet-600/20 border-violet-500/60 text-white'
                          : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:border-white/20'
                      }`}
                    >
                      <div className="font-medium truncate">Default Neutral Narrator</div>
                      <div className="text-[10px] text-zinc-500 font-mono">Built-in</div>
                    </button>

                    {voices.map((v) => {
                      const selected = voice.fishReferenceId === v.id;
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() =>
                            void updateVoice({
                              fishReferenceId: v.id,
                              fishVoiceTitle: v.title,
                            })
                          }
                          className={`text-left p-2 rounded-lg border text-xs transition-colors cursor-pointer ${
                            selected
                              ? 'bg-violet-600/20 border-violet-500/60 text-white'
                              : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:border-white/20'
                          }`}
                        >
                          <div className="font-medium truncate">{v.title}</div>
                          <div className="text-[10px] text-zinc-500 truncate">
                            {v.author} {v.languages.length > 0 ? `· ${v.languages.join(', ')}` : ''}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Generation Progress */}
            {activeDubJob && (
              <div className="space-y-1">
                <div className="flex justify-between gap-2 text-[11px] font-mono text-zinc-400">
                  <span className="truncate">{activeDubJob.stage}</span>
                  <span className="shrink-0">
                    {Math.round(activeDubJob.progress)}%
                    {activeDubJob.etaSeconds !== null && activeDubJob.etaSeconds > 0
                      ? ` · ~${activeDubJob.etaSeconds}s`
                      : ''}
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      activeDubJob.status === 'failed'
                        ? 'bg-red-500'
                        : activeDubJob.status === 'completed'
                        ? 'bg-emerald-500'
                        : 'bg-violet-500'
                    }`}
                    style={{ width: `${activeDubJob.progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Conditional Selective Regeneration Prompt */}
            {pendingRegenIds.length > 0 && (
              <div className="p-2.5 rounded-lg bg-violet-500/10 border border-violet-500/35 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-violet-200">
                  {pendingRegenIds.length} edited segment(s) need audio regeneration.
                </span>
                <button
                  type="button"
                  onClick={() => void handleRegenerateSelectedSegments(pendingRegenIds)}
                  disabled={busyRegenSegments}
                  className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  {busyRegenSegments ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  Regenerate ({pendingRegenIds.length})
                </button>
              </div>
            )}

            {/* Conditional Audio Overflow Fix Banner */}
            {syncWarnings.length > 0 && (
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-amber-200">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>
                    {syncWarnings.length} segment{syncWarnings.length === 1 ? '' : 's'} exceed slot duration
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTranslationMode('external-gemini');
                      setFocusAudioOverflowSignal((n) => n + 1);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-[11px] font-semibold text-amber-100 flex items-center gap-1 cursor-pointer"
                  >
                    <Sparkles className="w-3 h-3 text-amber-300" />
                    Shorten in Gemini
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleRegenerateSelectedSegments(
                        syncWarnings.map((w) => w.clip.segmentId)
                      )
                    }
                    disabled={busyRegenSegments}
                    className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/[0.08] text-[11px] font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 ${busyRegenSegments ? 'animate-spin' : ''}`} />
                    Regenerate ({syncWarnings.length})
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Step 3: Segments */}
          <section className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-display font-semibold text-white">
                3. Segments ({project.captions.length})
              </h2>
              <button
                type="button"
                onClick={addSegment}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Segment
              </button>
            </div>

            {project.captions.length === 0 ? (
              <div className="py-8 text-center space-y-2 rounded-lg bg-[#09090B] border border-white/[0.06]">
                <Mic className="w-5 h-5 text-zinc-600 mx-auto" />
                <div className="text-xs font-medium text-zinc-300">No Segments Yet</div>
                <p className="text-[11px] text-zinc-500">
                  Transcribe audio or add a segment to begin.
                </p>
              </div>
            ) : (
              <div className="max-h-[440px] overflow-y-auto space-y-2 pr-1">
                {project.captions.map((seg, idx) => {
                  const isActive = currentTime >= seg.start && currentTime <= seg.end;
                  const segClip = voice.generatedClips?.find((c) => c.segmentId === seg.id);
                  const segSync = voice.syncPlan?.segments?.find((s) => s.segmentId === seg.id);
                  const segSlot = segClip?.slotDuration ?? Math.max(0.2, seg.end - seg.start);
                  const segOverflow = segClip
                    ? segClip.overflowSeconds ??
                      Math.max(0, Math.round((segClip.duration - segSlot) * 100) / 100)
                    : 0;
                  const hasConflict = Boolean(segSync?.conflict);

                  return (
                    <div
                      key={seg.id}
                      className={`p-3 rounded-lg border space-y-2 ${
                        isActive
                          ? 'bg-violet-950/20 border-violet-500/40'
                          : hasConflict || (!segSync && segOverflow > 0.15)
                          ? 'bg-amber-950/15 border-amber-500/35'
                          : 'bg-[#18181D] border-white/[0.06]'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onSeek(segSync ? segSync.syncedStart : seg.start)}
                            className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-mono text-violet-300 cursor-pointer"
                          >
                            #{idx + 1} · {formatTimecode(seg.start)}
                          </button>

                          {segClip?.audioUrl && (
                            <button
                              type="button"
                              onClick={() =>
                                toggleSegmentAudioPreview(seg.id, segClip.audioUrl)
                              }
                              className={`px-2 py-0.5 rounded text-[11px] font-medium flex items-center gap-1 cursor-pointer border ${
                                playingSegmentId === seg.id
                                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200'
                                  : 'bg-zinc-800 hover:bg-zinc-700 border-white/[0.06] text-zinc-200'
                              }`}
                            >
                              <Play className="w-2.5 h-2.5" />
                              {playingSegmentId === seg.id ? 'Stop' : 'Play'}
                            </button>
                          )}

                          {seg.speaker && (
                            <span className="text-[11px] text-zinc-400">{seg.speaker}</span>
                          )}

                          {segClip ? (
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                hasConflict || segOverflow > 0.15
                                  ? 'bg-amber-500/15 text-amber-300'
                                  : 'bg-emerald-500/15 text-emerald-300'
                              }`}
                            >
                              {segClip.duration.toFixed(1)}s audio
                            </span>
                          ) : (
                            <span className="text-[10px] font-mono text-zinc-500">No audio</span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            step={0.1}
                            min={0}
                            value={seg.start}
                            onChange={(e) =>
                              updateSegment(seg.id, {
                                start: Math.max(0, Number(e.target.value)),
                              })
                            }
                            aria-label="Segment start seconds"
                            className="w-15 bg-zinc-900 border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200"
                          />
                          <span className="text-[10px] text-zinc-500">–</span>
                          <input
                            type="number"
                            step={0.1}
                            min={0}
                            value={seg.end}
                            onChange={(e) =>
                              updateSegment(seg.id, {
                                end: Math.max(seg.start + 0.2, Number(e.target.value)),
                              })
                            }
                            aria-label="Segment end seconds"
                            className="w-15 bg-zinc-900 border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200"
                          />
                          <button
                            type="button"
                            onClick={() => removeSegment(seg.id)}
                            className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                            aria-label="Delete segment"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <textarea
                          rows={2}
                          value={seg.text}
                          onChange={(e) => updateSegment(seg.id, { text: e.target.value })}
                          placeholder="Original line..."
                          className="w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100 resize-none"
                        />
                        <textarea
                          rows={2}
                          value={seg.translatedText || ''}
                          onChange={(e) =>
                            updateSegment(seg.id, { translatedText: e.target.value })
                          }
                          placeholder={`${targetLanguage} script...`}
                          className="w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100 resize-none"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

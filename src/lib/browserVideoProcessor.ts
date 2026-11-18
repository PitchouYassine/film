import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { FilmstripFrame, ProjectAudioWaveforms, VideoMetadata } from '../types/studio';
import { storeBlobAsset } from './browserStorage';

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadingPromise: Promise<FFmpeg> | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance && ffmpegInstance.loaded) {
    return ffmpegInstance;
  }
  if (ffmpegLoadingPromise) {
    return ffmpegLoadingPromise;
  }

  ffmpegLoadingPromise = (async () => {
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return ffmpegLoadingPromise;
}

export function createFallbackThumbnail(time: number, duration: number, width = 160, height = 90): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Cinematic dark gradient
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, '#1c1917');
      grad.addColorStop(0.5, '#0f172a');
      grad.addColorStop(1, '#09090b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // Filmstrip perforation marks
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      for (let x = 6; x < width; x += 18) {
        ctx.fillRect(x, 3, 8, 5);
        ctx.fillRect(x, height - 8, 8, 5);
      }

      // Outer border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

      // Timecode stamp
      ctx.fillStyle = 'rgba(244, 244, 245, 0.85)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const m = Math.floor(time / 60);
      const s = Math.floor(time % 60);
      ctx.fillText(`${m}:${s.toString().padStart(2, '0')}`, width / 2, height / 2 + 4);
    }
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" fill="%2318181b"/><text x="80" y="50" fill="%2371717a" font-size="12" text-anchor="middle">Frame</text></svg>';
  }
}

export async function analyzeVideoFileInBrowser(file: File): Promise<{ metadata: VideoMetadata; duration: number }> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    (video as any).defaultMuted = true;
    video.playsInline = true;
    const objectUrl = URL.createObjectURL(file);

    let completed = false;
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('loadeddata', onMetadata);
      video.removeEventListener('error', onError);
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // Ignore
      }
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Ignore
      }
    };

    const finish = (duration: number, width: number, height: number) => {
      if (completed) return;
      completed = true;
      cleanup();

      const fps = 30;
      const fileSize = file.size;
      const validDuration = duration > 0 ? duration : 30;

      const metadata: VideoMetadata = {
        duration: validDuration,
        width: width || 1920,
        height: height || 1080,
        fps,
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitrate: Math.round((fileSize * 8) / validDuration),
        fileSize,
        hasAudio: true,
        formatName: file.type || 'mp4',
      };

      console.log(`[BrowserVideoProcessor] Video metadata loaded: duration=${validDuration.toFixed(2)}s, dimensions=${metadata.width}x${metadata.height}`);
      resolve({ metadata, duration: validDuration });
    };

    const onMetadata = () => {
      const dur = video.duration && isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const w = video.videoWidth || 1920;
      const h = video.videoHeight || 1080;
      finish(dur, w, h);
    };

    const onError = () => {
      console.warn('[BrowserVideoProcessor] Video element error during metadata analysis, falling back to estimated metadata');
      finish(30, 1920, 1080);
    };

    const timeoutTimer = setTimeout(() => {
      console.warn('[BrowserVideoProcessor] Video metadata analysis timed out (8s), falling back to available properties');
      const dur = video.duration && isFinite(video.duration) && video.duration > 0 ? video.duration : 30;
      finish(dur, video.videoWidth || 1920, video.videoHeight || 1080);
    }, 8000);

    video.addEventListener('loadedmetadata', onMetadata, { once: true });
    video.addEventListener('loadeddata', onMetadata, { once: true });
    video.addEventListener('error', onError, { once: true });

    video.src = objectUrl;
    video.load();
  });
}

export async function generateFilmstripInBrowser(
  file: File,
  frameCount = 12,
  knownDuration?: number
): Promise<{ frames: FilmstripFrame[]; duration: number }> {
  const targetCount = Math.min(12, Math.max(1, frameCount));
  const objectUrl = URL.createObjectURL(file);

  const video = document.createElement('video');
  video.muted = true;
  (video as any).defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';

  let duration = knownDuration || 0;
  let videoWidth = 160;
  let videoHeight = 90;

  // Step 1: Wait for video metadata with strict timeout handling
  try {
    await new Promise<void>((resolve) => {
      let resolved = false;
      const onReady = () => {
        if (resolved) return;
        resolved = true;
        cleanEvents();
        resolve();
      };

      const onError = () => {
        if (resolved) return;
        resolved = true;
        cleanEvents();
        console.warn(`[FilmstripGenerator] Video element load error, will proceed with fallback`);
        resolve();
      };

      const timeoutTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanEvents();
        console.warn(`[FilmstripGenerator] Video metadata load timed out (8s), proceeding`);
        resolve();
      }, 8000);

      function cleanEvents() {
        clearTimeout(timeoutTimer);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('error', onError);
      }

      video.addEventListener('loadedmetadata', onReady, { once: true });
      video.addEventListener('loadeddata', onReady, { once: true });
      video.addEventListener('canplay', onReady, { once: true });
      video.addEventListener('error', onError, { once: true });

      video.src = objectUrl;
      video.load();
    });

    if (video.duration && isFinite(video.duration) && video.duration > 0) {
      duration = video.duration;
    } else if (!duration || duration <= 0) {
      duration = 10;
    }

    videoWidth = video.videoWidth || 1920;
    videoHeight = video.videoHeight || 1080;

    console.log(`[FilmstripGenerator] Video metadata loaded: duration=${duration.toFixed(2)}s, dimensions=${videoWidth}x${videoHeight}`);
    console.log(`[FilmstripGenerator] Video dimensions: ${videoWidth}x${videoHeight}, aspect ratio: ${(videoWidth / (videoHeight || 1)).toFixed(2)}`);
  } catch (err) {
    console.warn('[FilmstripGenerator] Exception during metadata preparation:', err);
    if (!duration || duration <= 0) duration = 10;
  }

  // Step 2: Prepare canvas for rendering
  const canvas = document.createElement('canvas');
  const aspect = videoWidth && videoHeight ? videoWidth / videoHeight : 16 / 9;
  canvas.width = 160;
  canvas.height = Math.max(40, Math.min(160, Math.round(160 / (aspect > 0.3 && aspect < 3.5 ? aspect : 16 / 9))));
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  // Step 3: Compute evenly spaced frame timestamps (avoiding exact 0.0s edge seek traps)
  const timestamps: number[] = [];
  if (targetCount === 1) {
    timestamps.push(Number(Math.max(0.05, duration * 0.1).toFixed(3)));
  } else {
    const step = duration / targetCount;
    for (let i = 0; i < targetCount; i++) {
      const t = Math.max(0.05, Math.min(duration - 0.05, i * step + step * 0.2));
      timestamps.push(Number(t.toFixed(3)));
    }
  }

  // Step 4: Seek and capture helper with timeout, retry, and requestVideoFrameCallback
  async function seekAndCapture(timestamp: number, frameIndex: number): Promise<string> {
    console.log(`[FilmstripGenerator] Current frame timestamp: ${timestamp.toFixed(2)}s (frame ${frameIndex + 1}/${targetCount})`);

    const doSeek = (targetTime: number) =>
      new Promise<boolean>((resolveSeek) => {
        // If already positioned within 0.03s and ready to render
        if (Math.abs(video.currentTime - targetTime) < 0.03 && video.readyState >= 2) {
          resolveSeek(true);
          return;
        }

        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          clean();
          console.warn(`[FilmstripGenerator] Seek timeout for frame ${frameIndex + 1} at ${targetTime}s`);
          resolveSeek(false);
        }, 2200);

        const onSeeked = () => {
          if (done) return;
          done = true;
          clean();
          console.log(`[FilmstripGenerator] Seek completion: frame ${frameIndex + 1}/${targetCount} at ${targetTime}s (video.currentTime=${video.currentTime.toFixed(2)}s)`);
          resolveSeek(true);
        };

        function clean() {
          clearTimeout(timer);
          video.removeEventListener('seeked', onSeeked);
        }

        video.addEventListener('seeked', onSeeked, { once: true });
        try {
          video.currentTime = targetTime;
        } catch (seekErr) {
          if (!done) {
            done = true;
            clean();
            console.warn(`[FilmstripGenerator] Seek error setting currentTime:`, seekErr);
            resolveSeek(false);
          }
        }
      });

    // Attempt seek with 1 retry on timeout
    let seekSuccess = await doSeek(timestamp);
    if (!seekSuccess) {
      console.warn(`[FilmstripGenerator] Retrying seek for frame ${frameIndex + 1}...`);
      seekSuccess = await doSeek(timestamp);
    }

    // Step 5: Wait for frame rendering using requestVideoFrameCallback if supported, else RAF
    if ('requestVideoFrameCallback' in video && typeof (video as any).requestVideoFrameCallback === 'function') {
      await new Promise<void>((resolveRfc) => {
        let rfcDone = false;
        const rfcTimer = setTimeout(() => {
          if (!rfcDone) {
            rfcDone = true;
            resolveRfc();
          }
        }, 150);
        try {
          (video as any).requestVideoFrameCallback(() => {
            if (!rfcDone) {
              rfcDone = true;
              clearTimeout(rfcTimer);
              resolveRfc();
            }
          });
        } catch {
          clearTimeout(rfcTimer);
          resolveRfc();
        }
      });
    } else {
      await new Promise<void>((resolveRaf) => requestAnimationFrame(() => resolveRaf()));
    }

    // Step 6: Canvas capture
    if (!ctx) {
      console.warn(`[FilmstripGenerator] Canvas capture failure: 2D context unavailable for frame ${frameIndex + 1}`);
      return createFallbackThumbnail(timestamp, duration, canvas.width, canvas.height);
    }

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
      if (dataUrl && dataUrl.length > 50) {
        console.log(`[FilmstripGenerator] Canvas capture success for frame ${frameIndex + 1} (${canvas.width}x${canvas.height})`);
        return dataUrl;
      } else {
        throw new Error('Empty dataUrl returned from canvas');
      }
    } catch (captureErr) {
      console.warn(`[FilmstripGenerator] Canvas capture failure for frame ${frameIndex + 1}:`, captureErr);
      return createFallbackThumbnail(timestamp, duration, canvas.width, canvas.height);
    }
  }

  // Step 7: Sequential frame extraction loop
  const frames: FilmstripFrame[] = [];
  try {
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const url = await seekAndCapture(ts, i);
      frames.push({
        url,
        time: ts,
      });
    }
  } catch (loopErr) {
    console.error('[FilmstripGenerator] Error during frame extraction loop:', loopErr);
  } finally {
    // Step 8: Release all temporary resources
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    } catch {
      // Ignore
    }
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Ignore
    }
    canvas.width = 0;
    canvas.height = 0;
  }

  // Step 9: Guarantee frames are never empty
  if (frames.length === 0) {
    console.warn('[FilmstripGenerator] 0 frames generated by video element, filling with fallback thumbnails');
    for (const ts of timestamps) {
      frames.push({
        url: createFallbackThumbnail(ts, duration),
        time: ts,
      });
    }
  }

  console.log(`[FilmstripGenerator] Total frames generated: ${frames.length}/${targetCount}`);
  return { frames, duration };
}

export async function extractAudioWaveformInBrowser(file: File, bars = 120): Promise<ProjectAudioWaveforms> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const rawData = audioBuffer.getChannelData(0);
    const blockSz = Math.floor(rawData.length / bars);
    const peaks: number[] = [];

    for (let i = 0; i < bars; i++) {
      let sum = 0;
      const start = i * blockSz;
      const end = Math.min(rawData.length, start + blockSz);
      for (let j = start; j < end; j++) {
        sum += Math.abs(rawData[j]);
      }
      const avg = sum / (end - start || 1);
      peaks.push(Number(Math.min(1, Math.max(0.05, avg * 2.5)).toFixed(3)));
    }

    if (audioCtx.state !== 'closed') {
      await audioCtx.close();
    }

    return {
      orig: peaks,
      dub: [],
      dubClips: {},
      bgm: [],
      sfx: [],
    };
  } catch {
    const fallbackPeaks = Array.from({ length: bars }, () => Number((0.2 + Math.random() * 0.6).toFixed(2)));
    return {
      orig: fallbackPeaks,
      dub: [],
      dubClips: {},
      bgm: [],
      sfx: [],
    };
  }
}

export async function processVideoUploadInBrowser(
  file: File,
  onProgress: (pct: number, stage: string) => void
): Promise<{ sourceVideoUrl: string; metadata: VideoMetadata; duration: number; filmstrip: FilmstripFrame[]; waveforms: ProjectAudioWaveforms }> {
  onProgress(10, 'Reading video file in browser...');
  const { metadata, duration } = await analyzeVideoFileInBrowser(file);

  onProgress(35, 'Storing video locally in browser (IndexedDB)...');
  const sourceVideoUrl = await storeBlobAsset(`video_${Date.now()}_${file.name}`, file);

  onProgress(60, 'Generating visual filmstrip frames...');
  let filmstrip: FilmstripFrame[] = [];
  try {
    const res = await generateFilmstripInBrowser(file, 12, duration);
    filmstrip = res.frames;
  } catch (err) {
    console.warn('[BrowserVideoProcessor] Filmstrip generation failed, continuing with fallback thumbnails:', err);
    filmstrip = Array.from({ length: 8 }, (_, i) => {
      const t = Number(((i / 8) * duration).toFixed(2));
      return {
        url: createFallbackThumbnail(t, duration),
        time: t,
      };
    });
  }

  onProgress(85, 'Extracting audio waveform peaks...');
  const waveforms = await extractAudioWaveformInBrowser(file, 140);

  onProgress(100, 'Video ready for studio editing');
  console.log(`[BrowserVideoProcessor] Final import completion for ${file.name} (duration: ${duration.toFixed(2)}s, frames: ${filmstrip.length}, size: ${(file.size / 1024 / 1024).toFixed(2)} MB)`);

  return {
    sourceVideoUrl,
    metadata,
    duration,
    filmstrip,
    waveforms,
  };
}

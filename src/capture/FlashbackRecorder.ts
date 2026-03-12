// src/capture/FlashbackRecorder.ts
// =================================
//
// FlashbackRecorder
// -----------------
//
// This module owns the recording session and acts as the bridge between
// MediaRecorder output and Flashback's continuous DVR capture pipeline.
//
// Architecture role
// -----------------
// FlashbackRecorder is part of the capture layer.
//
// It is responsible for:
// - receiving blobs produced by MediaRecorder
// - assigning monotonic sequence order to live chunks
// - pushing incoming chunks into the capture buffer (DoubleRingBuffer)
// - exposing a live chunk stream to the continuous DVR consumer
// - keeping basic recording/session state
// - exposing basic capture stats and init readiness
//
// Typical flow
// ------------
// MediaRecorder dataavailable
//    ↓
// FlashbackRecorder
//    ├─ pushChunk() into DoubleRingBuffer
//    └─ emit live chunk to DVR listener
//
// Key guarantees
// --------------
// - Incoming chunks are always persisted into the capture buffer first.
// - Live chunk order is monotonic within a recording session.
// - The recorder is a capture bridge, not a replay policy engine.
// - Continuous DVR consumers receive a stable, ordered live feed.
//
// Responsibilities
// ----------------
// This module is responsible ONLY for:
//
// - recording lifecycle (start / stop / restart / clear)
// - ingesting MediaRecorder blobs
// - forwarding chunks to DoubleRingBuffer
// - keeping mime type / timeslice / basic counters
// - exposing a live onChunk listener for the DVR pipeline
// - reporting basic capture/debug state
//
// Non-responsibilities
// --------------------
// This module MUST NOT:
//
// - decide which replay source should be used
// - build final replay snapshots
// - select GOP-safe replay windows
// - perform playback seeks
// - interact with HTMLVideoElement or UI
// - implement replay session lifecycle
// - implement MediaSource / SourceBuffer logic
//
// Those responsibilities belong to:
//
//   SnapshotBuilder
//   ReplaySessionManager
//   Playback layer
//
// Design rule
// -----------
// FlashbackRecorder must remain a capture-oriented coordinator.
// If replay selection or playback policy starts appearing here,
// the architecture is being violated.
//
// Invariants
// ----------
// - every accepted chunk is stored in DoubleRingBuffer before any live forwarding
// - live chunk seq is monotonic within one recording session
// - clear() resets recorder session state completely
// - start() begins a new recording session with fresh per-session counters
// - this module never decides replay validity or replay fallback policy

import { DoubleRingBuffer, type DoubleRingDebugState } from "./DoubleRingBuffer";
import { ChunkManager } from "./ChunkManager";

export type StartOptions = {
  reset?: boolean;
};

export type FlashbackStats = {
  isRecording: boolean;
  mimeType: string;
  chunkCount: number;
  bufferedMs: number;
  totalBytes: number;
  avgBytesPerSec: number;
  lastChunkBytes: number;
  hasInitBlob: boolean;
  initBlobBytes: number;
};

export type FlashbackRecorderDebugState = {
  isRecording: boolean;
  mimeType: string;
  liveChunkSeq: number;
  lastTimesliceMs: number;
  hasListener: boolean;
  ring: DoubleRingDebugState;
};

export type OnUnexpectedStopCallback = () => void;

export type OnChunkCallback = (
  blob: Blob,
  perfNowMs: number,
  info?: {
    mimeType: string;
    timesliceMs: number;
    durationMs?: number;
    seq: number;
    isInit?: boolean;
  }
) => void;

type RecorderLike = {
  state?: string;
  start: (timeslice?: number) => void;
  stop: () => void;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: (() => void) | null;
  onerror?: ((event: Event) => void) | null;
};

function clampInt(n: number, min: number, max: number): number {
  const x = Math.trunc(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safePerfNow(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function pickDefaultMimeType(): string {
  return "video/webm";
}

function normalizeMimeType(value: unknown): string {
  return String(value || "").trim();
}

export class FlashbackRecorder {
  private readonly debug: boolean;
  private readonly maxBufferMs: number;
  private readonly doubleRing: DoubleRingBuffer;

  private mediaRecorder: RecorderLike | null = null;
  private stream: MediaStream | null = null;

  private mimeType = "";
  private onChunkListener: OnChunkCallback | null = null;
  private onUnexpectedStop: OnUnexpectedStopCallback | null = null;

  private liveChunkSeq = 0;
  private isStopping = false;
  private lastTimesliceMs = 1200;
  private dvrInitEmitted = false;

  constructor(config: { maxBufferMs: number; debug?: boolean }) {
    this.maxBufferMs = Math.max(1000, Math.trunc(Number(config.maxBufferMs) || 0));
    this.debug = !!config.debug;
    this.doubleRing = new DoubleRingBuffer(this.maxBufferMs, this.debug);
  }

  public isRecording(): boolean {
    return !!this.mediaRecorder && this.mediaRecorder.state === "recording";
  }

  public getMimeType(): string {
    return (this.mimeType || "").trim() || pickDefaultMimeType();
  }

  public setOnUnexpectedStop(fn: OnUnexpectedStopCallback | null): void {
    this.onUnexpectedStop = fn;
  }

  public setOnChunkListener(fn: OnChunkCallback | null): void {
    this.onChunkListener = fn;
  }

  public getInitBlob(): Blob | null {
    const active = this.doubleRing.getActiveManager().getInitCandidate();
    const sealed = this.doubleRing.getSealedManager().getInitCandidate();

    if (sealed && !active) return sealed;
    if (active && !sealed) return active;
    if (!active && !sealed) return null;

    const activeSize = active?.size ?? 0;
    const sealedSize = sealed?.size ?? 0;

    if (sealedSize >= activeSize) return sealed || active || null;
    return active || sealed || null;
  }

  public isInitReady(): boolean {
    return !!this.getInitBlob();
  }

  public getBufferedMs(): number {
    const activeMs = Number(this.doubleRing.getActiveManager().getBufferedMs()) || 0;
    const sealedMs = Number(this.doubleRing.getSealedManager().getBufferedMs()) || 0;
    return Math.max(0, activeMs, sealedMs);
  }

  public getStats(): FlashbackStats {
    const activeMgr = this.doubleRing.getActiveManager();
    const chunks = activeMgr.getChunks();
    const lastChunkBytes = chunks.length > 0 ? chunks[chunks.length - 1].bytes : 0;

    const initBlob = this.getInitBlob();
    const initBlobBytes = initBlob?.size ?? 0;

    const totalBytesChunksOnly = activeMgr.getTotalBytes();
    const totalBytes = totalBytesChunksOnly + initBlobBytes;

    const bufferedMs = this.getBufferedMs();
    const bufferedSec = bufferedMs > 0 ? bufferedMs / 1000 : 0;
    const avgBytesPerSec = bufferedSec > 0 ? Math.floor(totalBytes / bufferedSec) : 0;

    return {
      isRecording: this.isRecording(),
      mimeType: this.getMimeType(),
      chunkCount: chunks.length,
      bufferedMs,
      totalBytes,
      avgBytesPerSec,
      lastChunkBytes,
      hasInitBlob: !!initBlob,
      initBlobBytes,
    };
  }

  public getActiveManager(): ChunkManager {
    return this.doubleRing.getActiveManager();
  }

  public getSealedManager(): ChunkManager {
    return this.doubleRing.getSealedManager();
  }

  public sealSnapshot(reason: string): boolean {
    return this.doubleRing.swap(reason);
  }

  public lockSealed(ownerId: string): boolean {
    return this.doubleRing.lockSealed(ownerId);
  }

  public unlockSealed(ownerId: string): boolean {
    return this.doubleRing.unlockSealed(ownerId);
  }

  public getDoubleRingDebugState(): DoubleRingDebugState {
    return this.doubleRing.getDebugState();
  }

  public getDebugState(): FlashbackRecorderDebugState {
    return {
      isRecording: this.isRecording(),
      mimeType: this.getMimeType(),
      liveChunkSeq: this.liveChunkSeq,
      lastTimesliceMs: this.lastTimesliceMs,
      hasListener: !!this.onChunkListener,
      ring: this.doubleRing.getDebugState(),
    };
  }

  public clear(): void {
    this.doubleRing.clearAll();
    this.liveChunkSeq = 0;
    this.lastTimesliceMs = 1200;
    this.mimeType = "";
    this.isStopping = false;
    this.dvrInitEmitted = false;

    if (this.debug) {
      console.log("[Flashback][FlashbackRecorder] clear", {
        state: this.getDebugState(),
      });
    }
  }

  public start(stream: MediaStream, timesliceMs: number, opts?: StartOptions): void {
    if (this.isRecording()) {
      if (this.debug) {
        console.log("[Flashback][FlashbackRecorder] start ignored: already recording");
      }
      return;
    }

    const slice = clampInt(timesliceMs, 100, 5000);
    const reset = opts?.reset === true;

    if (reset) {
      this.clear();
    }

    this.stream = stream;
    this.lastTimesliceMs = slice;
    this.doubleRing.setLastTimesliceMs(slice);

    this.liveChunkSeq = 0;
    this.isStopping = false;
    this.mimeType = pickDefaultMimeType();
    this.dvrInitEmitted = false;

    const recorder = this.createMediaRecorder(stream, this.mimeType);
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      const blob = event?.data;
      if (!blob || blob.size <= 0) return;
      this.handleDataAvailable(blob, slice);
    };

    recorder.onstop = () => {
      const unexpected = !this.isStopping;
      this.mediaRecorder = null;

      if (this.debug) {
        console.log("[Flashback][FlashbackRecorder] stop event", {
          unexpected,
          state: this.getDebugState(),
        });
      }

      if (unexpected && this.onUnexpectedStop) {
        try {
          this.onUnexpectedStop();
        } catch {}
      }

      this.isStopping = false;
    };

    recorder.start(slice);

    if (this.debug) {
      console.log("[Flashback][FlashbackRecorder] started", {
        timesliceMs: slice,
        mimeType: this.mimeType,
        state: this.getDebugState(),
      });
    }
  }

  public stop(): void {
    if (!this.mediaRecorder) return;

    this.isStopping = true;

    try {
      this.mediaRecorder.stop();
    } catch {
      this.mediaRecorder = null;
      this.isStopping = false;
    }
  }

  public async stopAndWait(): Promise<void> {
    if (!this.mediaRecorder) return;

    const recorder = this.mediaRecorder;
    this.stop();

    const startedAt = safePerfNow();
    const timeoutMs = 3000;

    while (this.mediaRecorder === recorder) {
      if (safePerfNow() - startedAt > timeoutMs) {
        this.mediaRecorder = null;
        this.isStopping = false;
        break;
      }
      await sleepMs(25);
    }
  }

  public async restartSoft(
    stream: MediaStream,
    timesliceMs: number,
    opts?: { reset?: boolean; delayMs?: number }
  ): Promise<void> {
    const delayMs = clampInt(opts?.delayMs ?? 100, 0, 1000);
    const reset = opts?.reset === true;

    await this.stopAndWait();

    if (delayMs > 0) {
      await sleepMs(delayMs);
    }

    this.start(stream, timesliceMs, { reset });
  }

  private emitInitIfNeeded(
    perfNowMs: number,
    timesliceMs: number
  ): void {
    if (this.dvrInitEmitted) return;

    const listener = this.onChunkListener;
    if (!listener) return;

    const initBlob = this.getInitBlob();
    if (!initBlob || initBlob.size <= 0) return;

    try {
      const initMimeType =
        normalizeMimeType(initBlob.type) ||
        this.getMimeType();

      listener(initBlob, perfNowMs, {
        mimeType: initMimeType,
        timesliceMs,
        durationMs: timesliceMs,
        seq: 0,
        isInit: true,
      });

      this.dvrInitEmitted = true;

      if (this.debug) {
        console.log("[Flashback][FlashbackRecorder] init emitted", {
          size: initBlob.size,
          type: initBlob.type,
          effectiveMimeType: initMimeType,
          timesliceMs,
        });
      }
    } catch (error) {
      if (this.debug) {
        console.warn("[Flashback][FlashbackRecorder] init emit failed", {
          error: String(error),
          size: initBlob.size,
          type: initBlob.type,
        });
      }
    }
  }

  private handleDataAvailable(blob: Blob, timesliceMs: number): void {
    const now = safePerfNow();
    const seq = ++this.liveChunkSeq;

    this.doubleRing.pushChunk(blob, now);

    // If the recorder/blob gives us a more specific mime than the
    // bootstrap default, adopt it for downstream consumers.
    const blobMimeType = normalizeMimeType(blob.type);
    if (blobMimeType && blobMimeType !== this.mimeType) {
      this.mimeType = blobMimeType;
    }

    const listener = this.onChunkListener;
    if (listener) {
      this.emitInitIfNeeded(now, timesliceMs);

      try {
        listener(blob, now, {
          mimeType: this.getMimeType(),
          timesliceMs,
          durationMs: timesliceMs,
          seq,
          isInit: false,
        });
      } catch (error) {
        if (this.debug) {
          console.warn("[Flashback][FlashbackRecorder] onChunkListener failed", {
            error: String(error),
            seq,
            size: blob.size,
            type: blob.type,
          });
        }
      }
    }

    if (this.debug) {
      console.log("[Flashback][FlashbackRecorder] chunk ingested", {
        seq,
        bytes: blob.size,
        blobType: blob.type || null,
        effectiveMimeType: this.getMimeType(),
        timesliceMs,
        bufferedMs: this.getBufferedMs(),
        dvrInitEmitted: this.dvrInitEmitted,
      });
    }
  }

  private createMediaRecorder(stream: MediaStream, mimeType: string): RecorderLike {
    const RecorderCtor = (globalThis as unknown as {
      MediaRecorder?: new (stream: MediaStream, options?: MediaRecorderOptions) => RecorderLike;
    }).MediaRecorder;

    if (!RecorderCtor) {
      throw new Error("MediaRecorder is not available in this environment");
    }

    return new RecorderCtor(stream, {
      mimeType,
    });
  }
}
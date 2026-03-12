// src/dvr/ContinuousDvrEngine.ts
// ======================================================
//
// ContinuousDvrEngine
// -------------------
//
// This module owns a live MSE-backed DVR engine.
//
// It consumes a cleaned DVR chunk stream, attaches to a
// target HTMLVideoElement, and maintains a reusable
// MediaSource / SourceBuffer pipeline for live DVR-style
// playback/navigation.
//
// Architecture role
// -----------------
//
// ContinuousDvrEngine belongs to the **DVR / Playback
// boundary**, but its role is intentionally narrow.
//
// It exists ONLY for **live DVR engine behavior**,
// meaning:
//
// - keeping a live append pipeline
// - maintaining a buffered DVR window
// - exposing buffered navigation over that live window
//
// It does NOT represent the generic MSE playback path
// for replay snapshots.
//
// Very important boundary
// -----------------------
//
// This engine must not become a second general-purpose
// replay player.
//
// In this architecture:
//
// - `ContinuousDvrEngine` = live DVR engine
// - `MsePlayer`           = snapshot MSE playback
//
// Both use MediaSource / SourceBuffer, but they serve
// different roles.
//
// If future replay-snapshot logic starts being added here,
// this file will begin to overlap with `MsePlayer` and the
// architecture will start drifting back toward the old
// monolithic design.
//
// Design rule
// -----------
//
// ContinuousDvrEngine is a specialized live DVR engine.
//
// If page detection, replay policy, session ownership,
// snapshot assembly, fallback decisions, or generic replay
// playback starts appearing here, the architecture is
// being violated.
//
// Invariants
// ----------
//
// - at most one attached HTMLVideoElement is owned at a time
// - init is appended before media for each engine lifecycle
// - media append order is preserved
// - clear() resets queue/append state
// - detach() fully disconnects the current video from the engine
//

import {
  attachVideo,
  detachVideo,
  type ContinuousDvrAttachState,
} from "./ContinuousDvrEngine.attach";

import {
  normalizeMimeType,
  isGenericWebmMime,
} from "./ContinuousDvrEngine.mime";

import {
  flushBuffer,
  resetBufferedState,
  type BufferedRange,
  type ContinuousDvrBufferState,
} from "./ContinuousDvrEngine.buffer";

import {
  getBufferedRange as getBufferedRangeFromState,
  getPlayableDurationSec as getPlayableDurationSecFromState,
  seekBack as seekBackInState,
  seekToSec as seekToSecInState,
  waitForBufferedWindow as waitForBufferedWindowFromState,
  type ContinuousDvrNavigationState,
} from "./ContinuousDvrEngine.navigation";

export type { BufferedRange };

export type ContinuousDvrEngineOptions = {
  mimeType: string;
  maxQueue?: number;
  debug?: boolean;
};

export type ContinuousDvrEngineDebugState = {
  hasVideo: boolean;
  hasMediaSource: boolean;
  hasSourceBuffer: boolean;
  queuedCount: number;
  appendedCount: number;
  hasInitSegment: boolean;
  bufferedRange: BufferedRange | null;
  mimeType: string;
};

function isSameBlob(a: Blob | null | undefined, b: Blob | null | undefined): boolean {
  return !!a && !!b && a === b;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export class ContinuousDvrEngine {
  private mimeType: string;
  private readonly maxQueue: number;
  private readonly debug: boolean;

  private readonly endSafetyPadSec = 0.05;

  private video: HTMLVideoElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;

  private queue: Blob[] = [];
  private flushing = false;
  private resetting = false;
  private pendingAttach: boolean = false;

  private initSegment: Blob | null = null;
  private initAppended = false;
  private appendedCount = 0;
  private initSegmentGeneration: number = 0;

  private attachToken = 0;

  // Single-flight flush coordination:
  // - only one flush loop may run at a time
  // - if new blobs arrive while flushing, schedule one rerun
  private flushRequested = false;

  constructor(opts: ContinuousDvrEngineOptions) {
    this.mimeType = normalizeMimeType(opts.mimeType) || "video/webm";
    this.maxQueue = Math.max(1, Math.trunc(Number(opts.maxQueue) || 120));
    this.debug = !!opts.debug;
  }

  private log(...args: unknown[]): void {
    if (!this.debug) {
      return;
    }

    console.log("[Flashback][DvrEngine]", ...args);
  }

  private getAttachState(): ContinuousDvrAttachState {
    return {
      video: this.video,
      mediaSource: this.mediaSource,
      sourceBuffer: this.sourceBuffer,
      objectUrl: this.objectUrl,
    };
  }

  private applyAttachState(next: ContinuousDvrAttachState): void {
    this.video = next.video;
    this.mediaSource = next.mediaSource;
    this.sourceBuffer = next.sourceBuffer;
    this.objectUrl = next.objectUrl;
  }

  private getBufferState(): ContinuousDvrBufferState {
    return {
      mediaSource: this.mediaSource,
      sourceBuffer: this.sourceBuffer,
      video: this.video,

      queue: this.queue,
      flushing: this.flushing,
      resetting: this.resetting,

      initSegment: this.initSegment,
      initAppended: this.initAppended,
      appendedCount: this.appendedCount,
    };
  }

  /**
   * Apply ONLY the mutable buffer bookkeeping fields.
   *
   * Critical:
   * `mediaSource`, `sourceBuffer`, and `video` can change asynchronously
   * outside a flush snapshot (for example in `handleSourceOpen()`).
   *
   * If we blindly restore those references from an older snapshot we can
   * accidentally erase a freshly created SourceBuffer, which leaves the
   * engine stuck with:
   *
   * - hasSourceBuffer = false
   * - bufferedRange   = null
   * - video black
   */
  private applyMutableBufferState(next: ContinuousDvrBufferState): void {

    // ⚠️ DO NOT restore queue
    // queue may have been replaced during flush by handleInitBlob()
    // mutations (shift) already apply to the same reference

    // ⚠️ DO NOT restore initSegment
    // handleInitBlob may have replaced it during flush

    // restore lifecycle flags controlled by flush loop
    this.flushing = next.flushing;
    this.resetting = next.resetting;

    // restore init flags ONLY if initSegment didn't change
    if (this.initSegment === next.initSegment) {
      this.initAppended = next.initAppended;
      this.appendedCount = next.appendedCount;
    }

  }

  private getNavigationState(): ContinuousDvrNavigationState {
    return {
      video: this.video,
      sourceBuffer: this.sourceBuffer,
    };
  }

  public getMimeType(): string {
    return this.mimeType;
  }

  public setMimeType(nextMimeType: string): boolean {
    const normalizedNext = normalizeMimeType(nextMimeType);
    if (!normalizedNext) {
      return false;
    }

    if (normalizedNext === this.mimeType) {
      return false;
    }

    this.log("mimeType updated", {
      previousMimeType: this.mimeType,
      nextMimeType: normalizedNext,
    });

    this.mimeType = normalizedNext;
    return true;
  }

  public attach(video: HTMLVideoElement): void {
    if (typeof MediaSource === "undefined") {
      throw new Error("MediaSource not supported");
    }

    const normalizedMime = normalizeMimeType(this.mimeType) || "video/webm";
    const mimeSupported = MediaSource.isTypeSupported(normalizedMime);

    if (!mimeSupported && !isGenericWebmMime(normalizedMime)) {
      throw new Error(`Unsupported mime type: ${normalizedMime}`);
    }

    this.detach();

    const token = ++this.attachToken;

    const next = attachVideo({
      state: this.getAttachState(),
      video,
    });

    this.applyAttachState(next);

    if (this.mediaSource) {
      const ms = this.mediaSource;

      const onSourceOpen = () => {
        ms.removeEventListener("sourceopen", onSourceOpen);

        // ---------------------------------------------------------
        // FIX: avoid abort if init segment has not arrived yet
        // ---------------------------------------------------------
        if (!this.initSegment) {
          this.log("sourceopen waiting for init segment", {
            token,
            mimeType: this.mimeType,
          });

          // mark attach as pending; sourceopen will be retried
          this.pendingAttach = true;
          return;
        }

        void this.handleSourceOpen(token);
      };

      ms.addEventListener("sourceopen", onSourceOpen);

      // ---------------------------------------------------------
      // PATCH: handle already-open MediaSource (race protection)
      // ---------------------------------------------------------
      if (ms.readyState === "open") {
        this.log("sourceopen already fired → handling immediately");
        onSourceOpen();
      }
    }

    this.log("attached video", {
      mimeType: this.mimeType,
      mimeSupported,
      genericWebmAllowed: !mimeSupported && isGenericWebmMime(normalizedMime),
    });
  }

  public detach(): void {

    this.attachToken++;

    const next = detachVideo({ state: this.getAttachState() });
    this.applyAttachState(next);

    this.queue = [];

    this.flushing = false;
    this.resetting = false;
    this.flushRequested = false;

    // 🔴 CRÍTICO
    this.initSegment = null;

    this.initAppended = false;
    this.appendedCount = 0;

    this.log("detached");
  }

  private async handleSourceOpen(token: number): Promise<void> {
    /*
    console.error("[FB-TRACE] handleSourceOpen enter", {
      token,
      attachToken: this.attachToken,
      hasMediaSource: !!this.mediaSource,
      mediaSourceReadyState: this.mediaSource?.readyState ?? null,
      hasSourceBuffer: !!this.sourceBuffer,
      mimeType: this.mimeType,
      initType: this.initSegment?.type ?? null,
      queueLength: this.queue.length,
    });
    */
    if (this.isSuperseded(token)) {
      return;
    }

    const mediaSource = this.mediaSource;
    if (!mediaSource) {
      return;
    }

    // Guard against stale sourceopen from a previous MediaSource instance.
    if (mediaSource.readyState !== "open") {
      this.log("sourceopen ignored: mediasource not open", {
        readyState: mediaSource.readyState,
      });
      return;
    }

    if (this.sourceBuffer) {
      this.log("sourceopen ignored: sourceBuffer already exists", {
        mimeType: this.mimeType,
      });
      return;
    }

    try {
      const effectiveMime = normalizeMimeType(this.mimeType) || "video/webm";
      let resolvedMime = effectiveMime;

      // ---------------------------------------------------------
      // Bootstrap SourceBuffer from init mime when initial engine
      // mime is still generic "video/webm".
      // ---------------------------------------------------------
      if (isGenericWebmMime(resolvedMime)) {
        const initMime = normalizeMimeType(this.initSegment?.type);

        if (initMime && !isGenericWebmMime(initMime)) {
          resolvedMime = initMime;

          this.log("sourceopen adopting init mime", {
            previousMime: effectiveMime,
            adoptedMime: initMime,
          });
        } else {
          // console.error("[FB-TRACE] handleSourceOpen blocked waiting_codec_init", {
          //   effectiveMime,
          //   resolvedMime,
          //   hasInitSegment: !!this.initSegment,
          //   initType: this.initSegment?.type ?? null,
          // });

          this.log("sourceopen waiting for codec-qualified init mime", {
            mimeType: resolvedMime,
            hasInitSegment: !!this.initSegment,
            initSegmentType: this.initSegment?.type ?? null,
          });
          return;
        }
      }

      // ---------------------------------------------------------

      if (!MediaSource.isTypeSupported(resolvedMime)) {
        throw new Error(`Unsupported mime type: ${resolvedMime}`);
      }

      const sourceBuffer = mediaSource.addSourceBuffer(resolvedMime);
      sourceBuffer.mode = "segments";
      this.sourceBuffer = sourceBuffer;

      // console.error("[FB-TRACE] sourcebuffer created", {
      //   resolvedMime,
      //   queueLength: this.queue.length,
      //   hasInitSegment: !!this.initSegment,
      //   initType: this.initSegment?.type ?? null,
      // });

      this.log("sourcebuffer created", {
        mimeType: resolvedMime,
      });

      // ---------------------------------------------------------
      // FIX 3: prevent stale init injection
      // Only allow sourceopen to inject init if it belongs to the
      // current attach generation.
      // ---------------------------------------------------------

      const initMatchesGeneration =
        !!this.initSegment &&
        this.initSegmentGeneration === this.attachToken;

      const first = this.queue[0];
      const firstIsInit =
        !!this.initSegment &&
        !!first &&
        isSameBlob(first, this.initSegment);

      if (
        this.initSegment &&
        initMatchesGeneration &&
        !this.initAppended &&
        !firstIsInit
      ) {
        this.log("sourceopen queueing init segment", {
          initGeneration: this.initSegmentGeneration,
          attachToken: this.attachToken,
        });

        this.queue.unshift(this.initSegment);
      } else {
        this.log("sourceopen skipped init injection", {
          hasInit: !!this.initSegment,
          initMatchesGeneration,
          initAppended: this.initAppended,
          queueLength: this.queue.length,
        });
      }

      // ---------------------------------------------------------
      // FIX 4: structural guard
      // Guarantee INIT is always the first queued segment before
      // any media append starts, even after reattach/reset/race.
      // ---------------------------------------------------------

      if (this.initSegment && !this.initAppended) {
        const head = this.queue[0];
        const headIsInit =
          !!head && isSameBlob(head, this.initSegment);

        if (!headIsInit) {
          this.log("forcing init injection after sourcebuffer creation", {
            queueLength: this.queue.length,
          });

          this.queue.unshift(this.initSegment);
        }
      }

      // ---------------------------------------------------------
      // Safety: if queue somehow became empty but we do have init
      // pending, seed it explicitly.
      // ---------------------------------------------------------

      if (
        this.initSegment &&
        !this.initAppended &&
        this.queue.length === 0
      ) {
        this.log("sourceopen seeding empty queue with init segment", {
          attachToken: this.attachToken,
        });

        this.queue.unshift(this.initSegment);
      }

      // ---------------------------------------------------------

      void this.requestFlush(token);
    } catch (error) {
      console.error("[Flashback][DvrEngine] addSourceBuffer failed", error);
    }
  }

  public pushBlob(blob: Blob, info?: { isInit?: boolean }): void {
    if (!blob || blob.size <= 0) {
      return;
    }

    if (this.video?.error) {
      if (this.debug) {
        console.warn("[Flashback][DvrEngine] push ignored: video.error present", {
          code: this.video.error.code,
          message: this.video.error.message,
        });
      }
      return;
    }

    if (info?.isInit === true) {
      this.handleInitBlob(blob);
      return;
    }

    this.enqueueMediaBlob(blob);
  }

  private handleInitBlob(blob: Blob): void {
    const previousInit = this.initSegment;
    const generationChanged = !!previousInit && previousInit !== blob;

    const blobMimeType = normalizeMimeType(blob.type);
    const currentMimeType = normalizeMimeType(this.mimeType);

    const shouldAdoptBlobMime =
      !!blobMimeType &&
      (!currentMimeType ||
        isGenericWebmMime(currentMimeType) ||
        currentMimeType !== blobMimeType);

    let mimeChanged = false;
    if (shouldAdoptBlobMime) {
      mimeChanged = this.setMimeType(blobMimeType);
    }

    // --------------------------------------------------
    // INIT SEGMENT UPDATE
    // --------------------------------------------------

    this.initSegment = blob;
    this.initSegmentGeneration = this.attachToken;
    this.initAppended = false;

    // --------------------------------------------------
    // GENERATION OR MIME CHANGE HANDLING
    // --------------------------------------------------

    if (generationChanged || mimeChanged) {
      this.queue = [];
      this.appendedCount = 0;
      this.flushing = false;
      this.resetting = false;
      this.flushRequested = false;

      // Only force reset for real generation changes.
      // Mime adoption by itself should not trigger a destructive reattach/reset
      // in this replay path.
      if (generationChanged && this.mediaSource && this.sourceBuffer) {
        this.log("init generation changed → forcing buffer reset");

        void this.resetBufferedState(
          this.attachToken,
          "init_generation_changed_internal"
        );
      }
    }

    // --------------------------------------------------
    // QUEUE INIT SEGMENT
    // --------------------------------------------------

    const hasSameInitQueuedFront =
      this.queue.length > 0 && isSameBlob(this.queue[0], blob);

    if (!hasSameInitQueuedFront) {
      this.queue.unshift(blob);
    }

    this.log("init segment received", {
      size: blob.size,
      type: blob.type,
      queueLength: this.queue.length,
      generationChanged,
      mimeType: this.mimeType,
      mimeChanged,
      hasSameInitQueuedFront,
      initGeneration: this.initSegmentGeneration,
      attachToken: this.attachToken,
    });

    // --------------------------------------------------
    // If MediaSource is already open but SourceBuffer has not been
    // created yet, retry sourcebuffer creation now that we have init.
    // --------------------------------------------------

    if (
      this.mediaSource &&
      this.mediaSource.readyState === "open" &&
      !this.sourceBuffer
    ) {
      this.log(
        "init arrived after sourceopen → retrying sourcebuffer creation"
      );

      void this.handleSourceOpen(this.attachToken);
    }

    // --------------------------------------------------
    // MIME CHANGE HANDLING
    // --------------------------------------------------
    // Critical change:
    // DO NOT reattach on mimeChanged in this path.
    // We already adopted the better mime and either:
    // - retried sourceopen in-place, or
    // - already have a SourceBuffer created.
    // Reattaching here invalidates attachToken and kills the replay attach flow.
    // --------------------------------------------------

    if (mimeChanged) {
      if (
        this.mediaSource &&
        this.mediaSource.readyState === "open" &&
        !this.sourceBuffer
      ) {
        this.log(
          "mime changed before sourcebuffer creation → retrying sourceopen in-place",
          {
            mimeType: this.mimeType,
          }
        );

        void this.handleSourceOpen(this.attachToken);
        return;
      }

      this.log("mime changed handled in-place", {
        mimeType: this.mimeType,
        hasSourceBuffer: !!this.sourceBuffer,
        mediaSourceReadyState: this.mediaSource?.readyState ?? null,
      });

      void this.requestFlush(this.attachToken);
      return;
    }

    // --------------------------------------------------
    // GENERATION CHANGE
    // --------------------------------------------------

    if (generationChanged) {
      if (this.mediaSource && this.sourceBuffer) {
        void this.resetBufferedState(
          this.attachToken,
          "init_generation_changed"
        );
        return;
      }

      void this.requestFlush(this.attachToken);
      return;
    }

    // --------------------------------------------------
    // NORMAL FLOW
    // --------------------------------------------------

    if (this.pendingAttach && this.video) {
      this.pendingAttach = false;

      this.log("init arrived → completing pending attach", {
        attachToken: this.attachToken,
      });

      void this.handleSourceOpen(this.attachToken);
      return;
    }

    void this.requestFlush(this.attachToken);
  }

  private enqueueMediaBlob(blob: Blob): void {
    this.queue.push(blob);

    // Never drop init segment while it is still pending append.
    while (this.queue.length > this.maxQueue) {
      if (
        this.initSegment &&
        !this.initAppended &&
        isSameBlob(this.queue[0], this.initSegment)
      ) {
        if (this.queue.length > 1) {
          this.queue.splice(1, 1);
        } else {
          break;
        }
      } else {
        this.queue.shift();
      }
    }

    this.log("media segment queued", {
      size: blob.size,
      type: blob.type,
      queueLength: this.queue.length,
      maxQueue: this.maxQueue,
    });

    void this.requestFlush(this.attachToken);
  }

  private async requestFlush(token: number): Promise<void> {
    if (this.isSuperseded(token)) {
      // console.error("[FB-TRACE] requestFlush superseded-before-start", {
      //   token,
      //   attachToken: this.attachToken,
      //   queueLength: this.queue.length,
      // });
      return;
    }

    this.flushRequested = true;

    if (this.flushing || this.resetting) {
      // console.error("[FB-TRACE] requestFlush deferred", {
      //   token,
      //   attachToken: this.attachToken,
      //   flushing: this.flushing,
      //   resetting: this.resetting,
      //   queueLength: this.queue.length,
      // });

      this.log("flush deferred", {
        token,
        flushing: this.flushing,
        resetting: this.resetting,
        queueLength: this.queue.length,
      });
      return;
    }

    while (this.flushRequested) {
      if (this.isSuperseded(token)) {
        // console.error("[FB-TRACE] requestFlush superseded-in-loop", {
        //   token,
        //   attachToken: this.attachToken,
        //   queueLength: this.queue.length,
        // });
        return;
      }

      if (this.resetting) {
        // console.error("[FB-TRACE] requestFlush aborted-resetting", {
        //   token,
        //   attachToken: this.attachToken,
        //   queueLength: this.queue.length,
        // });
        return;
      }

      const mediaSource = this.mediaSource;
      const sourceBuffer = this.sourceBuffer;

      if (!mediaSource || mediaSource.readyState !== "open" || !sourceBuffer) {
        this.log("flush postponed: pipeline not ready", {
          hasMediaSource: !!mediaSource,
          mediaSourceReadyState: mediaSource?.readyState ?? null,
          hasSourceBuffer: !!sourceBuffer,
          queueLength: this.queue.length,
        });

        await new Promise((r) => setTimeout(r, 25));

        if (!this.isSuperseded(token)) {
          continue;
        }

        return;
      }

      // console.error("[FB-TRACE] requestFlush starting flushBuffer", {
      //   token,
      //   attachToken: this.attachToken,
      //   queueLength: this.queue.length,
      //   hasMediaSource: !!mediaSource,
      //   mediaSourceReadyState: mediaSource?.readyState ?? null,
      //   hasSourceBuffer: !!sourceBuffer,
      //   hasInitSegment: !!this.initSegment,
      //   initAppended: this.initAppended,
      // });

      this.flushRequested = false;
      this.flushing = true;

      const state = this.getBufferState();
      state.flushing = true;

      try {
        await flushBuffer({
          state,
          token,
          isSuperseded: (t) => this.isSuperseded(t),
          log: (...args) => this.log(...args),
        });
      } finally {
        state.flushing = false;

        this.applyMutableBufferState(state);

        this.flushing = false;
      }
    }
  }

  private async resetBufferedState(
    token: number,
    reason: string
  ): Promise<void> {
    const state = this.getBufferState();
    this.resetting = true;
    state.resetting = true;

    await resetBufferedState({
      state,
      token,
      reason,
      isSuperseded: (t) => this.isSuperseded(t),
      onAfterReset: async () => {
        // Same rule as flush:
        // preserve live attach refs, apply only mutable bookkeeping fields.
        this.applyMutableBufferState(state);

        if (this.isSuperseded(token)) {
          return;
        }

        if (!this.mediaSource || !this.sourceBuffer) {
          return;
        }

        if (this.video?.error) {
          return;
        }

        await this.requestFlush(token);
      },
      log: (...args) => this.log(...args),
    });

    state.resetting = false;
    this.applyMutableBufferState(state);
    this.resetting = false;
  }

  public async waitUntilReady(opts?: {
    timeoutMs?: number;
    requireSourceBuffer?: boolean;
  }): Promise<boolean> {
    const timeoutMs = Math.max(
      100,
      Math.min(10000, Math.trunc(Number(opts?.timeoutMs) || 2000))
    );

    const requireSourceBuffer = opts?.requireSourceBuffer !== false;
    const token = this.attachToken;
    const startedAt = Date.now();
    let sourceOpenRetried = false;

    while (Date.now() - startedAt < timeoutMs) {
      if (this.isSuperseded(token)) {
        // console.error("[FB-TRACE] waitUntilReady superseded", {
        //   token,
        //   attachToken: this.attachToken,
        //   requireSourceBuffer,
        // });
        return false;
      }

      const mediaSource = this.mediaSource;
      const sourceBuffer = this.sourceBuffer;

      const hasOpenMediaSource =
        !!mediaSource && mediaSource.readyState === "open";

      const ready =
        hasOpenMediaSource &&
        (!requireSourceBuffer || !!sourceBuffer);

      if (ready) {
        // console.error("[FB-TRACE] waitUntilReady ready", {
        //   token,
        //   attachToken: this.attachToken,
        //   requireSourceBuffer,
        //   hasMediaSource: !!mediaSource,
        //   mediaSourceReadyState: mediaSource?.readyState ?? null,
        //   hasSourceBuffer: !!sourceBuffer,
        //   queueLength: this.queue.length,
        //   hasInitSegment: !!this.initSegment,
        // });

        this.log("waitUntilReady: ready", {
          hasMediaSource: !!mediaSource,
          mediaSourceReadyState: mediaSource?.readyState ?? null,
          hasSourceBuffer: !!sourceBuffer,
          requireSourceBuffer,
        });
        return true;
      }

      // --------------------------------------------------
      // PATCH:
      // If caller requires SourceBuffer and MediaSource is already open,
      // try to complete SourceBuffer creation in-place when possible.
      // This helps recover from races where sourceopen fired before init
      // was available, or mime became codec-qualified slightly later.
      // --------------------------------------------------
      if (
        requireSourceBuffer &&
        !sourceOpenRetried &&
        hasOpenMediaSource &&
        !sourceBuffer &&
        this.initSegment
      ) {
        sourceOpenRetried = true;

        this.log("waitUntilReady: retrying handleSourceOpen", {
          hasMediaSource: !!mediaSource,
          mediaSourceReadyState: mediaSource?.readyState ?? null,
          hasSourceBuffer: !!sourceBuffer,
          hasInitSegment: !!this.initSegment,
          mimeType: this.mimeType,
        });

        try {
          void this.handleSourceOpen(token);
        } catch (error) {
          this.log("waitUntilReady: handleSourceOpen retry failed", {
            error: String(error),
          });
        }
      }

      await sleepMs(20);
    }

    // console.error("[FB-TRACE] waitUntilReady timeout", {
    //   token,
    //   attachToken: this.attachToken,
    //   requireSourceBuffer,
    //   hasMediaSource: !!this.mediaSource,
    //   mediaSourceReadyState: this.mediaSource?.readyState ?? null,
    //   hasSourceBuffer: !!this.sourceBuffer,
    //   queueLength: this.queue.length,
    //   hasInitSegment: !!this.initSegment,
    // });

    this.log("waitUntilReady: timeout", {
      hasMediaSource: !!this.mediaSource,
      mediaSourceReadyState: this.mediaSource?.readyState ?? null,
      hasSourceBuffer: !!this.sourceBuffer,
      requireSourceBuffer,
      queueLength: this.queue.length,
      hasInitSegment: !!this.initSegment,
    });

    return false;
  }

  public async play(): Promise<void> {
    if (!this.video) {
      return;
    }

    if (this.video.error) {
      return;
    }

    try {
      await this.video.play();
    } catch {}
  }

  public pause(): void {
    if (!this.video) {
      return;
    }

    try {
      this.video.pause();
    } catch {}
  }

  public seekBack(ms: number): void {
    seekBackInState({
      state: this.getNavigationState(),
      ms,
      endSafetyPadSec: this.endSafetyPadSec,
    });
  }

  public seekToSec(sec: number): void {
    seekToSecInState({
      state: this.getNavigationState(),
      sec,
      endSafetyPadSec: this.endSafetyPadSec,
    });
  }

  public getBufferedRange(): BufferedRange | null {
    return getBufferedRangeFromState({
      state: this.getNavigationState(),
    });
  }

  public async waitForBufferedWindow(
    minWindowSec: number,
    opts?: { timeoutMs?: number }
  ): Promise<BufferedRange | null> {
    return waitForBufferedWindowFromState({
      state: this.getNavigationState(),
      token: this.attachToken,
      minWindowSec,
      timeoutMs: opts?.timeoutMs,
      isSuperseded: (t) => this.isSuperseded(t),
    });
  }

  public getPlayableDurationSec(): number {
    return getPlayableDurationSecFromState({
      state: this.getNavigationState(),
    });
  }

  public clear(): void {
    this.queue = [];
    this.appendedCount = 0;
    this.initAppended = false;
    this.flushRequested = false;

    if (this.initSegment && !this.video?.error) {
      this.queue.unshift(this.initSegment);
    }

    this.log("cleared", {
      hasInitSegment: !!this.initSegment,
      queueLength: this.queue.length,
    });

    if (!this.mediaSource || !this.sourceBuffer) {
      return;
    }

    void this.resetBufferedState(this.attachToken, "clear");
  }

  public getVideo(): HTMLVideoElement | null {
    return this.video;
  }

  public getDebugState(): ContinuousDvrEngineDebugState {
    return {
      hasVideo: !!this.video,
      hasMediaSource: !!this.mediaSource,
      hasSourceBuffer: !!this.sourceBuffer,
      queuedCount: this.queue.length,
      appendedCount: this.appendedCount,
      hasInitSegment: !!this.initSegment,
      bufferedRange: this.getBufferedRange(),
      mimeType: this.mimeType,
    };
  }

  private isSuperseded(token: number): boolean {
    return token !== this.attachToken;
  }
}
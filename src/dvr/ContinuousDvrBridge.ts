// src/dvr/ContinuousDvrBridge.ts
// ======================================================
//
// ContinuousDvrBridge
// -------------------
//
// This module consumes the live chunk feed coming from
// FlashbackRecorder and forwards it to a DVR consumer
// while enforcing init-before-media order.
//

export type DvrChunkInfo = {
  seq: number;
  mimeType: string;
  timesliceMs: number;
  isInit?: boolean;
  timestampMs?: number;
  durationMs?: number;
};

export type DvrConsumerInfo = {
  isInit?: boolean;
  seq?: number;
  mimeType?: string;
  timesliceMs?: number;
  timestampMs?: number;
  durationMs?: number;
};

export type DvrConsumer = (
  blob: Blob,
  info: DvrConsumerInfo
) => void;

export type ContinuousDvrBridgeDebugState = {
  hasConsumer: boolean;
  initEmitted: boolean;
  pendingCount: number;
  maxPending: number;
  generation: number;
};

function sanitizeOptionalNumber(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  return num;
}

export class ContinuousDvrBridge {
  private consumer: DvrConsumer | null = null;
  private initEmitted = false;

  private pending: Array<{
    blob: Blob;
    info: DvrChunkInfo;
    generation: number;
  }> = [];

  private generation = 0;

  private readonly maxPending: number;

  constructor(
    private readonly debug = false,
    maxPending = 512
  ) {
    this.maxPending = Math.max(1, Math.trunc(Number(maxPending) || 0));
  }

  private log(...args: unknown[]): void {
    if (!this.debug) {
      return;
    }

    console.log("[Flashback][ContinuousDvrBridge]", ...args);
  }

  public setConsumer(fn: DvrConsumer | null): void {
    this.consumer = fn;

    // New consumer → new generation
    this.generation++;

    this.log("consumer set", {
      hasConsumer: !!fn,
      generation: this.generation,
    });

    if (!fn) {
      return;
    }

    if (this.initEmitted && this.pending.length > 0) {
      this.flushPending(fn);
    }
  }

  public clear(): void {
    this.initEmitted = false;
    this.pending.length = 0;

    this.generation++;

    this.log("cleared", {
      generation: this.generation,
    });
  }

  public getDebugState(): ContinuousDvrBridgeDebugState {
    return {
      hasConsumer: !!this.consumer,
      initEmitted: this.initEmitted,
      pendingCount: this.pending.length,
      maxPending: this.maxPending,
      generation: this.generation,
    };
  }

  public ingest(blob: Blob, info: DvrChunkInfo): void {
    if (!blob || blob.size <= 0) {
      return;
    }

    const consumer = this.consumer;
    if (!consumer) {
      this.log("ingest skipped: no consumer", {
        seq: info?.seq ?? null,
        isInit: info?.isInit === true,
      });
      return;
    }

    if (info.isInit === true) {
      this.handleInit(blob, info, consumer);
      return;
    }

    if (!this.initEmitted) {
      this.bufferPending(blob, info);
      return;
    }

    this.forwardMedia(blob, info, consumer);
  }

  private handleInit(blob: Blob, info: DvrChunkInfo, consumer: DvrConsumer): void {
    if (this.initEmitted) {
      this.log("init ignored: already emitted", {
        seq: info?.seq ?? null,
      });
      return;
    }

    this.initEmitted = true;

    consumer(blob, this.toConsumerInfo(info, true));

    this.log("init received → flushing pending", {
      seq: info?.seq ?? null,
      pending: this.pending.length,
      generation: this.generation,
    });

    this.flushPending(consumer);
  }

  private flushPending(consumer: DvrConsumer): void {
    if (!this.pending.length) {
      return;
    }

    const currentGeneration = this.generation;

    for (const entry of this.pending) {
      if (entry.generation !== currentGeneration) {
        continue;
      }

      consumer(entry.blob, this.toConsumerInfo(entry.info, false));
    }

    this.pending.length = 0;
  }

  private bufferPending(blob: Blob, info: DvrChunkInfo): void {
    if (this.pending.length >= this.maxPending) {
      const removed = this.pending.shift();

      this.log("pending overflow → oldest media dropped", {
        droppedSeq: removed?.info?.seq ?? null,
        maxPending: this.maxPending,
      });
    }

    this.pending.push({
      blob,
      info,
      generation: this.generation,
    });

    this.log("media before init → pending", {
      seq: info.seq,
      pending: this.pending.length,
      generation: this.generation,
      timestampMs: info.timestampMs ?? null,
      durationMs: info.durationMs ?? null,
    });
  }

  private forwardMedia(blob: Blob, info: DvrChunkInfo, consumer: DvrConsumer): void {
    consumer(blob, this.toConsumerInfo(info, false));
  }

  private toConsumerInfo(info: DvrChunkInfo, isInit: boolean): DvrConsumerInfo {
    return {
      isInit,
      seq: Number.isFinite(info.seq) ? info.seq : undefined,
      mimeType: String(info.mimeType || "").trim() || undefined,
      timesliceMs:
        Number.isFinite(info.timesliceMs) && info.timesliceMs > 0
          ? info.timesliceMs
          : undefined,
      timestampMs: sanitizeOptionalNumber(info.timestampMs),
      durationMs:
        Number.isFinite(info.durationMs) && (info.durationMs ?? 0) > 0
          ? info.durationMs
          : undefined,
    };
  }
}
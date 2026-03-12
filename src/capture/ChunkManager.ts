// src/capture/ChunkManager.ts
// =================================
//
// ChunkManager
// ------------
//
// This module stores media chunks inside a rolling time window.
//
// Responsibilities
// ----------------
// - store chunks in arrival order
// - keep total bytes
// - estimate buffered duration
// - purge old chunks outside the time window
// - keep a basic init candidate
//
// Non-responsibilities
// --------------------
// This module MUST NOT:
// - decide replay policy
// - select replay windows
// - scan GOP/keyframes
// - interact with MSE
// - attach playback
//
// Those responsibilities belong to higher layers.

export type ManagedChunk = {
  seq: number;
  blob: Blob;
  t0Ms: number;
  t1Ms: number;
  bytes: number;
};

export class ChunkManager {
  private readonly maxBufferMs: number;
  private readonly debug: boolean;

  private chunks: ManagedChunk[] = [];
  private totalBytes = 0;
  private lastTimesliceMs = 1200;
  private nextSeq = 1;

  private initCandidate: Blob | null = null;

  constructor(maxBufferMs: number, debug = false) {
    this.maxBufferMs = Math.max(1000, Math.trunc(Number(maxBufferMs) || 0));
    this.debug = !!debug;
  }

  public setLastTimesliceMs(ms: number): void {
    const value = Math.max(0, Math.trunc(Number(ms) || 0));
    this.lastTimesliceMs = value;
  }

  public getLastTimesliceMs(): number {
    return this.lastTimesliceMs;
  }

  public clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.nextSeq = 1;
    this.initCandidate = null;
  }

  public pushChunk(blob: Blob, nowMs: number): void {
    if (!blob || blob.size <= 0) return;

    const t1Ms = Number.isFinite(nowMs) ? nowMs : performance.now();
    const prev = this.chunks.length > 0 ? this.chunks[this.chunks.length - 1] : null;
    const prevT1 = prev?.t1Ms;

    let t0Ms =
      typeof prevT1 === "number" && Number.isFinite(prevT1)
        ? prevT1
        : t1Ms - this.lastTimesliceMs;

    if (!Number.isFinite(t0Ms)) t0Ms = t1Ms - this.lastTimesliceMs;
    if (t0Ms > t1Ms) t0Ms = t1Ms;
    if (t0Ms < 0) t0Ms = 0;

    const chunk: ManagedChunk = {
      seq: this.nextSeq++,
      blob,
      t0Ms,
      t1Ms,
      bytes: blob.size,
    };

    this.chunks.push(chunk);
    this.totalBytes += blob.size;

    if (!this.initCandidate && blob.size > 0) {
      this.initCandidate = blob;
    }

    this.purgeOld(t1Ms);

    if (this.debug) {
      console.log("[Flashback][ChunkManager] pushChunk", {
        seq: chunk.seq,
        bytes: chunk.bytes,
        chunkCount: this.chunks.length,
        totalBytes: this.totalBytes,
        bufferedMs: this.getBufferedMs(),
        hasInitCandidate: !!this.initCandidate,
      });
    }
  }

  public getChunks(): ManagedChunk[] {
    return this.chunks.slice();
  }

  public getTotalBytes(): number {
    return this.totalBytes;
  }

  public getBufferedMs(): number {
    if (this.chunks.length === 0) return 0;

    const first = this.chunks[0];
    const last = this.chunks[this.chunks.length - 1];

    return Math.max(0, last.t1Ms - first.t0Ms);
  }

  public getInitCandidate(): Blob | null {
    return this.initCandidate;
  }

  public restoreInitCandidate(blob: Blob | null): void {
    if (!blob || blob.size <= 0) return;
    this.initCandidate = blob;
  }

  private purgeOld(nowMs: number): void {
    if (this.chunks.length === 0) return;

    const cutoff = nowMs - this.maxBufferMs;
    if (cutoff <= 0) return;

    let removeCount = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].t1Ms < cutoff) removeCount++;
      else break;
    }

    if (removeCount <= 0) return;

    for (let i = 0; i < removeCount; i++) {
      this.totalBytes -= this.chunks[i].bytes || 0;
    }

    this.chunks.splice(0, removeCount);

    if (this.totalBytes < 0) {
      this.totalBytes = 0;
    }
  }
}
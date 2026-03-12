// src/dvr/ContinuousDvrEngine.utils.ts
// ======================================================
//
// Utility helpers for ContinuousDvrEngine.
//
// This file contains small pure helpers and async helpers
// used by the live DVR engine implementation.
//
// Important:
// - no engine state lives here
// - no replay policy lives here
// - no DOM orchestration lives here
//

import type { BufferedRange } from "./ContinuousDvrEngine.types";

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function waitForSourceBufferUpdateEnd(
  sourceBuffer: SourceBuffer
): Promise<void> {
  if (!sourceBuffer.updating) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handler = () => {
      sourceBuffer.removeEventListener("updateend", handler);
      resolve();
    };

    sourceBuffer.addEventListener("updateend", handler);
  });
}

export function getSourceBufferRange(
  sourceBuffer: SourceBuffer
): BufferedRange | null {
  try {
    const buffered = sourceBuffer.buffered;
    if (!buffered || buffered.length <= 0) {
      return null;
    }

    const start = buffered.start(0);
    const end = buffered.end(buffered.length - 1);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }

    return { start, end };
  } catch {
    return null;
  }
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

export function normalizeMimeType(value: string | null | undefined): string {
  return String(value || "").trim();
}

export function isGenericWebmMime(value: string): boolean {
  const mime = normalizeMimeType(value).toLowerCase();
  return mime === "video/webm";
}
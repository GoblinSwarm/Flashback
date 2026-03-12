// src/snapshot/MseSnapshotSanitizer.ts
// ======================================================
//
// MseSnapshotSanitizer
// --------------------
//
// Helper responsible for sanitizing candidate DVR media
// windows before they are converted into a closed MSE
// replay snapshot.
//
// Architecture role
// -----------------
//
// This helper belongs to the Snapshot Layer.
//
// It is intentionally narrow:
//
// - receives candidate media entries
// - applies conservative MSE-oriented sanitation
// - returns a safer media slice for snapshot playback
//
// It MUST NOT:
//
// - perform playback
// - interact with MediaSource directly
// - manage replay lifecycle
// - manipulate UI
//

import { blobContainsWebmKeyframe } from "./webmKeyframe";

export type SanitizerMediaEntry = {
  blob: Blob;
  receivedAtMs: number;
  durationMs: number | null;
};

export type TimelineIssueKind = "backwards" | "invalid" | "gap";

export type TimelineIssue = {
  index: number;
  kind: TimelineIssueKind;
  deltaMs?: number;
};

export type SanitizeMseWindowResult = {
  selectedEntries: SanitizerMediaEntry[];
  recentWindowCount: number;
  cappedRecentCount: number;
  keyframeStartIndex: number;
  safeStartIndex: number;
  timelineIssues: TimelineIssue[];
};

export type MseSnapshotSanitizerOptions = {
  maxRecentEntriesForMse?: number;
  debug?: boolean;
  minEntriesAfterStart?: number;
  gapThresholdMs?: number;
};

function toPositiveNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export class MseSnapshotSanitizer {
  private readonly maxRecentEntriesForMse: number;
  private readonly debug: boolean;
  private readonly minEntriesAfterStart: number;
  private readonly gapThresholdMs: number;

  constructor(options?: MseSnapshotSanitizerOptions) {
    this.maxRecentEntriesForMse = Math.max(
      1,
      Math.trunc(options?.maxRecentEntriesForMse ?? 24)
    );
    this.debug = options?.debug === true;
    this.minEntriesAfterStart = Math.max(
      1,
      Math.trunc(options?.minEntriesAfterStart ?? 4)
    );
    this.gapThresholdMs = Math.max(
      250,
      Math.trunc(options?.gapThresholdMs ?? 2500)
    );
  }

  public async sanitizeRecentWindow(
    entries: SanitizerMediaEntry[]
  ): Promise<SanitizeMseWindowResult> {
    if (!entries.length) {
      return {
        selectedEntries: [],
        recentWindowCount: 0,
        cappedRecentCount: 0,
        keyframeStartIndex: -1,
        safeStartIndex: 0,
        timelineIssues: [],
      };
    }

    const recentWindowCount = entries.length;

    const nonEmptyEntries = entries.filter(
      (entry) => !!entry?.blob && entry.blob.size > 0
    );

    const cappedEntries = this.capRecentEntries(nonEmptyEntries);
    const cappedRecentCount = cappedEntries.length;

    if (!cappedEntries.length) {
      return {
        selectedEntries: [],
        recentWindowCount,
        cappedRecentCount: 0,
        keyframeStartIndex: -1,
        safeStartIndex: 0,
        timelineIssues: [],
      };
    }

    const keyframeStartIndex = await this.findFirstKeyframeIndex(cappedEntries);

    const keyframedEntries =
      keyframeStartIndex >= 0
        ? cappedEntries.slice(keyframeStartIndex)
        : cappedEntries.slice();

    const timelineIssues = this.detectTimelineIssues(keyframedEntries);

    // ✅ Nueva política:
    // en vez de “saltar” al primer issue y conservar la cola posterior,
    // cortamos la ventana en el primer quiebre serio y nos quedamos
    // solo con el tramo continuo inicial.
    const contiguousEndExclusive = this.selectContiguousEndExclusive(
      keyframedEntries,
      timelineIssues
    );

    let selectedEntries = keyframedEntries.slice(0, contiguousEndExclusive);

    // fail-safe: si el corte deja una ventana demasiado chica,
    // conservar un mínimo útil desde el comienzo continuo.
    if (
      selectedEntries.length > 0 &&
      selectedEntries.length < this.minEntriesAfterStart &&
      keyframedEntries.length >= this.minEntriesAfterStart
    ) {
      selectedEntries = keyframedEntries.slice(0, this.minEntriesAfterStart);
    }

    // backward compatibility para logs/resultado:
    // safeStartIndex sigue existiendo, pero ahora el recorte fuerte
    // ocurre por “contiguous end” y no por desplazar el inicio.
    const safeStartIndex = 0;

    if (this.debug) {
      try {
        console.log("[Flashback][MseSnapshotSanitizer] sanitizeRecentWindow", {
          inputCount: entries.length,
          nonEmptyCount: nonEmptyEntries.length,
          recentWindowCount,
          cappedRecentCount,
          keyframeStartIndex,
          postKeyframeCount: keyframedEntries.length,
          safeStartIndex,
          contiguousEndExclusive,
          selectedCount: selectedEntries.length,
          firstSelectedSize: selectedEntries[0]?.blob?.size ?? 0,
          lastSelectedSize:
            selectedEntries[selectedEntries.length - 1]?.blob?.size ?? 0,
          timelineIssues,
        });
      } catch {}
    }

    return {
      selectedEntries:
        selectedEntries.length > 0
          ? selectedEntries
          : keyframedEntries.slice(0, Math.max(1, contiguousEndExclusive)),
      recentWindowCount,
      cappedRecentCount,
      keyframeStartIndex,
      safeStartIndex,
      timelineIssues,
    };
  }

  private capRecentEntries(
    entries: SanitizerMediaEntry[]
  ): SanitizerMediaEntry[] {
    if (entries.length <= this.maxRecentEntriesForMse) {
      return entries.slice();
    }

    return entries.slice(-this.maxRecentEntriesForMse);
  }

  private async findFirstKeyframeIndex(
    entries: SanitizerMediaEntry[]
  ): Promise<number> {
    for (let i = 0; i < entries.length; i++) {
      const blob = entries[i]?.blob;
      if (!blob || blob.size <= 0) {
        continue;
      }

      try {
        const hasKeyframe = await blobContainsWebmKeyframe(blob);
        if (hasKeyframe) {
          return i;
        }
      } catch {
        // best-effort
      }
    }

    return -1;
  }

  private selectContiguousEndExclusive(
    entries: SanitizerMediaEntry[],
    issues: TimelineIssue[]
  ): number {
    if (!entries.length) return 0;
    if (!issues.length) return entries.length;

    const firstIssue = issues[0];
    if (!firstIssue) return entries.length;

    // Cortar justo antes del primer issue.
    // Si el issue ocurre muy temprano y el corte deja 0 chunks,
    // forzamos al menos 1 para no vaciar completamente la ventana.
    const cutIndex = clampInt(firstIssue.index, 0, entries.length);

    if (cutIndex >= this.minEntriesAfterStart) {
      return cutIndex;
    }

    // Si el primer issue aparece demasiado pronto, preferimos una ventana
    // mínima desde el inicio antes que una cola posterior incierta.
    return Math.min(entries.length, Math.max(1, this.minEntriesAfterStart));
  }

  private detectTimelineIssues(entries: SanitizerMediaEntry[]): TimelineIssue[] {
    const issues: TimelineIssue[] = [];
    if (entries.length <= 1) return issues;

    let prevTs = this.readEntryTimestamp(entries[0]);

    for (let i = 1; i < entries.length; i++) {
      const curTs = this.readEntryTimestamp(entries[i]);

      if (curTs == null) {
        issues.push({ index: i, kind: "invalid" });
        continue;
      }

      if (prevTs == null) {
        prevTs = curTs;
        continue;
      }

      const delta = curTs - prevTs;

      if (!Number.isFinite(delta)) {
        issues.push({ index: i, kind: "invalid" });
        prevTs = curTs;
        continue;
      }

      if (delta < 0) {
        issues.push({
          index: i,
          kind: "backwards",
          deltaMs: delta,
        });
        prevTs = curTs;
        continue;
      }

      if (delta > this.gapThresholdMs) {
        issues.push({
          index: i,
          kind: "gap",
          deltaMs: delta,
        });
      }

      prevTs = curTs;
    }

    return issues;
  }

  private readEntryTimestamp(
    entry: SanitizerMediaEntry | null | undefined
  ): number | null {
    if (!entry) return null;

    const receivedAtMs = toPositiveNumberOrNull(entry.receivedAtMs);
    if (receivedAtMs != null) return receivedAtMs;

    const durationMs = toPositiveNumberOrNull(entry.durationMs);
    if (durationMs != null) return durationMs;

    return null;
  }
}
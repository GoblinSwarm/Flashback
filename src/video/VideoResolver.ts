// src/video/VideoResolver.ts
// ======================================================
//
// VideoResolver
// -------------
//
// Resolves the most likely "main" HTMLVideoElement that
// Flashback should capture on video/live platforms such
// as YouTube, Twitch, Kick, and similar pages.
//
// Architecture role
// -----------------
//
// VideoResolver belongs to the **Video Discovery /
// Resolution Layer**.
//
// It is responsible for:
//
// - scanning page video elements
// - filtering obviously invalid candidates
// - ranking viable candidates
// - returning the best current candidate
// - exposing debug-friendly candidate reasoning
//
// It does NOT own stability/hysteresis/lifecycle policy.
// That belongs to `AutoStartManager`.
//
// Important boundary
// ------------------
//
// In this architecture:
//
// - `VideoResolver`    = discover and rank candidate videos
// - `AutoStartManager` = require stability over time and emit
//                        ready / changed / lost events
//
// This distinction must remain explicit.
//
// If warmup logic, stable tick counting, ready/lost event
// policy, or recorder boot logic starts appearing here,
// this file will begin to overlap with `AutoStartManager`.
//
// Responsibilities
// ----------------
//
// This module is responsible ONLY for:
//
// - discovering <video> elements in the DOM
// - filtering out invalid or undesirable candidates
// - scoring/ranking viable candidates
// - avoiding replay/self-capture feedback by excluding
//   Flashback replay UI videos
// - preferring sticky winners when the previous winner
//   remains close enough to the best candidate
// - returning a best-effort candidate with debug metadata
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - start or stop recording
// - decide stable ready/changed/lost lifecycle
// - own replay lifecycle
// - own DVR pipeline state
// - attach playback/UI
// - implement replay/session ownership
//
// Those responsibilities belong to:
//
//   AutoStartManager
//   FlashbackContentRuntime
//   Replay layer
//   Playback layer
//
// Design rule
// -----------
//
// VideoResolver should remain a deterministic candidate
// resolver.
//
// If recorder logic, DVR logic, replay lifecycle logic,
// or playback attachment logic starts appearing here,
// the architecture is being violated.
//
// Maintenance note
// ----------------
//
// Many heuristics in this resolver exist because real
// streaming sites are noisy:
//
// - empty currentSrc/src on Twitch-like players
// - overlay occlusion
// - DOM churn replacing equivalent video nodes
// - mini previews / thumbnails / ads
// - replay UI self-capture risk
//
// Be careful when simplifying this file.
// Several "weird" checks exist because they solved real
// platform-specific problems.
//
// Sticky note
// -----------
//
// The sticky-winner behavior is intentional.
// Its goal is to reduce flapping when multiple candidates
// are close in score or when the DOM churns temporarily.
//
// Replay exclusion note
// ---------------------
//
// Excluding Flashback replay videos is a hard requirement.
// If that check is removed or weakened, Flashback can end
// up selecting its own replay video as the capture source,
// causing self-capture loops.
//

type ResolveOptions = {
  dumpCandidates?: boolean;
};

export type VideoResolveCandidate = {
  idx: number;
  video: HTMLVideoElement;
  score: number;
  visibleArea: number;
  ratio: number;
  readyState: number;
  paused: boolean;
  muted: boolean;
  src: string;
  width: number;
  height: number;
  reasonBits: string[];
};

export type VideoResolveResult = {
  video: HTMLVideoElement | null;
  reason: string;
  candidates: VideoResolveCandidate[];
};

type TimeSample = {
  tSec: number;
  atMs: number;
};

function getViewport(): { w: number; h: number } {
  return {
    w: window.innerWidth || 0,
    h: window.innerHeight || 0,
  };
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function rectArea(rect: DOMRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectRect(a: DOMRect, b: DOMRect): DOMRect {
  const x1 = Math.max(a.left, b.left);
  const y1 = Math.max(a.top, b.top);
  const x2 = Math.min(a.right, b.right);
  const y2 = Math.min(a.bottom, b.bottom);

  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);

  return new DOMRect(x1, y1, width, height);
}

function getVisibleArea(video: HTMLVideoElement): {
  visibleArea: number;
  ratio: number;
  rect: DOMRect | null;
} {
  const viewport = getViewport();
  const viewportRect = new DOMRect(0, 0, viewport.w, viewport.h);

  let rect: DOMRect;
  try {
    rect = video.getBoundingClientRect();
  } catch {
    return { visibleArea: 0, ratio: 0, rect: null };
  }

  const fullArea = rectArea(rect);
  if (fullArea <= 0) {
    return { visibleArea: 0, ratio: 0, rect };
  }

  const intersection = intersectRect(rect, viewportRect);
  const visibleArea = rectArea(intersection);

  return {
    visibleArea,
    ratio: clamp(visibleArea / fullArea, 0, 1),
    rect,
  };
}

function isActuallyVisible(video: HTMLVideoElement): boolean {
  try {
    const style = window.getComputedStyle(video);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    if (parseFloat(style.opacity || "1") <= 0.01) {
      return false;
    }
  } catch {
    return false;
  }

  let rect: DOMRect | null = null;
  try {
    rect = video.getBoundingClientRect?.() ?? null;
  } catch {
    rect = null;
  }

  if (!rect) {
    return false;
  }

  // Anti-thumbnail threshold.
  if (rect.width < 140 || rect.height < 90) {
    return false;
  }

  return true;
}

function hasSrc(video: HTMLVideoElement): boolean {
  const src = String(video.currentSrc || video.src || "").trim();
  return !!src;
}

function isLikelyMainPlayer(video: HTMLVideoElement): boolean {
  const id = String(video.id || "").toLowerCase();
  const cls = String(video.className || "").toLowerCase();

  if (id.includes("player")) return true;
  if (cls.includes("player")) return true;
  if (cls.includes("html5-main-video")) return true;

  return false;
}

function canCaptureStream(video: HTMLVideoElement): boolean {
  const candidate = video as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };

  return (
    typeof candidate.captureStream === "function" ||
    typeof candidate.mozCaptureStream === "function"
  );
}

/**
 * Detect whether this video belongs to Flashback replay UI.
 * This is a hard exclusion.
 */
function isFlashbackReplayVideo(video: HTMLVideoElement): boolean {
  try {
    const dataset = (video as any).dataset ?? {};

    if (dataset.flashbackIgnore === "1") return true;
    if (dataset.flashbackRole === "replay") return true;
    if (dataset.fbRole === "replay") return true;

    if (video.getAttribute?.("data-flashback-ignore") === "1") return true;
    if (video.hasAttribute?.("data-flashback-ignore")) return true;

    if (video.getAttribute?.("data-flashback-role") === "replay") return true;
    if (video.getAttribute?.("data-fb-role") === "replay") return true;

    if (video.hasAttribute?.("data-flashback-replay")) return true;
    if (video.getAttribute?.("data-flashback-replay") === "1") return true;

    if (video.closest?.('[data-flashback-ignore="1"]')) return true;
    if (video.closest?.("[data-flashback-ignore]")) return true;

    if (video.closest?.('[data-flashback-role="replay"]')) return true;
    if (video.closest?.('[data-fb-role="replay"]')) return true;
    if (video.closest?.('[data-flashback-replay="1"]')) return true;
    if (video.closest?.("[data-flashback-replay]")) return true;

    const inKnownReplayRoot =
      !!video.closest?.("#flashback-replay-root") ||
      !!video.closest?.("[data-flashback-replay-root]") ||
      !!video.closest?.(".flashback-replay-root") ||
      !!video.closest?.("[data-flashback-root='replay']") ||
      !!video.closest?.("#flashback-root") ||
      !!video.closest?.("#flashback-replay") ||
      !!video.closest?.(".flashback-replay") ||
      !!video.closest?.(".fb-replay") ||
      !!video.closest?.(".flashback-replay-video") ||
      !!video.closest?.('[data-flashback-root="1"]');

    return inKnownReplayRoot;
  } catch {
    return false;
  }
}

/**
 * Soft occlusion check:
 * if the center point is covered by another element,
 * apply a penalty instead of hard-rejecting.
 */
function occlusionPenalty(
  video: HTMLVideoElement,
  rect: DOMRect | null
): { penalty: number; bit?: string } {
  try {
    if (!rect) {
      return { penalty: 0 };
    }

    const viewport = getViewport();
    if (viewport.w <= 0 || viewport.h <= 0) {
      return { penalty: 0 };
    }

    const cx = clamp(rect.left + rect.width / 2, 0, Math.max(0, viewport.w - 1));
    const cy = clamp(rect.top + rect.height / 2, 0, Math.max(0, viewport.h - 1));

    const element = document.elementFromPoint(cx, cy);
    if (!element) {
      return { penalty: 0 };
    }

    if (element === video) {
      return { penalty: 0 };
    }

    if (video.contains(element)) {
      return { penalty: 0 };
    }

    return { penalty: 4, bit: "center_occluded" };
  } catch {
    return { penalty: 0 };
  }
}

export class VideoResolver {
  private readonly debug: boolean;

  private last: HTMLVideoElement | null = null;
  private lastAtMs = 0;
  private readonly cacheMs = 900;

  // Conservative sticky tuning to reduce flapping on Twitch-like DOM churn.
  private readonly stickyDelta = 10;
  private readonly stickyMinScore = 6;

  // Per-video progress tracking for "actually playing" heuristics.
  private readonly timeSamples = new WeakMap<HTMLVideoElement, TimeSample>();

  constructor(opts?: { debug?: boolean }) {
    this.debug = !!opts?.debug;
  }

  private isTimeProgressPlaying(video: HTMLVideoElement): boolean {
    const now = performance.now();
    const currentTime = Number(video.currentTime || 0);

    const previous = this.timeSamples.get(video);
    if (!previous) {
      this.timeSamples.set(video, { tSec: currentTime, atMs: now });
      return false;
    }

    const deltaMs = now - previous.atMs;
    const deltaSec = currentTime - previous.tSec;

    this.timeSamples.set(video, { tSec: currentTime, atMs: now });

    return deltaMs >= 650 && deltaSec >= 0.12;
  }

  public async resolve(opts?: ResolveOptions): Promise<VideoResolveResult> {
    const now = performance.now();

    // Safe cache hit for micro-race / micro-churn scenarios.
    if (
      this.last &&
      this.last.isConnected &&
      isActuallyVisible(this.last) &&
      !isFlashbackReplayVideo(this.last) &&
      canCaptureStream(this.last) &&
      now - this.lastAtMs < this.cacheMs
    ) {
      const { visibleArea, rect } = getVisibleArea(this.last);
      const width = rect?.width ?? 0;
      const height = rect?.height ?? 0;

      if (visibleArea > 0 && width >= 140 && height >= 90) {
        return {
          video: this.last,
          reason: "cache_hit",
          candidates: [],
        };
      }
    }

    const videos = Array.from(document.querySelectorAll("video")) as HTMLVideoElement[];

    // Important:
    // do not clear `last` immediately during DOM churn.
    if (!videos.length) {
      if (
        this.last &&
        this.last.isConnected &&
        isActuallyVisible(this.last) &&
        !isFlashbackReplayVideo(this.last) &&
        canCaptureStream(this.last)
      ) {
        return {
          video: this.last,
          reason: "fallback_last_visible (no_video_elements)",
          candidates: [],
        };
      }

      this.last = null;
      return {
        video: null,
        reason: "no_video_elements",
        candidates: [],
      };
    }

    const candidates: VideoResolveCandidate[] = [];
    const viewport = getViewport();
    const viewportArea = Math.max(1, viewport.w * viewport.h);

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];

      if (!video.isConnected) {
        continue;
      }

      // Hard exclusion: never select Flashback replay UI as source.
      if (isFlashbackReplayVideo(video)) {
        if (this.debug && opts?.dumpCandidates) {
          const { visibleArea, ratio, rect } = getVisibleArea(video);
          candidates.push({
            idx: i,
            video,
            score: -999,
            visibleArea,
            ratio,
            readyState: video.readyState || 0,
            paused: !!video.paused,
            muted: !!video.muted,
            src: String(video.currentSrc || video.src || "").slice(0, 120),
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            reasonBits: ["SKIP_replay_video"],
          });
        }
        continue;
      }

      // Hard exclusion: Flashback capture requires a capturable video.
      if (!canCaptureStream(video)) {
        if (this.debug && opts?.dumpCandidates) {
          const { visibleArea, ratio, rect } = getVisibleArea(video);
          candidates.push({
            idx: i,
            video,
            score: -998,
            visibleArea,
            ratio,
            readyState: video.readyState || 0,
            paused: !!video.paused,
            muted: !!video.muted,
            src: String(video.currentSrc || video.src || "").slice(0, 120),
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            reasonBits: ["SKIP_not_capturable"],
          });
        }
        continue;
      }

      const reasonBits: string[] = [];

      const { visibleArea, ratio, rect } = getVisibleArea(video);
      const width = rect?.width ?? 0;
      const height = rect?.height ?? 0;

      const paused = !!video.paused;
      const readyState = video.readyState || 0;
      const muted = !!video.muted;
      const src = String(video.currentSrc || video.src || "").slice(0, 120);

      if (width < 140 || height < 90) {
        continue;
      }

      if (visibleArea <= 0) {
        continue;
      }

      const areaScore = (visibleArea / viewportArea) * 100;
      let score = areaScore;

      if (ratio >= 0.85) {
        score += 8;
        reasonBits.push("high_visible_ratio");
      } else if (ratio >= 0.6) {
        score += 4;
        reasonBits.push("med_visible_ratio");
      }

      const timeProgressPlaying = this.isTimeProgressPlaying(video);

      // Accept readyState>=3 as soft activity to avoid false penalties
      // during micro-stalls on live players.
      const consideredPlaying = !paused || timeProgressPlaying || readyState >= 3;

      if (consideredPlaying) {
        score += 10;
        reasonBits.push(
          timeProgressPlaying
            ? "time_progress_playing"
            : readyState >= 3 && paused
              ? "ready_playing_soft"
              : "playing"
        );
      } else {
        score -= 4;
        reasonBits.push("paused");
      }

      if (readyState >= 3) {
        score += 6;
        reasonBits.push("ready>=3");
      } else if (readyState >= 2) {
        score += 2;
        reasonBits.push("ready>=2");
      } else {
        score -= 3;
        reasonBits.push("ready_low");
      }

      const decodedWidth = video.videoWidth || 0;
      const decodedHeight = video.videoHeight || 0;

      if (decodedWidth > 0 && decodedHeight > 0) {
        score += 8;
        reasonBits.push("decoded_dims");
      } else {
        score -= 2;
        reasonBits.push("no_decoded_dims");
      }

      // Empty src/currentSrc is NOT a hard penalty:
      // some live players keep these blank.
      if (hasSrc(video)) {
        score += 2;
        reasonBits.push("has_src");
      } else {
        reasonBits.push("no_src_ok");
      }

      if (isLikelyMainPlayer(video)) {
        score += 4;
        reasonBits.push("looks_like_player");
      }

      const fullArea = width * height;
      if (fullArea < 220 * 140) {
        score -= 6;
        reasonBits.push("smallish");
      }

      // Many legitimate autoplay/live players are muted.
      if (muted) {
        score -= 0.5;
        reasonBits.push("muted");
      }

      const occlusion = occlusionPenalty(video, rect);
      if (occlusion.penalty > 0) {
        score -= occlusion.penalty;
        if (occlusion.bit) {
          reasonBits.push(occlusion.bit);
        }
      }

      candidates.push({
        idx: i,
        video,
        score,
        visibleArea,
        ratio,
        readyState,
        paused,
        muted,
        src,
        width,
        height,
        reasonBits,
      });
    }

    const viable = candidates.filter((candidate) => candidate.score > -100);

    if (!viable.length) {
      if (
        this.last &&
        this.last.isConnected &&
        isActuallyVisible(this.last) &&
        !isFlashbackReplayVideo(this.last) &&
        canCaptureStream(this.last)
      ) {
        return {
          video: this.last,
          reason: "fallback_last_visible (no_viable_candidates)",
          candidates,
        };
      }

      this.last = null;
      return {
        video: null,
        reason: "no_viable_candidates",
        candidates,
      };
    }

    viable.sort((a, b) => b.score - a.score);

    const best = viable[0];
    let picked = best;

    // Sticky winner:
    // if previous winner remains viable and close enough in score,
    // prefer it to reduce flapping.
    if (this.last) {
      const lastCandidate = viable.find((candidate) => candidate.video === this.last) ?? null;

      if (lastCandidate) {
        const delta = best.score - lastCandidate.score;
        if (lastCandidate.score >= this.stickyMinScore && delta <= this.stickyDelta) {
          picked = lastCandidate;
        }
      }
    }

    if (picked.score < 2) {
      if (
        this.last &&
        this.last.isConnected &&
        isActuallyVisible(this.last) &&
        !isFlashbackReplayVideo(this.last) &&
        canCaptureStream(this.last)
      ) {
        return {
          video: this.last,
          reason: "fallback_last_visible (best_score_too_low)",
          candidates,
        };
      }

      this.last = null;
      return {
        video: null,
        reason: "best_score_too_low",
        candidates,
      };
    }

    // Final race-proof replay exclusion before commit.
    if (picked.video && isFlashbackReplayVideo(picked.video)) {
      const fallback =
        viable.find((candidate) => candidate.video && !isFlashbackReplayVideo(candidate.video)) ??
        null;

      if (!fallback) {
        if (
          this.last &&
          this.last.isConnected &&
          isActuallyVisible(this.last) &&
          !isFlashbackReplayVideo(this.last) &&
          canCaptureStream(this.last)
        ) {
          return {
            video: this.last,
            reason: "fallback_last_visible (winner_is_replay_race)",
            candidates,
          };
        }

        this.last = null;
        return {
          video: null,
          reason: "winner_is_replay_race",
          candidates,
        };
      }

      picked = fallback;
    }

    this.last = picked.video;
    this.lastAtMs = now;

    if (this.debug && opts?.dumpCandidates) {
      console.log(
        "[Flashback][VideoResolver] candidates",
        candidates.map((candidate) => ({
          idx: candidate.idx,
          score: Math.round(candidate.score * 10) / 10,
          visibleArea: Math.round(candidate.visibleArea),
          ratio: Math.round(candidate.ratio * 100) / 100,
          paused: candidate.paused,
          readyState: candidate.readyState,
          decoded: `${candidate.video.videoWidth || 0}x${candidate.video.videoHeight || 0}`,
          w: Math.round(candidate.width),
          h: Math.round(candidate.height),
          bits: candidate.reasonBits.join("|"),
          src: candidate.src,
          isLast: this.last === candidate.video,
        }))
      );
    }

    const stickyTag = picked.video === best.video ? "" : " | sticky_last=yes";

    return {
      video: picked.video,
      reason:
        `idx=${picked.idx} | score=${picked.score.toFixed(1)} | visibleArea=${Math.round(
          picked.visibleArea
        )} | ratio=${picked.ratio.toFixed(3)} | readyState=${picked.readyState} | paused=${
          picked.paused
        } | decoded=${picked.video.videoWidth || 0}x${picked.video.videoHeight || 0} | src=${
          hasSrc(picked.video) ? "yes" : "no"
        }` + stickyTag,
      candidates,
    };
  }
}
// src/ui/ReplayVideo.ts
// =================================
//
// ReplayVideo
// -----------
//
// Owns the replay <video> element used by Flashback UI.
//
// Architecture role
// -----------------
//
// ReplayVideo belongs to the UI layer.
//
// It is responsible ONLY for:
//
// - creating the replay video element
// - applying safe default playback flags
// - tagging the element as Flashback-owned replay UI
// - exposing minimal visibility helpers for replay presentation
//
// Non-responsibilities
// --------------------
//
// This module MUST NOT:
//
// - attach sources directly
// - own replay lifecycle/session state
// - own drag logic
// - decide playback routing policy
// - resolve page videos
//
// Important note
// --------------
//
// This replay video must be clearly marked so that VideoResolver /
// AutoStartManager do NOT confuse it with the platform's real live
// video element.
//
// If this element is not tagged, Flashback may detect its own replay
// player as the "best candidate", causing self-selection loops.
//

export class ReplayVideo {
  private readonly video: HTMLVideoElement;

  constructor() {
    this.video = document.createElement("video");

    this.video.playsInline = true;
    this.video.controls = false;
    this.video.autoplay = true;
    this.video.muted = true;

    // Hard tags expected by VideoResolver.
    this.video.dataset.fbRole = "replay";
    this.video.setAttribute("data-fb-role", "replay");
    this.video.setAttribute("data-flashback-replay", "1");

    // Helpful class hook for future styling/debugging.
    this.video.className = "flashback-replay-video";

    // Baseline presentation.
    // Important: this video is now a normal child of ReplayRoot's video host.
    // It must NOT position itself as a separate overlay.
    this.video.style.display = "block";
    this.video.style.width = "100%";
    this.video.style.maxWidth = "100%";
    this.video.style.height = "auto";
    this.video.style.background = "black";
    this.video.style.borderRadius = "12px";
    this.video.style.pointerEvents = "auto";
    this.video.style.objectFit = "contain";
    this.video.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
    this.video.style.boxSizing = "border-box";

    // IMPORTANT:
    // start hidden so idle replay UI does not show as a black box.
    this.hide();
  }

  getElement(): HTMLVideoElement {
    return this.video;
  }

  show(): void {
    this.video.style.display = "block";
    this.video.style.visibility = "visible";
    this.video.style.opacity = "1";
  }

  hide(): void {
    this.video.style.display = "none";
    this.video.style.visibility = "hidden";
    this.video.style.opacity = "0";
  }
}
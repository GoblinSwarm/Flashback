// src/ui/DragManager.ts
// =====================
//
// DragManager
// -----------
//
// This module owns minimal pointer-based dragging behavior for a UI element.
//
// Architecture role
// -----------------
// DragManager belongs to the UI layer.
//
// It is responsible ONLY for:
//
// - listening to pointer drag gestures from a handle element
// - moving a target element on screen
// - keeping drag state isolated from playback/runtime concerns
//
// Typical flow
// ------------
// UIOrchestrator
//        ↓
//   DragManager
//        ├─ handleElement (ReplayHeader)
//        └─ targetElement (ReplayRoot.shell)
//
// Responsibilities
// ----------------
// This module is responsible ONLY for:
//
// - binding pointer events
// - tracking drag state
// - updating target element position
// - keeping the target within the viewport
// - exposing lifecycle helpers
//
// Non-responsibilities
// --------------------
// This module MUST NOT:
//
// - know anything about replay sessions
// - know anything about DVR state
// - know anything about playback logic
// - decide UI visibility policy
//
// Design rule
// -----------
// DragManager must remain a pure DOM interaction helper.
//

type DragManagerOptions = {
  handleElement: HTMLElement;
  targetElement: HTMLElement;
};

export class DragManager {
  private readonly handleElement: HTMLElement;
  private readonly targetElement: HTMLElement;

  private isEnabled = false;
  private isDragging = false;
  private activePointerId: number | null = null;

  private dragOffsetX = 0;
  private dragOffsetY = 0;

  constructor(options: DragManagerOptions) {
    this.handleElement = options.handleElement;
    this.targetElement = options.targetElement;

    this.setupHandle();
  }

  private setupHandle(): void {
    this.handleElement.style.touchAction = "none";
    this.handleElement.style.cursor = "grab";
    this.handleElement.style.userSelect = "none";
  }

  enable(): void {
    if (this.isEnabled) return;
    this.isEnabled = true;

    this.handleElement.addEventListener("pointerdown", this.onPointerDown);
    this.handleElement.addEventListener("pointerup", this.onPointerUp);
    this.handleElement.addEventListener("pointercancel", this.onPointerCancel);
  }

  disable(): void {
    if (!this.isEnabled) return;
    this.isEnabled = false;

    this.handleElement.removeEventListener("pointerdown", this.onPointerDown);
    this.handleElement.removeEventListener("pointerup", this.onPointerUp);
    this.handleElement.removeEventListener("pointercancel", this.onPointerCancel);

    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);

    this.stopDragging();
  }

  dispose(): void {
    this.disable();
  }

  /**
   * Clears explicit drag positioning so the caller can re-apply
   * its normal anchored layout policy (right/bottom, centered, etc).
   */
  resetPositioning(): void {
    this.targetElement.style.left = "";
    this.targetElement.style.top = "";
    this.targetElement.style.right = "";
    this.targetElement.style.bottom = "";
    this.targetElement.style.transform = "";
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.isEnabled) return;
    if (event.button !== 0) return;
    if (this.isDragging) return;

    const target = event.target;
    if (target instanceof Element) {
      const blockedDragTarget = target.closest(
        '[data-flashback-no-drag="1"], button, input, select, textarea, a, label'
      );

      if (blockedDragTarget) {
        return;
      }
    }

    const rect = this.targetElement.getBoundingClientRect();

    this.isDragging = true;
    this.activePointerId = event.pointerId;
    this.dragOffsetX = event.clientX - rect.left;
    this.dragOffsetY = event.clientY - rect.top;

    this.prepareTargetForDragging(rect);

    this.handleElement.setPointerCapture?.(event.pointerId);

    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);

    this.handleElement.style.cursor = "grabbing";

    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.isDragging) return;
    if (this.activePointerId !== event.pointerId) return;

    const targetRect = this.targetElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const rawLeft = event.clientX - this.dragOffsetX;
    const rawTop = event.clientY - this.dragOffsetY;

    const maxLeft = Math.max(0, viewportWidth - targetRect.width);
    const maxTop = Math.max(0, viewportHeight - targetRect.height);

    const nextLeft = clamp(rawLeft, 0, maxLeft);
    const nextTop = clamp(rawTop, 0, maxTop);

    this.targetElement.style.left = `${Math.round(nextLeft)}px`;
    this.targetElement.style.top = `${Math.round(nextTop)}px`;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) return;
    this.stopDragging();
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) return;
    this.stopDragging();
  };

  private prepareTargetForDragging(rect: DOMRect): void {
    this.targetElement.style.left = `${Math.round(rect.left)}px`;
    this.targetElement.style.top = `${Math.round(rect.top)}px`;

    this.targetElement.style.right = "";
    this.targetElement.style.bottom = "";
    this.targetElement.style.transform = "";
  }

  private stopDragging(): void {
    if (this.activePointerId !== null) {
      this.handleElement.releasePointerCapture?.(this.activePointerId);
    }

    this.isDragging = false;
    this.activePointerId = null;

    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);

    this.handleElement.style.cursor = "grab";
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (!Number.isFinite(min)) return value;
  if (!Number.isFinite(max)) return value;
  return Math.max(min, Math.min(max, value));
}
const { screen } = require("electron");
const { WindowPositionUtil } = require("./windowConfig");
const debugLogger = require("./debugLogger");

// A press is only a drag once the cursor has actually travelled. Without this,
// every mousedown started moving the window at 60fps, so the few pixels a hand
// moves while clicking dragged the pill out from under the pointer -- it
// "ran away" from the click, and the click itself was often lost because the
// target moved before mouseup. Windows' own threshold (SM_CXDRAG) is 4px;
// 5 leaves a little room for a heavy click without feeling sticky.
const DRAG_START_THRESHOLD_PX = 5;

// Windows moves a window by being told a whole rectangle, and Electron converts
// that rectangle through physical pixels on the way. At a fractional display
// scale the round trip does not come back where it started, so every
// setPosition() hands the window back at least a pixel larger on each axis --
// electron/electron#9477, reported in 2017 and still reproducible here on
// Electron 41 (measured: 600 calls grew a 213x124 window to 1084x997).
//
// At the loop's 60fps that is roughly 60px per second in both directions, and
// because the pill is drawn 12px from the window's BOTTOM corner while the
// drag pins the window's TOP-LEFT to the cursor, the pill slides away from the
// pointer at exactly that rate and then sits at whatever distance the release
// left it. That is the "runaway", and it is why it was there from the start.
//
// The fix the issue thread converged on, and the only variant that measured
// stable here, is to pass the size explicitly on every move and to keep that
// size CONSTANT. Re-reading it each tick is not a fix: getBounds() faithfully
// reports the inflated window, so feeding it back grows just as fast
// (github.com/electron/electron/issues/9477#issuecomment-444443301).
//
// A tick is allowed to adopt a genuinely new size -- the size ladder can grow
// the window mid-drag -- but only when the change is far larger than the
// rounding this exists to absorb. At fractional DPI (e.g. 123% scaling on
// Windows 11), round-trip inflation can cause accumulated drift from earlier
// drags to exceed 4px (e.g. 211x122 .. 215x126 measured over consecutive drags),
// so tolerance is raised to 8px.
const DRAG_SIZE_ROUNDING_TOLERANCE_PX = 8;

// Backstop for a drag whose mouseup never arrived (the renderer went
// click-through mid-gesture, the window lost focus to a system dialog, a
// crashed renderer). Without it the tracker keeps the window glued to the
// cursor until the app restarts, which is far worse than ending a genuine
// drag early. No real drag of a small floating pill lasts a minute.
const MAX_DRAG_DURATION_MS = 60000;

class DragManager {
  constructor() {
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.mouseTrackingInterval = null;
    this.targetWindow = null;
    this.activeWindow = null;
    // Set at mousedown; the window does not move until the cursor leaves the
    // threshold around it, at which point the drag is "armed" for good.
    this.dragStartCursor = null;
    this.dragArmed = false;
    this.dragStartedAt = null;
    // The size the window had when the gesture began, and the size every move
    // during the gesture re-asserts. Never re-read from the window: see the
    // note on DRAG_SIZE_ROUNDING_TOLERANCE_PX.
    this.dragSize = null;
    // Optional geometry query for main window drags { getIntendedSize, getAnchor }.
    // When provided, commands the intended size from WINDOW_SIZES rather than
    // the inflated live size, so repeated drags cannot grow the window a pixel
    // at a time (measured: 211x122, 212x123, ... 215x126 over five drags).
    this.dragGeometry = null;
    // Commanded position (or start position before first move) for fallback
    // mid-drag offset recalculation when geometry is not provided.
    this.lastCommandedPosition = null;
  }

  setTargetWindow(window) {
    this.targetWindow = window;
  }

  /** The window's current size, or null if it cannot be read. */
  _readWindowSize(win) {
    try {
      const bounds = win.getBounds();
      if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
      return { width: bounds.width, height: bounds.height };
    } catch {
      return null;
    }
  }

  /** Determine the size that should be commanded for the window. If the caller
   *  provides geometry with an intended size (from WINDOW_SIZES) that agrees
   *  with the live size within DRAG_SIZE_ROUNDING_TOLERANCE_PX, use that intended
   *  size to break the electron#9477 fractional-DPI ratchet loop (measured: 1px
   *  inflation on every drag). Otherwise, fall back to the live window size. */
  _getTargetSize(win) {
    const live = this._readWindowSize(win);
    if (!live) return null;
    if (this.dragGeometry && typeof this.dragGeometry.getIntendedSize === "function") {
      const intended = this.dragGeometry.getIntendedSize();
      if (
        intended &&
        Number.isFinite(intended.width) &&
        Number.isFinite(intended.height) &&
        Math.abs(live.width - intended.width) <= DRAG_SIZE_ROUNDING_TOLERANCE_PX &&
        Math.abs(live.height - intended.height) <= DRAG_SIZE_ROUNDING_TOLERANCE_PX
      ) {
        return { width: intended.width, height: intended.height };
      }
    }
    return live;
  }

  /** The size this tick should command. Normally the one locked at drag start,
   *  so the fractional-DPI round trip has nothing to accumulate against. A
   *  window that genuinely changed size mid-gesture -- the size ladder opening
   *  or closing a menu while the pill is held -- moves by far more than the
   *  rounding tolerance. When adopting that new size, re-express dragOffset
   *  against the window's dock anchor so the grip does not jump (e.g. WITH_MENU
   *  240x280 closing to BASE 208x120 jumping the pill ~160 DIP above cursor). */
  _resolveDragSize(win) {
    const target = this._getTargetSize(win);
    if (!this.dragSize) {
      this.dragSize = target;
      return target || { width: 0, height: 0 };
    }
    if (!target) {
      return this.dragSize;
    }
    if (
      Math.abs(target.width - this.dragSize.width) > DRAG_SIZE_ROUNDING_TOLERANCE_PX ||
      Math.abs(target.height - this.dragSize.height) > DRAG_SIZE_ROUNDING_TOLERANCE_PX
    ) {
      const oldSize = this.dragSize;
      const newSize = target;
      const oldOffset = { ...this.dragOffset };
      const deltaWidth = newSize.width - oldSize.width;
      const deltaHeight = newSize.height - oldSize.height;

      let anchor = null;
      if (this.dragGeometry && typeof this.dragGeometry.getAnchor === "function") {
        anchor = this.dragGeometry.getAnchor();
        let deltaX = 0;
        if (anchor === "right" || anchor === "bottom-right" || anchor === "top-right") {
          deltaX = deltaWidth;
        } else if (anchor === "center" || anchor === "top-center") {
          deltaX = deltaWidth / 2;
        } else {
          // "left", "bottom-left", "top-left", or other: offset.x unchanged
          deltaX = 0;
        }
        const deltaY =
          anchor === "top" || (typeof anchor === "string" && anchor.startsWith("top-"))
            ? 0
            : deltaHeight;
        this.dragOffset = {
          x: this.dragOffset.x + deltaX,
          y: this.dragOffset.y + deltaY,
        };
      } else {
        // Without a known dock anchor, keep the grip on the same spot of the
        // window's content by following however far the resize moved the window.
        let livePos = null;
        try {
          const bounds = win.getBounds();
          if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
            livePos = { x: bounds.x, y: bounds.y };
          }
        } catch {}
        if (!livePos) {
          try {
            const pos = win.getPosition();
            if (Array.isArray(pos) && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
              livePos = { x: pos[0], y: pos[1] };
            }
          } catch {}
        }
        if (livePos && this.lastCommandedPosition) {
          this.dragOffset = {
            x: this.dragOffset.x + (this.lastCommandedPosition.x - livePos.x),
            y: this.dragOffset.y + (this.lastCommandedPosition.y - livePos.y),
          };
        }
      }

      debugLogger.info(
        "Window resized mid-drag; adopting the new size",
        {
          was: oldSize,
          now: newSize,
          anchor: anchor || null,
          oldOffset,
          newOffset: this.dragOffset,
        },
        "window-drag"
      );
      this.dragSize = newSize;
    }
    return this.dragSize;
  }

  /** The grip point, always inside the window. A renderer-measured offset is
   *  used as given; without one, the legacy subtraction is kept but clamped,
   *  because a grip outside the window can only be stale geometry and acting on
   *  it throws the window that far from the pointer. */
  _resolveGrabOffset(win, cursorPos, windowPos, grabOffset) {
    let size;
    try {
      const bounds = win.getBounds();
      size = { width: bounds.width, height: bounds.height };
    } catch {
      size = null;
    }

    const finite = (n) => typeof n === "number" && Number.isFinite(n);
    const fromRenderer = grabOffset && finite(grabOffset.x) && finite(grabOffset.y);
    const raw = fromRenderer
      ? { x: grabOffset.x, y: grabOffset.y }
      : { x: cursorPos.x - windowPos[0], y: cursorPos.y - windowPos[1] };

    if (!size) return raw;

    const clamped = {
      x: Math.min(Math.max(raw.x, 0), size.width),
      y: Math.min(Math.max(raw.y, 0), size.height),
    };
    if (clamped.x !== raw.x || clamped.y !== raw.y) {
      debugLogger.info(
        "Window drag grip fell outside the window; clamped",
        { raw, clamped, size, fromRenderer },
        "window-drag"
      );
    }
    return clamped;
  }

  /** Drags the configured target window by default; a caller that owns a
   *  different frameless window (the control panel's manual titlebar) passes
   *  it explicitly for the duration of one drag. */
  /** `grabOffset` is where inside the window the press landed, as the renderer
   *  measured it. Prefer it: deriving the same number here from cursor minus
   *  window position reads the window's position at IPC time, and a window that
   *  moved in that gap yields a grip point outside its own bounds -- observed as
   *  a 294px offset into a 208px window, which parks the pill a permanent 294px
   *  from the pointer for the rest of the gesture. */
  async startWindowDrag(windowOverride = null, grabOffset = null, geometry = null) {
    const win = windowOverride || this.targetWindow;
    if (!win || win.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    try {
      this.isDragging = true;
      this.activeWindow = win;
      this.dragGeometry = geometry || null;

      // Get current cursor position
      const cursorPos = screen.getCursorScreenPoint();
      const windowPos = win.getPosition();

      this.dragOffset = this._resolveGrabOffset(win, cursorPos, windowPos, grabOffset);
      this.dragSize = this._getTargetSize(win);
      this.lastCommandedPosition = Array.isArray(windowPos)
        ? { x: windowPos[0], y: windowPos[1] }
        : windowPos && Number.isFinite(windowPos.x) && Number.isFinite(windowPos.y)
          ? { x: windowPos.x, y: windowPos.y }
          : null;

      // Nothing moves until the pointer proves this is a drag and not a click.
      this.dragStartCursor = { x: cursorPos.x, y: cursorPos.y };
      this.dragArmed = false;
      this.dragStartedAt = Date.now();

      // Start tracking mouse movements
      this.setupMouseTracking();

      debugLogger.info(
        "Window drag started",
        // The window's size is logged alongside the grip because the two only
        // ever disagreed when setPosition was inflating it; if a grip outside
        // the window is ever seen again, that pair says immediately whether
        // the window grew or the reading is wrong.
        { cursor: cursorPos, windowPos, offset: this.dragOffset, size: this.dragSize },
        "window-drag"
      );
      return { success: true };
    } catch (error) {
      console.error("Failed to start window drag:", error);
      this.isDragging = false;
      this.dragGeometry = null;
      this.lastCommandedPosition = null;
      return { success: false, message: error.message };
    }
  }

  async stopWindowDrag(reason = "renderer") {
    try {
      // Which path ended the drag, and how long it ran, is the whole diagnosis
      // when the pill "runs away": a drag that only ever ends by "timeout" means
      // the release never reached us.
      if (this.isDragging) {
        debugLogger.info(
          "Window drag ending",
          {
            reason,
            durationMs: this.dragStartedAt ? Date.now() - this.dragStartedAt : null,
            armed: this.dragArmed,
          },
          "window-drag"
        );
      }
      this.isDragging = false;
      this.activeWindow = null;
      this.dragStartCursor = null;
      this.dragArmed = false;
      this.dragStartedAt = null;
      this.dragSize = null;
      this.dragGeometry = null;
      this.lastCommandedPosition = null;
      this.stopMouseTracking();
      debugLogger.info("Window drag stopped", undefined, "window-drag");
      return { success: true };
    } catch (error) {
      console.error("Failed to stop window drag:", error);
      return { success: false, message: error.message };
    }
  }

  setupMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
    }

    this.mouseTrackingInterval = setInterval(() => {
      if (!this.isDragging || !this.activeWindow || this.activeWindow.isDestroyed()) return;
      if (this.dragStartedAt && Date.now() - this.dragStartedAt > MAX_DRAG_DURATION_MS) {
        this.stopWindowDrag("timeout");
        return;
      }
      this.updateWindowPosition();
    }, 16); // ~60fps
  }

  updateWindowPosition() {
    try {
      const cursorPos = screen.getCursorScreenPoint();

      // Hold still until the pointer has travelled far enough to mean it.
      if (!this.dragArmed) {
        if (!this.dragStartCursor) {
          this.dragArmed = true;
        } else {
          const dx = cursorPos.x - this.dragStartCursor.x;
          const dy = cursorPos.y - this.dragStartCursor.y;
          if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD_PX) return;
          this.dragArmed = true;
        }
      }

      const { width, height } = this._resolveDragSize(this.activeWindow);
      const x = cursorPos.x - this.dragOffset.x;
      const y = cursorPos.y - this.dragOffset.y;

      // Constrain against the display the window lands on, not the one under the
      // cursor: near a boundary between differently sized displays, the cursor's
      // work area permits positions that leave the window in dead space.
      const display = screen.getDisplayNearestPoint({
        x: x + width / 2,
        y: y + height / 2,
      });
      const maxTopOverhang =
        this.dragGeometry && typeof this.dragGeometry.getMaxTopOverhang === "function"
          ? this.dragGeometry.getMaxTopOverhang()
          : 0;
      const clamped = WindowPositionUtil.clampToWorkArea(
        { x, y, width, height },
        display,
        { maxTopOverhang }
      );

      // setBounds with the locked size, never setPosition: see the note at the
      // top of the file. The size has to travel with every single move, or
      // Windows re-derives it from the rounded rectangle and inflates it.
      this.activeWindow.setBounds({ x: clamped.x, y: clamped.y, width, height });
      this.lastCommandedPosition = { x: clamped.x, y: clamped.y };
    } catch (error) {
      console.error("Error updating window position:", error);
      this.stopWindowDrag("error");
    }
  }

  stopMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
      this.mouseTrackingInterval = null;
    }
  }

  isDragActive() {
    return this.isDragging;
  }

  getDragOffset() {
    return { ...this.dragOffset };
  }

  cleanup() {
    this.stopWindowDrag("cleanup");
    this.targetWindow = null;
  }
}

module.exports = DragManager;

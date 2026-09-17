/**
 * Gives back the click Windows ate on a window that cannot be activated.
 *
 * The pill window is created `focusable: false` -- it must never pull focus
 * away from whatever the user is dictating into -- which leaves WS_EX_NOACTIVATE
 * on its HWND. When a press lands on such a window while it is not the active
 * window, Chromium answers WM_MOUSEACTIVATE with MA_NOACTIVATEANDEAT: do not
 * activate, *and discard the press*. The page never sees `mousedown`, and with
 * no press there is no `click` either -- so the pill sat there ignoring the
 * user's first click after every launch.
 *
 * Measured on the user's machine over several sessions (debug logs): the
 * release of a swallowed press IS delivered. A swallowed left click arrives at
 * the page as a lone `mouseup` -- no `pointerdown`, no `mousedown`, no `click`
 * anywhere around it. The right-click menu always worked for the mirror-image
 * reason: Windows raises `contextmenu` off the button-up, which is never eaten.
 *
 * So `mouseup` with no `mousedown` before it means "Windows ate this press",
 * and we dispatch the `click` the page was owed. This is deliberately generic
 * rather than a handler on the pill: every control the window can show -- the
 * pill, the cancel button, the menu, the transcript panel -- is behind the same
 * swallowed press, and one listener pair covers all of them.
 *
 * Harmless on macOS and Linux, where presses are delivered and the matching
 * `mousedown` always arrives first.
 */

// A press this old belongs to a gesture whose release never reached us (let go
// outside the window, for instance). Without the expiry, that stale press would
// silently eat the recovery of the next swallowed click.
const DEFAULT_MAX_PRESS_LIFETIME_MS = 30000;

const LEFT_BUTTON = 0;

interface ListenerTarget {
  addEventListener(type: string, listener: (event: any) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: any) => void, capture?: boolean): void;
}

interface DocumentLike {
  elementFromPoint?(x: number, y: number): any;
}

/** The subset of MouseEvent this module reads; keeps the tests DOM-free. */
export interface MouseEventLike {
  button: number;
  timeStamp: number;
  target?: any;
  view?: any;
  clientX?: number;
  clientY?: number;
  screenX?: number;
  screenY?: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export interface SwallowedPressClickRecoveryOptions {
  /** Defaults to `window`. */
  target?: ListenerTarget | null;
  /** Defaults to `document`; only used to re-aim a click at the cursor. */
  document?: DocumentLike | null;
  /** Defaults to `queueMicrotask`. */
  schedule?: (callback: () => void) => void;
  /** Defaults to `new MouseEvent("click", init)`. */
  createClickEvent?: (init: Record<string, unknown>) => any;
  onRecovered?: (info: { target: any; retargeted: boolean }) => void;
  maxPressLifetimeMs?: number;
}

const resolveClickTarget = (
  origin: any,
  doc: DocumentLike | null,
  clientX: number,
  clientY: number
) => {
  // The mouseup handlers may have re-rendered the element out from under us --
  // the hover-only chevron is one of the things the user presses -- and a click
  // dispatched at a detached node goes nowhere. Whatever sits under the cursor
  // now is what a real click would have hit.
  if (origin && origin.isConnected !== false) return origin;
  if (typeof doc?.elementFromPoint !== "function") return null;
  return doc.elementFromPoint(clientX, clientY) ?? null;
};

export function installSwallowedPressClickRecovery(
  options: SwallowedPressClickRecoveryOptions = {}
): () => void {
  const target =
    options.target ??
    (typeof window === "undefined" ? null : (window as unknown as ListenerTarget));
  if (!target || typeof target.addEventListener !== "function") return () => {};

  const doc =
    options.document ?? (typeof document === "undefined" ? null : (document as DocumentLike));
  const schedule = options.schedule ?? ((callback: () => void) => queueMicrotask(callback));
  const createClickEvent =
    options.createClickEvent ??
    ((init: Record<string, unknown>) => new MouseEvent("click", init as MouseEventInit));
  const maxPressLifetimeMs = options.maxPressLifetimeMs ?? DEFAULT_MAX_PRESS_LIFETIME_MS;

  let pressTimeStamp: number | null = null;

  const handlePress = (event: MouseEventLike) => {
    if (event.button !== LEFT_BUTTON) return;
    pressTimeStamp = event.timeStamp;
  };

  const handleRelease = (event: MouseEventLike) => {
    if (event.button !== LEFT_BUTTON) return;
    const press = pressTimeStamp;
    pressTimeStamp = null;
    // The press arrived, so the browser is about to fire its own click.
    if (press !== null && event.timeStamp - press <= maxPressLifetimeMs) return;

    const origin = event.target ?? null;
    const clientX = event.clientX ?? 0;
    const clientY = event.clientY ?? 0;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: event.view ?? (typeof window === "undefined" ? undefined : window),
      detail: 1,
      button: LEFT_BUTTON,
      buttons: 0,
      clientX,
      clientY,
      screenX: event.screenX ?? 0,
      screenY: event.screenY ?? 0,
      ctrlKey: Boolean(event.ctrlKey),
      altKey: Boolean(event.altKey),
      shiftKey: Boolean(event.shiftKey),
      metaKey: Boolean(event.metaKey),
    };

    // Deferred so the click lands after the page's own mouseup handlers, the
    // order a real click would have come in. (This listener runs in the capture
    // phase, before them, so that nothing can stopPropagation() its way out of
    // being fixed.)
    schedule(() => {
      const node = resolveClickTarget(origin, doc, clientX, clientY);
      if (!node || typeof node.dispatchEvent !== "function") return;
      node.dispatchEvent(createClickEvent(init));
      options.onRecovered?.({ target: node, retargeted: node !== origin });
    });
  };

  target.addEventListener("mousedown", handlePress, true);
  target.addEventListener("mouseup", handleRelease, true);

  return () => {
    target.removeEventListener("mousedown", handlePress, true);
    target.removeEventListener("mouseup", handleRelease, true);
  };
}

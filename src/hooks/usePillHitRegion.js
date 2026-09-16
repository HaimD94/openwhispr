import { useEffect } from "react";

// The pill window is 208x120 but the pill itself is 40x40 idle. On Windows the
// main process decides click-through by polling the cursor against a rectangle,
// and it used to guess that rectangle from the widest state the pill can reach
// -- roughly six times the area of an idle pill, all of it an invisible wall
// over whatever sits behind it. This reports the box the pill actually occupies
// so the guess is never needed.
//
// Elements marked data-pill-hit are the ones that must catch clicks; the union
// of their boxes is the region. The tooltip is deliberately not marked: it is
// not clickable, and including it would block the space above the pill again.

// Enough that a click on the pill's outer edge still lands, small enough that
// the dead space stays invisible to the user.
const HIT_PADDING_PX = 4;

// CSS transitions (the pill travelling between docks, the cancel button
// emerging) move the box without firing any DOM event, so this is measured on a
// timer rather than observed. Two getBoundingClientRect calls on a 208x120
// window is far cheaper than the layout thrash of an rAF loop.
const MEASURE_INTERVAL_MS = 120;

const sameRect = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
};

const measureRegion = () => {
  const nodes = document.querySelectorAll("[data-pill-hit]");
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    // A collapsed box is a control that has animated out; it owns no clicks.
    if (rect.width <= 0 || rect.height <= 0) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }

  if (!Number.isFinite(left) || right <= left || bottom <= top) return null;

  return {
    x: left - HIT_PADDING_PX,
    y: top - HIT_PADDING_PX,
    width: right - left + HIT_PADDING_PX * 2,
    height: bottom - top + HIT_PADDING_PX * 2,
  };
};

/**
 * Reports the pill's real interactive box to the main process.
 * @param {boolean} enabled false while the pill is hidden or non-interactive,
 *   which clears the region so nothing is left blocking the screen.
 */
export default function usePillHitRegion(enabled) {
  useEffect(() => {
    const send = window.electronAPI?.setPillHitRegion;
    if (typeof send !== "function") return;

    let last;
    let sentAtLeastOnce = false;

    const publish = () => {
      const region = enabled ? measureRegion() : null;
      if (sentAtLeastOnce && sameRect(region, last)) return;
      last = region;
      sentAtLeastOnce = true;
      send(region);
    };

    publish();
    const timer = setInterval(publish, MEASURE_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      // Leaving a stale region behind would keep a box interactive over a pill
      // that is gone, so this always ends by clearing it.
      send(null);
    };
  }, [enabled]);
}

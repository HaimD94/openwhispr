// Pausing media has to finish before the microphone opens: the capture keeps
// pre-roll from the moment the device opens, and on Windows the pause itself
// is a PowerShell GSMTC round trip of about a second. Pausing after the start
// (the old order) let that second of music or video into the recording.
//
// The wait is capped so a stuck pause can never hold the recording back for
// long. A pause that outlives the cap still lands, and the main process
// serializes it ahead of any later resume, so nothing is left paused.
export const MEDIA_PAUSE_WAIT_CAP_MS = 1500;

export async function pauseMediaBeforeCapture(
  pauseMediaPlayback,
  { capMs = MEDIA_PAUSE_WAIT_CAP_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}
) {
  if (typeof pauseMediaPlayback !== "function") return { requested: false, timedOut: false };

  let timer;
  const pause = Promise.resolve()
    .then(() => pauseMediaPlayback())
    .then(
      () => ({ requested: true, timedOut: false }),
      () => ({ requested: true, timedOut: false })
    );
  const cap = new Promise((resolve) => {
    timer = setTimer(() => resolve({ requested: true, timedOut: true }), capMs);
  });

  try {
    return await Promise.race([pause, cap]);
  } finally {
    clearTimer(timer);
  }
}

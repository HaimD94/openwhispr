const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/pauseMediaBeforeCapture.js");

/** Fake timers: the cap fires only when the test says so. */
function makeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer(fn, ms) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    fire() {
      for (const [id, { fn }] of pending) {
        pending.delete(id);
        fn();
      }
    },
  };
}

test("waits for the pause to finish before returning", async () => {
  const { pauseMediaBeforeCapture } = await load();
  const timers = makeTimers();
  let finishPause;
  let returned = false;

  const run = pauseMediaBeforeCapture(
    () => new Promise((resolve) => (finishPause = resolve)),
    timers
  ).then((result) => {
    returned = true;
    return result;
  });

  await new Promise((r) => setImmediate(r));
  assert.equal(returned, false, "must not return while the pause is still running");

  finishPause(true);
  assert.deepEqual(await run, { requested: true, timedOut: false });
  assert.equal(timers.pending.size, 0, "the cap timer is cleared");
});

test("a stuck pause holds the start back only until the cap", async () => {
  const { pauseMediaBeforeCapture, MEDIA_PAUSE_WAIT_CAP_MS } = await load();
  const timers = makeTimers();

  const run = pauseMediaBeforeCapture(() => new Promise(() => {}), timers);
  await new Promise((r) => setImmediate(r));
  assert.equal([...timers.pending.values()][0].ms, MEDIA_PAUSE_WAIT_CAP_MS);

  timers.fire();
  assert.deepEqual(await run, { requested: true, timedOut: true });
});

test("a failing pause never blocks or throws into the recording start", async () => {
  const { pauseMediaBeforeCapture } = await load();
  const timers = makeTimers();

  assert.deepEqual(
    await pauseMediaBeforeCapture(() => Promise.reject(new Error("GSMTC down")), timers),
    { requested: true, timedOut: false }
  );
  assert.deepEqual(
    await pauseMediaBeforeCapture(() => {
      throw new Error("sync throw");
    }, timers),
    { requested: true, timedOut: false }
  );
});

test("no pause bridge (older preload) is a no-op", async () => {
  const { pauseMediaBeforeCapture } = await load();
  assert.deepEqual(await pauseMediaBeforeCapture(undefined), {
    requested: false,
    timedOut: false,
  });
});

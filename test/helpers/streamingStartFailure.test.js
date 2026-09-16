const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationStreamingRouting.js");

// These conditions used to live inline inside startStreamingRecording, where
// reaching them meant standing up the whole microphone pipeline -- so the rule
// deciding whether a user keeps or loses a dictation had no coverage at all.

test("a missing streaming API falls back silently", async () => {
  const { resolveStreamingStartFailure } = await load();

  const result = resolveStreamingStartFailure({ providerName: "openai-realtime", code: "NO_API" });

  assert.equal(result.fallback, true);
  // No notice: an app with no streaming key configured is not a degradation of
  // anything the user chose, so saying so on every recording would be noise.
  assert.equal(result.notice, null);
});

test("an unreachable cloud falls back to the local engine, and says so", async () => {
  const { resolveStreamingStartFailure } = await load();

  const result = resolveStreamingStartFailure({
    providerName: "openai-realtime",
    code: "NETWORK_ERROR",
    useLocalWhisper: true,
  });

  assert.equal(result.fallback, true);
  assert.equal(result.notice.messageKey, "streaming.errors.cloudUnreachable.fallback");
});

test("an unreachable cloud with no local engine still fails", async () => {
  const { resolveStreamingStartFailure } = await load();

  // Nothing else can produce a transcript, so falling back would just lose the
  // recording quietly instead of reporting the problem.
  const result = resolveStreamingStartFailure({
    providerName: "openai-realtime",
    code: "NETWORK_ERROR",
    useLocalWhisper: false,
  });

  assert.equal(result.fallback, false);
  assert.equal(result.notice, null);
});

test("Gemini Live falls back to its batch twin whatever the failure was", async () => {
  const { resolveStreamingStartFailure } = await load();

  // The point of the rule: the batch sibling is the same provider, the same
  // key and also free, so no failure code is worth losing the dictation over.
  for (const code of ["NETWORK_ERROR", "QUOTA_EXCEEDED", "SERVER_ERROR", undefined]) {
    const result = resolveStreamingStartFailure({ providerName: "gemini-live", code });
    assert.equal(result.fallback, true, `code ${code} should fall back`);
    assert.equal(result.notice.messageKey, "streaming.errors.liveUnavailable.fallback");
    assert.equal(result.notice.code, code);
  }
});

test("a provider with no batch twin still throws", async () => {
  const { resolveStreamingStartFailure } = await load();

  for (const providerName of ["openai-realtime", "deepgram", "assemblyai", "corti", "tinfoil-realtime"]) {
    const result = resolveStreamingStartFailure({ providerName, code: "SERVER_ERROR" });
    assert.equal(result.fallback, false, `${providerName} should not silently fall back`);
  }
});

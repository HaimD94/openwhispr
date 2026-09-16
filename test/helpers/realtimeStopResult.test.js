const test = require("node:test");
const assert = require("node:assert/strict");
const { reportedModelName, stopRealtimeSession } = require("../../src/helpers/realtimeStopResult");
const GeminiLiveStreaming = require("../../src/helpers/geminiLiveStreaming");
const OpenAIRealtimeStreaming = require("../../src/helpers/openaiRealtimeStreaming");

// The bug: the shared dictation realtime stop channel returned only the text,
// the renderer filled the gap with Deepgram's "nova-3", and every Gemini Live
// dictation landed in history labelled with a model it never used.

test("Gemini Live reports its model under the name the rest of the app uses", async () => {
  // A real client, never connected: disconnect() returns straight away with no
  // socket, so this runs the actual class without touching the network.
  const result = await stopRealtimeSession(new GeminiLiveStreaming());
  assert.equal(result.model, "gemini-3.5-transcribe-live");
  assert.equal(result.success, true);
  assert.equal(result.text, "");
});

test("OpenAI Realtime, which shares the channel, reports its model too", async () => {
  const result = await stopRealtimeSession(new OpenAIRealtimeStreaming());
  assert.equal(result.model, "gpt-4o-mini-transcribe");
});

test("the model is read before disconnect can reset it", async () => {
  const streaming = {
    model: "models/gemini-3.5-transcribe-live",
    async disconnect() {
      this.model = null;
      return { text: "שלום" };
    },
  };
  const result = await stopRealtimeSession(streaming);
  assert.equal(result.model, "gemini-3.5-transcribe-live");
  assert.equal(result.text, "שלום");
});

test("an unknown model is left out, so the renderer's own fallback still applies", async () => {
  // Deliberately absent rather than null: audioManager does
  // `stopResult?.model || "nova-3"`, and that Deepgram default is not ours to change.
  const result = await stopRealtimeSession({ disconnect: async () => ({ text: "hi" }) });
  assert.equal(Object.hasOwn(result, "model"), false);
  assert.equal(result.text, "hi");
});

test("a failed disconnect still stops cleanly and keeps the model", async () => {
  const result = await stopRealtimeSession({
    model: "gpt-4o-transcribe",
    disconnect: async () => {
      throw new Error("socket gone");
    },
  });
  assert.deepEqual(result, { success: true, text: "", model: "gpt-4o-transcribe" });
});

test("no session at all returns the same empty result as before", async () => {
  assert.deepEqual(await stopRealtimeSession(null), { success: true, text: "" });
});

test("only the wire prefix is stripped", () => {
  assert.equal(reportedModelName("models/gemini-3.5-transcribe-live"), "gemini-3.5-transcribe-live");
  assert.equal(reportedModelName("gemini-3.5-transcribe-live"), "gemini-3.5-transcribe-live");
  assert.equal(reportedModelName("gpt-4o-mini-transcribe"), "gpt-4o-mini-transcribe");
  assert.equal(reportedModelName("models/"), undefined);
  assert.equal(reportedModelName(""), undefined);
  assert.equal(reportedModelName(undefined), undefined);
});

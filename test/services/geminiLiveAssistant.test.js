const test = require("node:test");
const assert = require("node:assert/strict");

const loadModule = () => import("../../src/services/geminiLiveAssistant.ts");

// Shapes taken from a real gemini-3.8-live session (probe-conversation.js).
const pcmBase64 = (samples) => Buffer.from(Int16Array.from(samples).buffer).toString("base64");

test("parseLiveServerMessage reads setupComplete as ready", async () => {
  const { parseLiveServerMessage } = await loadModule();
  assert.deepEqual(parseLiveServerMessage({ setupComplete: {} }), [{ type: "ready" }]);
});

test("parseLiveServerMessage ignores messages it does not know", async () => {
  const { parseLiveServerMessage } = await loadModule();
  assert.deepEqual(parseLiveServerMessage({ sessionResumptionUpdate: { newHandle: "x" } }), []);
  assert.deepEqual(parseLiveServerMessage(null), []);
  assert.deepEqual(parseLiveServerMessage("nope"), []);
});

test("parseLiveServerMessage returns transcripts and decodes audio", async () => {
  const { parseLiveServerMessage } = await loadModule();
  const events = parseLiveServerMessage({
    serverContent: {
      inputTranscription: { text: "hello" },
      modelTurn: {
        parts: [{ inlineData: { mimeType: "audio/pcm", data: pcmBase64([1, -2, 300]) } }],
      },
      outputTranscription: { text: "hi" },
    },
  });
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { type: "input", text: "hello" });
  assert.equal(events[1].type, "audio");
  assert.deepEqual(Array.from(events[1].pcm), [1, -2, 300]);
  assert.deepEqual(events[2], { type: "output", text: "hi" });
});

test("parseLiveServerMessage puts an interruption before the audio it invalidates", async () => {
  const { parseLiveServerMessage } = await loadModule();
  const events = parseLiveServerMessage({
    serverContent: {
      interrupted: true,
      modelTurn: { parts: [{ inlineData: { data: pcmBase64([5]) } }] },
    },
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ["interrupted", "audio"]
  );
});

test("parseLiveServerMessage reports turnComplete last", async () => {
  const { parseLiveServerMessage } = await loadModule();
  const events = parseLiveServerMessage({
    serverContent: { outputTranscription: { text: "done" }, turnComplete: true },
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ["output", "turnComplete"]
  );
});

test("encodePcmBase64 round-trips through the parser's decoder", async () => {
  const { encodePcmBase64, parseLiveServerMessage } = await loadModule();
  const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
  const [event] = parseLiveServerMessage({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: encodePcmBase64(samples) } }] } },
  });
  assert.deepEqual(Array.from(event.pcm), Array.from(samples));
});

test("encodePcmBase64 handles audio larger than one apply() chunk", async () => {
  const { encodePcmBase64, parseLiveServerMessage } = await loadModule();
  const samples = new Int16Array(50000).map((_, i) => (i % 2000) - 1000);
  const [event] = parseLiveServerMessage({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: encodePcmBase64(samples) } }] } },
  });
  assert.equal(event.pcm.length, samples.length);
  assert.deepEqual(Array.from(event.pcm.subarray(0, 5)), Array.from(samples.subarray(0, 5)));
  assert.equal(event.pcm[49999], samples[49999]);
});

test("LiveTurnCollector appends fragments and flushes one turn on turnComplete", async () => {
  const { LiveTurnCollector } = await loadModule();
  const collector = new LiveTurnCollector();
  assert.equal(collector.push({ type: "input", text: "What is " }), null);
  assert.equal(collector.push({ type: "input", text: "the capital?" }), null);
  assert.equal(collector.push({ type: "output", text: "Paris" }), null);
  assert.equal(collector.push({ type: "output", text: "." }), null);
  assert.deepEqual(collector.push({ type: "turnComplete" }), {
    user: "What is the capital?",
    assistant: "Paris.",
  });
  assert.equal(collector.push({ type: "turnComplete" }), null);
});

test("LiveTurnCollector cuts a turn at an interruption and starts the next cleanly", async () => {
  const { LiveTurnCollector } = await loadModule();
  const collector = new LiveTurnCollector();
  collector.push({ type: "input", text: "tell me a story" });
  collector.push({ type: "output", text: "Once upon" });
  assert.deepEqual(collector.push({ type: "interrupted" }), {
    user: "tell me a story",
    assistant: "Once upon",
  });
  collector.push({ type: "input", text: "stop" });
  assert.deepEqual(collector.push({ type: "turnComplete" }), { user: "stop", assistant: "" });
});

test("LiveTurnCollector exposes the unfinished turn for captions", async () => {
  const { LiveTurnCollector } = await loadModule();
  const collector = new LiveTurnCollector();
  collector.push({ type: "input", text: "  partial " });
  assert.deepEqual(collector.pending, { user: "partial", assistant: "" });
});

test("buildLiveSetupMessage asks for audio with both transcripts, never text", async () => {
  const { buildLiveSetupMessage } = await loadModule();
  const { setup } = buildLiveSetupMessage("models/gemini-3.8-live");
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
});

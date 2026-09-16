const test = require("node:test");
const assert = require("node:assert/strict");
const GeminiLiveStreaming = require("../../src/helpers/geminiLiveStreaming");
const { DEFAULT_INPUT_RATE } = GeminiLiveStreaming;

// Dictation captures at 16kHz, note recording at 24kHz, and the two produce
// measurably different transcripts. Converting between them in JS was tried
// and came out worse than declaring the real rate, so what matters now is that
// the declared rate is never a guess (GEMINI-LIVE-PATCH/FACTS.md).

function captureSentChunks(engine) {
  const sent = [];
  engine.ws = {
    readyState: 1, // WebSocket.OPEN
    send: (payload) => sent.push(JSON.parse(payload)),
  };
  return sent;
}

test("the default rate is what dictation captures at", () => {
  assert.equal(DEFAULT_INPUT_RATE, 16000);
  assert.equal(new GeminiLiveStreaming().inputRate, DEFAULT_INPUT_RATE);
});

test("chunks declare the rate the audio was captured at", () => {
  const engine = new GeminiLiveStreaming();
  engine.inputRate = 24000;
  const sent = captureSentChunks(engine);

  engine._sendChunk(Buffer.alloc(64));

  assert.equal(sent[0].realtimeInput.mediaChunks[0].mimeType, "audio/pcm;rate=24000");
});

test("audio is sent through untouched", () => {
  // A conversion step here was measured to garble speech; the bytes handed in
  // are the bytes that must go out.
  const engine = new GeminiLiveStreaming();
  const sent = captureSentChunks(engine);
  const audio = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);

  engine._sendChunk(audio);

  const data = sent[0].realtimeInput.mediaChunks[0].data;
  assert.deepEqual(Buffer.from(data, "base64"), audio);
  assert.equal(engine.audioBytesSent, audio.length);
});

test("nothing is sent when the socket is not open", () => {
  const engine = new GeminiLiveStreaming();
  const sent = captureSentChunks(engine);
  engine.ws.readyState = 3; // CLOSED

  engine._sendChunk(Buffer.alloc(16));

  assert.equal(sent.length, 0);
});

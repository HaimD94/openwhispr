const test = require("node:test");
const assert = require("node:assert/strict");

// This file was silently dead: geminiTranscription pulls in debugLogger, which
// reads app.isPackaged at import time, and outside Electron require("electron")
// resolves to the path of the binary -- so every test in here failed before the
// first assertion ran. A stub registered ahead of the require brings them back.
// Only the members debugLogger touches at construction are needed.
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      net: undefined,
      app: {
        isPackaged: false,
        isReady: () => false,
        getVersion: () => "0.0.0-test",
        getAppPath: () => process.cwd(),
        getPath: () => require("node:os").tmpdir(),
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { transcribeWithGemini } = require("../../src/helpers/geminiTranscription");

const AUDIO = Buffer.from("fake-audio-bytes");

function makeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  return { fetchImpl, calls };
}

function requestBody(calls) {
  return JSON.parse(calls[0].init.body);
}

test("posts JSON with the key header to the Interactions endpoint", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "hello" });

  const result = await transcribeWithGemini(
    { audioBuffer: AUDIO, model: "gemini-3.5-transcribe", contentType: "audio/mp3", apiKey: "k1" },
    fetchImpl
  );

  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "application/json",
    "x-goog-api-key": "k1",
  });
  const body = requestBody(calls);
  assert.equal(body.model, "gemini-3.5-transcribe");
  assert.deepEqual(body.input, [
    { type: "audio", data: AUDIO.toString("base64"), mime_type: "audio/mp3" },
  ]);
  assert.equal(result.text, "hello");
  assert.equal(result.model, "gemini-3.5-transcribe");
});

test("defaults the model and omits generation_config when empty", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "ok" });

  await transcribeWithGemini(
    { audioBuffer: AUDIO, contentType: "audio/webm", language: "auto", apiKey: "k" },
    fetchImpl
  );

  const body = requestBody(calls);
  assert.equal(body.model, "gemini-3.5-transcribe");
  assert.equal(body.input[0].mime_type, "audio/webm");
  assert.equal("generation_config" in body, false, "auto language must not send a config");
});

test("language and keyterms land in transcription_config", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "ok" });

  await transcribeWithGemini(
    { audioBuffer: AUDIO, language: "de", keyterms: ["OpenWhispr", "Gizmo"], apiKey: "k" },
    fetchImpl
  );

  assert.deepEqual(requestBody(calls).generation_config, {
    transcription_config: {
      language_codes: ["de"],
      custom_vocabulary: ["OpenWhispr", "Gizmo"],
    },
  });
});

test("falls back to joining step text when output_text is absent", async () => {
  const { fetchImpl } = makeFetch({
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          { type: "text", text: "Hello" },
          { type: "word_info", text: "ignored" },
          { type: "text", text: "world" },
        ],
      },
    ],
  });

  const { text } = await transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl);
  assert.equal(text, "Hello world");
});

test("a missing key fails before any request is made", async () => {
  const { fetchImpl, calls } = makeFetch({});
  await assert.rejects(
    transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "  " }, fetchImpl),
    (error) => error.code === "API_KEY_MISSING"
  );
  assert.equal(calls.length, 0);
});

test("HTTP statuses map to coded errors without leaking the key", async () => {
  const statusError = async (status, body = "denied") => {
    const fetchImpl = async () => ({
      ok: false,
      status,
      text: async () => body,
    });
    return transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "sk-secret" }, fetchImpl).then(
      () => assert.fail(`status ${status} must reject`),
      (error) => error
    );
  };

  for (const status of [401, 403]) {
    const error = await statusError(status);
    assert.equal(error.code, "INVALID_KEY");
    assert.equal(error.message.includes("sk-secret"), false);
  }
  assert.equal((await statusError(429)).code, "PROVIDER_RATE_LIMITED");
  assert.equal((await statusError(500)).code, "SERVER_ERROR");

  // Google's real answer to a bad key, captured from the live API.
  const badKey = await statusError(400, '{"error":{"reason":"API_KEY_INVALID"}}');
  assert.equal(badKey.code, "INVALID_KEY");
  assert.equal(badKey.message.includes("sk-secret"), false);

  assert.equal((await statusError(400, "unsupported mime")).code, undefined);
});

test("a failed interaction status rejects even on HTTP 200", async () => {
  const { fetchImpl } = makeFetch({
    status: "failed",
    error: { code: "api_error", message: "decode error" },
  });
  await assert.rejects(
    transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl),
    /Gemini transcription failed: decode error/
  );
});

test("any non-completed status rejects instead of returning empty text", async () => {
  const { fetchImpl } = makeFetch({ status: "budget_exceeded", steps: [] });
  await assert.rejects(
    transcribeWithGemini({ audioBuffer: AUDIO, apiKey: "k" }, fetchImpl),
    /did not complete \(status: budget_exceeded\)/
  );
});

test("canonical mime types map onto Gemini's documented ones", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "ok" });

  await transcribeWithGemini(
    { audioBuffer: AUDIO, contentType: "audio/mpeg", apiKey: "k" },
    fetchImpl
  );

  assert.equal(requestBody(calls).input[0].mime_type, "audio/mp3");
});

// The live id exists only on the Live WebSocket API. Sending it here returns
// 400 "Model 'gemini-3.5-transcribe-live' not found", which is what anyone
// dictating with the live model hit on every re-transcribe from history.
test("swaps the live-only model for its batch equivalent", async () => {
  for (const requested of ["gemini-3.5-transcribe-live", "models/gemini-3.5-transcribe-live"]) {
    const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "hi" });

    const result = await transcribeWithGemini(
      { audioBuffer: AUDIO, model: requested, contentType: "audio/mp3", apiKey: "k1" },
      fetchImpl
    );

    assert.equal(requestBody(calls).model, "gemini-3.5-transcribe", `sent for ${requested}`);
    assert.equal(result.model, "gemini-3.5-transcribe");
  }
});

test("leaves every other model id untouched", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "hi" });

  await transcribeWithGemini(
    { audioBuffer: AUDIO, model: "gemini-3.5-transcribe", contentType: "audio/mp3", apiKey: "k1" },
    fetchImpl
  );

  assert.equal(requestBody(calls).model, "gemini-3.5-transcribe");
});

// The swap can be turned off from settings, to rule it out when chasing a bug.
test("with the swap switched off, the live id is sent exactly as chosen", async () => {
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "hi" });

  await transcribeWithGemini(
    {
      audioBuffer: AUDIO,
      model: "gemini-3.5-transcribe-live",
      contentType: "audio/mp3",
      apiKey: "k1",
      swapStreamingOnlyModel: false,
    },
    fetchImpl
  );

  assert.equal(requestBody(calls).model, "gemini-3.5-transcribe-live");
});

test("a caller that says nothing about the swap still gets it", async () => {
  // Default on: a setting that failed to load must not bring the 400 back.
  const { fetchImpl, calls } = makeFetch({ status: "completed", output_text: "hi" });

  await transcribeWithGemini(
    { audioBuffer: AUDIO, model: "gemini-3.5-transcribe-live", apiKey: "k1" },
    fetchImpl
  );

  assert.equal(requestBody(calls).model, "gemini-3.5-transcribe");
});

test("every Gemini batch call in the main process honours the setting", () => {
  // A new call site that forgets the flag would silently ignore the switch, so
  // the user would turn it off, see no change, and conclude the swap is fine.
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/helpers/ipcHandlers.js"),
    "utf8"
  );
  const calls = source.split("transcribeWithGemini({").slice(1);
  assert.ok(calls.length >= 3, `expected the three known call sites, found ${calls.length}`);
  for (const [i, call] of calls.entries()) {
    const args = call.slice(0, call.indexOf("});"));
    assert.match(
      args,
      /swapStreamingOnlyModel: this\.environmentManager\.getGeminiLiveBatchSwap\(\)/,
      `call ${i + 1} of transcribeWithGemini does not pass the setting`
    );
  }
});

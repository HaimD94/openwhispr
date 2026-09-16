const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveLanguageCodes, AUTO_LANGUAGE_CODES } = require("../../src/helpers/geminiLiveStreaming");

// The engine accepted a `language` option and then sent a hardcoded pair, so
// the app's transcription language setting did nothing for Gemini Live at all.

test("auto keeps the deliberate Hebrew-plus-English pair", () => {
  assert.deepEqual(resolveLanguageCodes("auto"), AUTO_LANGUAGE_CODES);
  assert.deepEqual(resolveLanguageCodes(undefined), AUTO_LANGUAGE_CODES);
  assert.deepEqual(resolveLanguageCodes(""), AUTO_LANGUAGE_CODES);
});

test("a bare language code becomes the region-qualified tag Gemini expects", () => {
  // he-IL is what the engine sent before any of this existed, so CLDR agreeing
  // with the hand-written value is the check that the derivation is sound.
  assert.deepEqual(resolveLanguageCodes("he"), ["he-IL", "en-US"]);
  assert.deepEqual(resolveLanguageCodes("fr"), ["fr-FR", "en-US"]);
  assert.deepEqual(resolveLanguageCodes("ja"), ["ja-JP", "en-US"]);
  assert.deepEqual(resolveLanguageCodes("ru"), ["ru-RU", "en-US"]);
});

test("a code that already carries a region is left alone", () => {
  assert.deepEqual(resolveLanguageCodes("zh-CN"), ["zh-CN", "en-US"]);
  assert.deepEqual(resolveLanguageCodes("zh-TW"), ["zh-TW", "en-US"]);
});

test("English does not get a redundant second entry", () => {
  assert.deepEqual(resolveLanguageCodes("en"), ["en-US"]);
  assert.deepEqual(resolveLanguageCodes("en-GB"), ["en-GB"]);
});

test("English rides along with every other language", () => {
  // Not a stylistic choice: the app's Hebrew cleanup prompt asks to preserve
  // English technical terms as spoken, which the transcriber can only do if it
  // is listening for English too.
  for (const code of ["he", "de", "it", "pt", "ar"]) {
    assert.ok(
      resolveLanguageCodes(code).includes("en-US"),
      `${code} should still listen for English`
    );
  }
});

test("an unrecognised tag is passed through rather than dropped", () => {
  // Losing the code entirely would transcribe in the wrong language; the
  // server ignoring one unknown tag is the smaller failure.
  const codes = resolveLanguageCodes("not-a-real-tag!!");
  assert.ok(codes.length >= 1);
  assert.equal(codes[0], "not-a-real-tag!!");
});

test("every language the app offers produces a usable tag", () => {
  const registry = require("../../src/config/languageRegistry.json");
  for (const lang of registry.languages) {
    if (lang.code === "auto") continue;
    const codes = resolveLanguageCodes(lang.code);
    assert.ok(codes.length > 0, `${lang.code} produced nothing`);
    for (const code of codes) {
      assert.match(code, /^[a-zA-Z]{2,3}(-[A-Za-z0-9]+)*$/, `${lang.code} produced "${code}"`);
    }
  }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modelRegistry = require("../../src/models/modelRegistryData.json");
// Read straight out of the source list rather than restated here, so adding a
// UI language cannot leave this test checking a stale set.
// Importing i18n.ts would drag i18next and react into a plain node test, so the
// list is read out of the source text instead. Quoted entries only, which is
// what the const holds.
const SUPPORTED_UI_LANGUAGES = (() => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/i18n.ts"), "utf8");
  const block = source.match(/SUPPORTED_UI_LANGUAGES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, "could not find SUPPORTED_UI_LANGUAGES in src/i18n.ts");
  return [...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
})();

const SRC = path.join(__dirname, "../../src");
const LOCALES = path.join(SRC, "locales");
const NAMESPACES = ["translation", "prompts"];
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const T_CALL = /\bt\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g;
const INTERPOLATION = /\{\{\s*([\w.]+)/g;

const allLanguages = fs
  .readdirSync(LOCALES)
  .filter((entry) => fs.statSync(path.join(LOCALES, entry)).isDirectory());

// A locale directory does not have to carry both namespaces. Hebrew is
// deliberately prompts-only: it is registered in PROMPTS_BY_LOCALE so dictation
// can be cleaned up in Hebrew, but it is not in SUPPORTED_UI_LANGUAGES and has
// no translation.json, because the interface is not translated to it.
//
// Reading the two namespaces off one directory listing assumed otherwise, and
// every test in this file threw ENOENT on he/translation.json the moment those
// prompts were added -- taking ~200 assertions down with them and hiding any
// real translation gap behind the noise. So each namespace gets the languages
// that actually carry it, and the UI languages are checked separately below,
// where a genuinely missing interface translation still fails.
const languagesWith = (namespace) =>
  allLanguages.filter((lang) => fs.existsSync(path.join(LOCALES, lang, `${namespace}.json`)));

const load = (lang, namespace) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES, lang, `${namespace}.json`), "utf8"));

function flatten(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "locales" && entry.name !== "dist") sourceFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const stripPlural = (key) => key.replace(PLURAL_SUFFIX, "");

function registryDescriptionKeys(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) registryDescriptionKeys(child, out);
  } else if (node && typeof node === "object") {
    if (typeof node.descriptionKey === "string") out.push(node.descriptionKey);
    for (const child of Object.values(node)) registryDescriptionKeys(child, out);
  }
  return out;
}

test("every t() key referenced in source resolves in en", () => {
  const keys = new Set();
  for (const namespace of NAMESPACES) {
    for (const key of flatten(load("en", namespace)).keys()) keys.add(key);
  }
  // i18next also resolves a plural base and a parent path returned as an object.
  const bases = new Set([...keys].map(stripPlural));
  const parents = new Set();
  for (const key of keys) {
    const parts = key.split(".");
    for (let i = 1; i < parts.length; i += 1) parents.add(parts.slice(0, i).join("."));
  }

  const broken = [];
  for (const file of sourceFiles(SRC)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(T_CALL)) {
      const key = match[2];
      if (!key.includes(".")) continue;
      if (keys.has(key) || bases.has(key) || parents.has(key)) continue;
      broken.push(
        `${path.relative(SRC, file)}:${source.slice(0, match.index).split("\n").length} → ${key}`
      );
    }
  }

  assert.deepEqual(broken, [], `Missing en translations:\n${broken.join("\n")}`);
});

// Model descriptions are data-driven (t(descriptionKey, { defaultValue })), so
// the source scan above can't see them and a missing key silently falls back
// to English. Other locales are covered by the en-parity test below.
test("every model registry descriptionKey resolves in en", () => {
  const en = flatten(load("en", "translation"));
  const keys = registryDescriptionKeys(modelRegistry);
  assert.ok(keys.length > 0, "no descriptionKey found in the model registry");

  const broken = keys.filter((key) => typeof en.get(key) !== "string" || en.get(key) === "");
  assert.deepEqual(broken, [], `Registry descriptionKeys missing in en:\n${broken.join("\n")}`);
});

// The interface must exist in every language the app offers to switch to.
// Without this, dropping a translation.json would now be silently tolerated by
// the per-namespace filter above.
test("every UI language the app offers has a translation file", () => {
  const missing = SUPPORTED_UI_LANGUAGES.filter(
    (lang) => !fs.existsSync(path.join(LOCALES, lang, "translation.json"))
  );
  assert.deepEqual(missing, [], `these UI languages have no translation.json: ${missing.join(", ")}`);
});

test("every en key is present in every other language", () => {
  for (const namespace of NAMESPACES) {
    const en = flatten(load("en", namespace));
    for (const lang of languagesWith(namespace)) {
      if (lang === "en") continue;
      const translated = flatten(load(lang, namespace));
      // Plural categories are language specific (ru adds _few/_many, zh only has
      // _other), so a matching plural base counts as covered.
      const bases = new Set([...translated.keys()].map(stripPlural));
      const gaps = [...en.keys()].filter(
        (key) => !translated.has(key) && !bases.has(stripPlural(key))
      );
      assert.deepEqual(gaps, [], `${lang}/${namespace} is missing:\n${gaps.join("\n")}`);
    }
  }
});

test("interpolation variables match en in every language", () => {
  // Compares names, not repeat counts — word order can make a translation
  // reference the same variable a different number of times.
  const variables = (value) =>
    typeof value === "string"
      ? [...new Set([...value.matchAll(INTERPOLATION)].map((m) => m[1]))].sort()
      : [];

  for (const namespace of NAMESPACES) {
    const en = flatten(load("en", namespace));
    for (const lang of languagesWith(namespace)) {
      if (lang === "en") continue;
      for (const [key, value] of flatten(load(lang, namespace))) {
        if (!en.has(key)) continue;
        assert.deepEqual(
          variables(value),
          variables(en.get(key)),
          `${lang}/${namespace} ${key} has different {{variables}} than en`
        );
      }
    }
  }
});

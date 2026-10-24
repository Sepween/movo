// Predictive T9: each key press adds one digit, and the dictionary turns the
// digit sequence into candidate words (e.g. 223 -> "bad", "cad", "ace").
//
// The full word list (public/t9/words.txt) is kept for coverage. The Google
// 10k (public/t9/common.txt) is loaded first, most frequent first, so popular
// matches always rank above the long tail. Patient names in localStorage sit
// above both. See public/t9/LICENSE.md.

const COMMON_URL = "/t9/common.txt";
const WORDS_URL = "/t9/words.txt";
const CUSTOM_KEY = "t9-custom-words";

const KEYPAD: Record<string, string> = {
  "2": "abc",
  "3": "def",
  "4": "ghi",
  "5": "jkl",
  "6": "mno",
  "7": "pqrs",
  "8": "tuv",
  "9": "wxyz",
};

const LETTER_TO_DIGIT = new Map<string, string>(
  Object.entries(KEYPAD).flatMap(([digit, letters]) =>
    [...letters].map((letter) => [letter, digit] as [string, string]),
  ),
);

export function isWordDigit(id: string) {
  return id in KEYPAD;
}

export function wordToDigits(word: string) {
  let digits = "";
  for (const letter of word) {
    const digit = LETTER_TO_DIGIT.get(letter);
    if (!digit) return null;
    digits += digit;
  }
  return digits;
}

function letters(word: string) {
  return word.toLowerCase().replace(/[^a-z]/g, "");
}

export function loadCustomWords(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((word): word is string => typeof word === "string");
  } catch {
    return [];
  }
}

function saveCustomWords(words: string[]) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(words));
}

export function addCustomWord(raw: string) {
  const word = raw.trim();
  const key = letters(word);
  if (key.length < 2) return "Use at least two letters.";
  if (!wordToDigits(key)) return "Could not add that word.";
  saveCustomWords([
    word,
    ...loadCustomWords().filter((existing) => letters(existing) !== key),
  ]);
  return "";
}

export function removeCustomWord(word: string) {
  const key = letters(word);
  saveCustomWords(loadCustomWords().filter((existing) => letters(existing) !== key));
}

function customEntries() {
  const entries: Dictionary["entries"] = [];
  const seen = new Set<string>();
  for (const word of loadCustomWords()) {
    const key = letters(word);
    if (seen.has(key)) continue;
    const digits = wordToDigits(key);
    if (!digits) continue;
    seen.add(key);
    entries.push({ word, digits });
  }
  return entries;
}

export type Dictionary = {
  // Common 10k first (frequency order), then the rest of the lexicon.
  entries: Array<{ word: string; digits: string }>;
};

async function parseList(url: string, seen: Set<string>) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load the T9 dictionary.");
  const entries: Dictionary["entries"] = [];
  for (const line of (await response.text()).split("\n")) {
    const word = line.trim().toLowerCase();
    if (!word || seen.has(word)) continue;
    const digits = wordToDigits(word);
    if (!digits) continue;
    seen.add(word);
    entries.push({ word, digits });
  }
  return entries;
}

export async function loadDictionary(): Promise<Dictionary> {
  const seen = new Set<string>();
  const common = await parseList(COMMON_URL, seen);
  const rest = await parseList(WORDS_URL, seen);
  return { entries: [...common, ...rest] };
}

// Custom names first, then the 10k, then the long tail.
export function suggest(dict: Dictionary | null, digits: string, limit: number) {
  if (!digits) return [];
  const words: string[] = [];
  const skip = new Set<string>();
  for (const entry of customEntries()) {
    if (!entry.digits.startsWith(digits)) continue;
    words.push(entry.word);
    skip.add(letters(entry.word));
    if (words.length >= limit) return words;
  }
  if (!dict) return words;
  for (const entry of dict.entries) {
    if (!entry.digits.startsWith(digits)) continue;
    if (skip.has(entry.word)) continue;
    words.push(entry.word);
    if (words.length >= limit) break;
  }
  return words;
}

export function previewWord(dict: Dictionary | null, digits: string) {
  if (!digits) return "";
  const hit =
    customEntries().find((entry) => entry.digits.startsWith(digits)) ??
    dict?.entries.find((entry) => entry.digits.startsWith(digits));
  if (!hit) {
    return [...digits].map((digit) => KEYPAD[digit]?.[0] ?? "").join("");
  }
  return hit.digits === digits ? hit.word : hit.word.slice(0, digits.length);
}

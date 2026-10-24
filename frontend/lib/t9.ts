// Predictive T9: each key press adds one digit, and the dictionary turns the
// digit sequence into candidate words (e.g. 223 -> "bad", "cad", "ace").
//
// The word list (public/t9/words.txt) is the 10k most common English words
// from the Google Web Trillion Word Corpus, most frequent first, so list
// order doubles as ranking. See public/t9/LICENSE.md.

const WORDS_URL = "/t9/words.txt";

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

export type Dictionary = {
  // In frequency order.
  entries: Array<{ word: string; digits: string }>;
  exact: Map<string, string[]>;
};

export async function loadDictionary(): Promise<Dictionary> {
  const response = await fetch(WORDS_URL);
  if (!response.ok) throw new Error("Could not load the T9 dictionary.");
  const entries: Dictionary["entries"] = [];
  const exact = new Map<string, string[]>();
  for (const line of (await response.text()).split("\n")) {
    const word = line.trim().toLowerCase();
    const digits = word ? wordToDigits(word) : null;
    if (!digits) continue;
    entries.push({ word, digits });
    exact.set(digits, [...(exact.get(digits) ?? []), word]);
  }
  return { entries, exact };
}

// Exact-length matches first (what classic T9 shows), then longer words that
// start with the sequence, so a word can be picked before it's fully typed.
export function suggest(dict: Dictionary | null, digits: string, limit: number) {
  if (!dict || !digits) return [];
  const words = [...(dict.exact.get(digits) ?? [])].slice(0, limit);
  for (const entry of dict.entries) {
    if (words.length >= limit) break;
    if (entry.digits.length > digits.length && entry.digits.startsWith(digits)) {
      words.push(entry.word);
    }
  }
  return words;
}

// What to show (and commit on space) for the current sequence: the top exact
// match, else the start of the top longer match, else each key's first letter.
export function previewWord(dict: Dictionary | null, digits: string) {
  if (!digits) return "";
  const exact = dict?.exact.get(digits)?.[0];
  if (exact) return exact;
  const longer = dict?.entries.find((entry) => entry.digits.startsWith(digits));
  if (longer) return longer.word.slice(0, digits.length);
  return [...digits].map((digit) => KEYPAD[digit]?.[0] ?? "").join("");
}

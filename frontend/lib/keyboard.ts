export type KeyDef = {
  id: string;
  label: string;
  sub?: string;
  insert?: string;
  chars?: string[];
  width?: number;
};

function multiTap(digit: string, letters: string): KeyDef {
  return {
    id: digit,
    label: digit,
    sub: letters,
    chars: [...letters, digit],
  };
}

export const KEY_ROWS: KeyDef[][] = [
  [multiTap("1", ".,?!"), multiTap("2", "abc"), multiTap("3", "def")],
  [multiTap("4", "ghi"), multiTap("5", "jkl"), multiTap("6", "mno")],
  [multiTap("7", "pqrs"), multiTap("8", "tuv"), multiTap("9", "wxyz")],
  [
    { id: "backspace", label: "del", sub: "back" },
    { id: "space", label: "0", sub: "space", insert: " " },
    { id: "enter", label: "enter", sub: "new line", insert: "\n" },
  ],
];

export function applyKey(text: string, key: KeyDef) {
  if (key.id === "backspace") return text.slice(0, -1);
  return text + (key.insert ?? key.label.toLowerCase());
}

export type Cycle = { keyId: string; index: number; at: number };

// Multi-tap: re-firing the same key within the window replaces the pending
// character with the next one on that key; otherwise a new character starts.
export function nextCycle(
  key: KeyDef,
  cycle: Cycle | null,
  continuing: boolean,
  now: number,
): { cycle: Cycle; replace: boolean } {
  const count = key.chars?.length ?? 1;
  if (cycle && cycle.keyId === key.id && continuing) {
    return {
      cycle: { keyId: key.id, index: (cycle.index + 1) % count, at: now },
      replace: true,
    };
  }
  return { cycle: { keyId: key.id, index: 0, at: now }, replace: false };
}

export function findKey(id: string) {
  return KEY_ROWS.flat().find((key) => key.id === id) ?? null;
}

// Mirrors WebGazer's 9-point calibration: outer points first, centre last.
// The centre key doubles as the accuracy-measurement target.
export const CALIBRATION_KEYS = [
  "1",
  "2",
  "3",
  "4",
  "6",
  "backspace",
  "space",
  "enter",
  "5",
] as const;

// Head pointing is close to linear, so the centre plus the four corners is
// enough. The centre comes first: sensitivity scales around it.
export const HEAD_CALIBRATION_KEYS = [
  "5",
  "1",
  "3",
  "backspace",
  "enter",
] as const;

export function keyCenter(id: string, nodes: Map<string, HTMLElement>) {
  const node = nodes.get(id);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// Fraction of a key's size the gaze may drift past its edge before we let go
// of it. Vertical gets more slack because the vertical estimate is noisier.
const HOLD_MARGIN_X = 0.25;
const HOLD_MARGIN_Y = 0.45;
// Beyond this normalised distance from every key (e.g. reading the output
// box), nothing is selected.
const MAX_SNAP_DISTANCE = 2;

// Snaps the gaze point to the nearest key, measured in units of half the key
// size so tall and wide keys are treated alike. The current key is kept while
// the gaze stays inside its slightly enlarged box, which stops flicker at
// borders.
export function pickGazeKey(
  x: number,
  y: number,
  currentId: string | null,
  nodes: Map<string, HTMLElement>,
) {
  if (currentId) {
    const rect = nodes.get(currentId)?.getBoundingClientRect();
    if (
      rect &&
      x >= rect.left - rect.width * HOLD_MARGIN_X &&
      x <= rect.right + rect.width * HOLD_MARGIN_X &&
      y >= rect.top - rect.height * HOLD_MARGIN_Y &&
      y <= rect.bottom + rect.height * HOLD_MARGIN_Y
    ) {
      return currentId;
    }
  }

  let bestId: string | null = null;
  let bestDist = Infinity;
  for (const key of KEY_ROWS.flat()) {
    const rect = nodes.get(key.id)?.getBoundingClientRect();
    if (!rect) continue;
    const dx = (x - (rect.left + rect.width / 2)) / Math.max(rect.width / 2, 1);
    const dy = (y - (rect.top + rect.height / 2)) / Math.max(rect.height / 2, 1);
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist < bestDist) {
      bestDist = dist;
      bestId = key.id;
    }
  }

  return bestDist > MAX_SNAP_DISTANCE ? null : bestId;
}

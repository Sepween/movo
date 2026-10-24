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

// Snap zones, as a fraction of each key's width/height, centred on the key.
// The pointer must enter the inner zone to grab a key, and keeps it until it
// leaves the slightly larger release zone, which stops flicker at the edge.
// Outside every zone nothing is selected.
export const SNAP_ZONE = 0.55;
const RELEASE_ZONE = 0.75;

// Distance from the key centre in units of half the key size (Chebyshev), so
// a value of 1 is the key's edge whatever its shape.
function keyDistance(x: number, y: number, rect: DOMRect) {
  const dx = (x - (rect.left + rect.width / 2)) / Math.max(rect.width / 2, 1);
  const dy = (y - (rect.top + rect.height / 2)) / Math.max(rect.height / 2, 1);
  return Math.max(Math.abs(dx), Math.abs(dy));
}

export function pickGazeKey(
  x: number,
  y: number,
  currentId: string | null,
  nodes: Map<string, HTMLElement>,
) {
  if (currentId) {
    const rect = nodes.get(currentId)?.getBoundingClientRect();
    if (rect && keyDistance(x, y, rect) <= RELEASE_ZONE) return currentId;
  }

  for (const key of KEY_ROWS.flat()) {
    const rect = nodes.get(key.id)?.getBoundingClientRect();
    if (rect && keyDistance(x, y, rect) <= SNAP_ZONE) return key.id;
  }
  return null;
}

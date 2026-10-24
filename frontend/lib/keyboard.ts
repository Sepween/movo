export type KeyDef = {
  id: string;
  label: string;
  insert?: string;
  width?: number;
};

export const KEY_ROWS: KeyDef[][] = [
  [
    { id: "q", label: "Q" },
    { id: "w", label: "W" },
    { id: "e", label: "E" },
    { id: "r", label: "R" },
    { id: "t", label: "T" },
    { id: "y", label: "Y" },
    { id: "u", label: "U" },
    { id: "i", label: "I" },
    { id: "o", label: "O" },
    { id: "p", label: "P" },
    { id: "backspace", label: "del", width: 1.5 },
  ],
  [
    { id: "a", label: "A" },
    { id: "s", label: "S" },
    { id: "d", label: "D" },
    { id: "f", label: "F" },
    { id: "g", label: "G" },
    { id: "h", label: "H" },
    { id: "j", label: "J" },
    { id: "k", label: "K" },
    { id: "l", label: "L" },
  ],
  [
    { id: "z", label: "Z" },
    { id: "x", label: "X" },
    { id: "c", label: "C" },
    { id: "v", label: "V" },
    { id: "b", label: "B" },
    { id: "n", label: "N" },
    { id: "m", label: "M" },
    { id: ",", label: "," },
    { id: ".", label: "." },
  ],
  [
    { id: "space", label: "space", insert: " ", width: 6 },
    { id: "enter", label: "enter", insert: "\n", width: 1.8 },
  ],
];

export function applyKey(text: string, key: KeyDef) {
  if (key.id === "backspace") return text.slice(0, -1);
  return text + (key.insert ?? key.label.toLowerCase());
}

export function findKey(id: string) {
  return KEY_ROWS.flat().find((key) => key.id === id) ?? null;
}

export const CALIBRATION_KEYS = [
  "q",
  "t",
  "backspace",
  "a",
  "g",
  "l",
  "z",
  "b",
  ".",
  "space",
] as const;

export function keyCenter(id: string, nodes: Map<string, HTMLElement>) {
  const node = nodes.get(id);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function pickGazeKey(
  x: number,
  y: number,
  currentId: string | null,
  nodes: Map<string, HTMLElement>,
) {
  const rowMeta = KEY_ROWS.map((row, index) => {
    const rects = row
      .map((key) => nodes.get(key.id)?.getBoundingClientRect())
      .filter((rect): rect is DOMRect => Boolean(rect));
    if (rects.length === 0) return null;
    const yMid =
      rects.reduce((sum, rect) => sum + rect.top + rect.height / 2, 0) /
      rects.length;
    const height = Math.max(...rects.map((rect) => rect.height));
    return { index, yMid, height };
  }).filter((row): row is { index: number; yMid: number; height: number } =>
    Boolean(row),
  );

  if (rowMeta.length === 0) return null;

  let currentRow =
    currentId == null
      ? null
      : KEY_ROWS.findIndex((row) => row.some((key) => key.id === currentId));
  if (currentRow === -1) currentRow = null;

  const containing = rowMeta.filter(
    (row) => Math.abs(y - row.yMid) <= row.height / 2,
  );

  let chosenRow = containing[0] ?? null;
  if (containing.length > 1) {
    chosenRow = containing.reduce((best, row) =>
      Math.abs(y - row.yMid) < Math.abs(y - best.yMid) ? row : best,
    );
  }

  if (!chosenRow && currentRow != null) {
    const current = rowMeta.find((row) => row.index === currentRow);
    if (current && Math.abs(y - current.yMid) <= current.height * 0.7) {
      chosenRow = current;
    }
  }

  if (!chosenRow) return null;

  const row = KEY_ROWS[chosenRow.index];
  let bestId: string | null = null;
  let bestDist = Infinity;
  let currentDist = Infinity;

  for (const key of row) {
    const node = nodes.get(key.id);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const dist = Math.abs(x - cx) / Math.max(rect.width / 2, 1);
    if (key.id === currentId) currentDist = dist;
    if (dist < bestDist) {
      bestDist = dist;
      bestId = key.id;
    }
  }

  if (
    currentId &&
    row.some((key) => key.id === currentId) &&
    currentDist < bestDist * 1.45
  ) {
    return currentId;
  }

  return bestDist > 1.7 ? currentId : bestId;
}

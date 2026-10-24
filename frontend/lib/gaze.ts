import type {
  FaceLandmarker,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";

export type Point = { x: number; y: number };

export type GazeFeatures = { gx: number; gy: number };

type Affine = {
  x: [number, number, number];
  y: [number, number, number];
};

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const EYES = [
  { iris: 468, inner: 133, outer: 33, top: 159, bottom: 145 },
  { iris: 473, inner: 362, outer: 263, top: 386, bottom: 374 },
] as const;

function irisInEye(landmarks: NormalizedLandmark[], eye: (typeof EYES)[number]) {
  const iris = landmarks[eye.iris];
  const inner = landmarks[eye.inner];
  const outer = landmarks[eye.outer];
  const top = landmarks[eye.top];
  const bottom = landmarks[eye.bottom];
  if (!iris || !inner || !outer || !top || !bottom) return null;

  const midX = (inner.x + outer.x) / 2;
  const midY = (top.y + bottom.y) / 2;
  const halfW = Math.max(Math.abs(outer.x - inner.x) / 2, 1e-4);
  const halfH = Math.max(Math.abs(bottom.y - top.y) / 2, 1e-4);

  return {
    x: (iris.x - midX) / halfW,
    y: (iris.y - midY) / halfH,
  };
}

function featuresFromLandmarks(
  landmarks: NormalizedLandmark[],
): GazeFeatures | null {
  if (landmarks.length < 478) return null;

  const left = irisInEye(landmarks, EYES[0]);
  const right = irisInEye(landmarks, EYES[1]);
  if (!left || !right) return null;

  return {
    gx: (left.x + right.x) / 2,
    gy: (left.y + right.y) / 2,
  };
}

function solve3(matrix: number[][], vector: number[]) {
  const n = 3;
  const m = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const diag = m[col][col];
    if (Math.abs(diag) < 1e-8) return null;
    for (let j = col; j <= n; j += 1) m[col][j] /= diag;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let j = col; j <= n; j += 1) m[row][j] -= factor * m[col][j];
    }
  }

  return m.map((row) => row[n]) as [number, number, number];
}

function fitAffine(samples: Array<GazeFeatures & Point>): Affine | null {
  if (samples.length < 9) return null;

  const xtx = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const xtyX = [0, 0, 0];
  const xtyY = [0, 0, 0];

  for (const sample of samples) {
    const row = [sample.gx, sample.gy, 1];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) xtx[i][j] += row[i] * row[j];
      xtyX[i] += row[i] * sample.x;
      xtyY[i] += row[i] * sample.y;
    }
  }

  const x = solve3(xtx, xtyX);
  const y = solve3(xtx, xtyY);
  if (!x || !y) return null;
  return { x, y };
}

function applyAffine(map: Affine, features: GazeFeatures): Point {
  return {
    x: map.x[0] * features.gx + map.x[1] * features.gy + map.x[2],
    y: map.y[0] * features.gx + map.y[1] * features.gy + map.y[2],
  };
}

export async function createFaceLandmarker(): Promise<FaceLandmarker> {
  const { FaceLandmarker, FilesetResolver } = await import(
    "@mediapipe/tasks-vision"
  );
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: "VIDEO" as const,
    numFaces: 1,
  };

  try {
    return await FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "GPU" },
    });
  } catch {
    return FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "CPU" },
    });
  }
}

export class GazeEngine {
  private landmarker: FaceLandmarker;
  private lastVideoTime = -1;
  private lastTimestamp = 0;
  private lastDetect: { features: GazeFeatures | null; faceOk: boolean } = {
    features: null,
    faceOk: false,
  };
  private samples: Array<GazeFeatures & Point> = [];
  private map: Affine | null = null;
  private smooth: Point | null = null;

  constructor(landmarker: FaceLandmarker) {
    this.landmarker = landmarker;
  }

  detect(video: HTMLVideoElement): {
    features: GazeFeatures | null;
    faceOk: boolean;
    fresh: boolean;
  } {
    if (video.readyState < 2) {
      return { features: null, faceOk: false, fresh: false };
    }
    if (video.currentTime === this.lastVideoTime) {
      return { ...this.lastDetect, fresh: false };
    }

    this.lastVideoTime = video.currentTime;
    const timestamp = Math.max(this.lastTimestamp + 1, performance.now());
    this.lastTimestamp = timestamp;

    try {
      const result = this.landmarker.detectForVideo(video, timestamp);
      const landmarks = result.faceLandmarks?.[0];
      this.lastDetect = landmarks
        ? { features: featuresFromLandmarks(landmarks), faceOk: true }
        : { features: null, faceOk: false };
    } catch {
      this.lastDetect = { features: null, faceOk: false };
    }
    return { ...this.lastDetect, fresh: true };
  }

  addSample(features: GazeFeatures, point: Point) {
    this.samples.push({ ...features, ...point });
  }

  fit() {
    this.map = fitAffine(this.samples);
    this.smooth = null;
    return this.map != null;
  }

  reset() {
    this.samples = [];
    this.map = null;
    this.smooth = null;
  }

  predict(features: GazeFeatures): Point | null {
    if (!this.map) return null;
    const raw = applyAffine(this.map, features);
    const width = window.innerWidth;
    const height = window.innerHeight;
    const next = {
      x: Math.min(width - 8, Math.max(8, raw.x)),
      y: Math.min(height - 8, Math.max(8, raw.y)),
    };

    if (!this.smooth) {
      this.smooth = next;
      return next;
    }

    const distance = Math.hypot(next.x - this.smooth.x, next.y - this.smooth.y);
    const alpha = distance > 140 ? 0.45 : distance > 50 ? 0.22 : 0.12;
    this.smooth = {
      x: this.smooth.x + (next.x - this.smooth.x) * alpha,
      y: this.smooth.y + (next.y - this.smooth.y) * alpha,
    };
    return this.smooth;
  }

  close() {
    try {
      this.landmarker.close();
    } catch {
      // Already released.
    }
  }
}

import type {
  Category,
  FaceLandmarker,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";

export type Point = { x: number; y: number };

// gx/gy: iris offset from the eye-corner midpoint, in units of eye width,
// measured along/across the line joining the outer corners (so head roll
// cancels). Eyelids move with vertical gaze, so they are not used as the
// reference; instead lid opening is its own feature (`open`), alongside the
// MediaPipe up/down blendshapes (`bv`) and a head-pose proxy (`yaw`/`pitch`).
export type GazeFeatures = {
  gx: number;
  gy: number;
  open: number;
  bv: number;
  yaw: number;
  pitch: number;
};

type FeatureKey = keyof GazeFeatures;

const X_FEATURES: FeatureKey[] = ["gx", "yaw"];
const Y_FEATURES: FeatureKey[] = ["gy", "open", "bv", "pitch"];

type AxisModel = { keys: FeatureKey[]; weights: number[]; bias: number };

type GazeModel = { x: AxisModel; y: AxisModel };

type Sample = GazeFeatures & Point;

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const EYES = [
  { iris: 468, inner: 133, outer: 33, top: 159, bottom: 145 },
  { iris: 473, inner: 362, outer: 263, top: 386, bottom: 374 },
] as const;
const NOSE_TIP = 1;
const BLINK_THRESHOLD = 0.55;

type Vec = { x: number; y: number };

function blendScore(categories: Category[] | undefined, name: string) {
  return categories?.find((c) => c.categoryName === name)?.score ?? 0;
}

function featuresFromLandmarks(
  landmarks: NormalizedLandmark[],
  blendshapes: Category[] | undefined,
  aspect: number,
): GazeFeatures | null {
  if (landmarks.length < 478) return null;

  const blink =
    (blendScore(blendshapes, "eyeBlinkLeft") +
      blendScore(blendshapes, "eyeBlinkRight")) /
    2;
  if (blink > BLINK_THRESHOLD) return null;

  // Landmarks are normalised separately per axis; rescale x to square pixels.
  const p = (index: number): Vec => ({
    x: landmarks[index].x * aspect,
    y: landmarks[index].y,
  });

  const leftOuter = p(EYES[0].outer);
  const rightOuter = p(EYES[1].outer);
  const iod = Math.hypot(rightOuter.x - leftOuter.x, rightOuter.y - leftOuter.y);
  if (iod < 1e-4) return null;
  const u = { x: (rightOuter.x - leftOuter.x) / iod, y: (rightOuter.y - leftOuter.y) / iod };
  const along = (v: Vec) => v.x * u.x + v.y * u.y;
  const across = (v: Vec) => v.y * u.x - v.x * u.y;

  let gx = 0;
  let gy = 0;
  let open = 0;
  for (const eye of EYES) {
    const inner = p(eye.inner);
    const outer = p(eye.outer);
    const iris = p(eye.iris);
    const top = p(eye.top);
    const bottom = p(eye.bottom);
    const width = Math.max(Math.hypot(outer.x - inner.x, outer.y - inner.y), 1e-4);
    const offset = {
      x: iris.x - (inner.x + outer.x) / 2,
      y: iris.y - (inner.y + outer.y) / 2,
    };
    gx += along(offset) / width / 2;
    gy += across(offset) / width / 2;
    open +=
      across({ x: bottom.x - top.x, y: bottom.y - top.y }) / width / 2;
  }

  const bv =
    (blendScore(blendshapes, "eyeLookDownLeft") +
      blendScore(blendshapes, "eyeLookDownRight") -
      blendScore(blendshapes, "eyeLookUpLeft") -
      blendScore(blendshapes, "eyeLookUpRight")) /
    2;

  const eyeMid = {
    x: (leftOuter.x + rightOuter.x) / 2,
    y: (leftOuter.y + rightOuter.y) / 2,
  };
  const nose = p(NOSE_TIP);
  const noseOffset = { x: nose.x - eyeMid.x, y: nose.y - eyeMid.y };

  return {
    gx,
    gy,
    open,
    bv,
    yaw: along(noseOffset) / iod,
    pitch: across(noseOffset) / iod,
  };
}

function solve(matrix: number[][], vector: number[]) {
  const n = vector.length;
  const m = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const diag = m[col][col];
    if (Math.abs(diag) < 1e-12) return null;
    for (let j = col; j <= n; j += 1) m[col][j] /= diag;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let j = col; j <= n; j += 1) m[row][j] -= factor * m[col][j];
    }
  }

  return m.map((row) => row[n]);
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Drop samples per calibration target whose gaze features stray far from
// that target's median (saccades, half-blinks, glances away).
function trimOutliers(samples: Sample[]) {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const id = `${Math.round(sample.x)},${Math.round(sample.y)}`;
    groups.set(id, [...(groups.get(id) ?? []), sample]);
  }

  const kept: Sample[] = [];
  for (const group of groups.values()) {
    const keys: FeatureKey[] = ["gx", "gy", "open"];
    const stats = keys.map((key) => {
      const values = group.map((s) => s[key]);
      const med = median(values);
      const mad = median(values.map((v) => Math.abs(v - med))) || 1e-6;
      return { key, med, mad };
    });
    for (const sample of group) {
      const ok = stats.every(
        ({ key, med, mad }) => Math.abs(sample[key] - med) <= 3 * 1.4826 * mad,
      );
      if (ok) kept.push(sample);
    }
  }
  return kept;
}

// Ridge regression on centred features. The penalty is a small fraction of
// the mean feature variance, enough to tame near-constant features (e.g. head
// pose when the user kept still) without biasing the informative ones.
function fitAxis(
  samples: Sample[],
  keys: FeatureKey[],
  target: "x" | "y",
): AxisModel | null {
  const n = keys.length;
  const count = samples.length;
  const means = keys.map(
    (key) => samples.reduce((sum, s) => sum + s[key], 0) / count,
  );
  const targetMean = samples.reduce((sum, s) => sum + s[target], 0) / count;

  const a = keys.map(() => keys.map(() => 0));
  const b = keys.map(() => 0);
  for (const sample of samples) {
    const row = keys.map((key, i) => sample[key] - means[i]);
    const t = sample[target] - targetMean;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) a[i][j] += row[i] * row[j];
      b[i] += row[i] * t;
    }
  }

  const meanVariance = a.reduce((sum, row, i) => sum + row[i], 0) / n;
  const lambda = 0.01 * meanVariance + 1e-12;
  for (let i = 0; i < n; i += 1) a[i][i] += lambda;

  const weights = solve(a, b);
  if (!weights) return null;
  const bias =
    targetMean - weights.reduce((sum, w, i) => sum + w * means[i], 0);
  return { keys, weights, bias };
}

function applyAxis(model: AxisModel, features: GazeFeatures) {
  return model.keys.reduce(
    (sum, key, i) => sum + model.weights[i] * features[key],
    model.bias,
  );
}

function fitModel(samples: Sample[]): GazeModel | null {
  if (samples.length < 9) return null;
  const trimmed = trimOutliers(samples);
  const usable = trimmed.length >= 9 ? trimmed : samples;
  const x = fitAxis(usable, X_FEATURES, "x");
  const y = fitAxis(usable, Y_FEATURES, "y");
  return x && y ? { x, y } : null;
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
    outputFaceBlendshapes: true,
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

// Per-axis adaptive smoothing: heavy when the estimate jitters in place,
// light when it jumps (a real saccade). Vertical is noisier, so it gets
// a stronger filter.
function smoothAxis(prev: number, next: number, near: number, far: number, base: number) {
  const delta = Math.abs(next - prev);
  const alpha = delta > far ? 0.5 : delta > near ? base * 2 : base;
  return prev + (next - prev) * alpha;
}

export class GazeEngine {
  private landmarker: FaceLandmarker;
  private lastVideoTime = -1;
  private lastTimestamp = 0;
  private lastDetect: { features: GazeFeatures | null; faceOk: boolean } = {
    features: null,
    faceOk: false,
  };
  private samples: Sample[] = [];
  private model: GazeModel | null = null;
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
    const aspect = video.videoWidth / Math.max(video.videoHeight, 1);

    try {
      const result = this.landmarker.detectForVideo(video, timestamp);
      const landmarks = result.faceLandmarks?.[0];
      this.lastDetect = landmarks
        ? {
            features: featuresFromLandmarks(
              landmarks,
              result.faceBlendshapes?.[0]?.categories,
              aspect,
            ),
            faceOk: true,
          }
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
    this.model = fitModel(this.samples);
    this.smooth = null;
    return this.model != null;
  }

  reset() {
    this.samples = [];
    this.model = null;
    this.smooth = null;
  }

  predict(features: GazeFeatures): Point | null {
    if (!this.model) return null;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const next = {
      x: Math.min(width - 8, Math.max(8, applyAxis(this.model.x, features))),
      y: Math.min(height - 8, Math.max(8, applyAxis(this.model.y, features))),
    };

    if (!this.smooth) {
      this.smooth = next;
      return next;
    }

    this.smooth = {
      x: smoothAxis(this.smooth.x, next.x, 50, 140, 0.12),
      y: smoothAxis(this.smooth.y, next.y, 40, 120, 0.08),
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

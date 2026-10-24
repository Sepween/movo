import type {
  FaceLandmarker,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";

// Head pointer: the cursor follows where the face points, not where the eyes
// look. Head rotation is a far larger and steadier signal for a webcam than
// iris movement, especially vertically.

export type Point = { x: number; y: number };

// Rotation proxies from face landmarks, measured in the face's own frame so
// moving the whole head sideways or closer barely changes them:
//   yaw   = nose tip offset along the line between the outer eye corners
//   pitch = nose tip offset across that line
// both divided by the eye-corner distance.
export type HeadPose = { yaw: number; pitch: number };

type Affine = { x: [number, number, number]; y: [number, number, number] };

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const NOSE_TIP = 1;

function poseFromLandmarks(
  landmarks: NormalizedLandmark[],
  aspect: number,
): HeadPose | null {
  const left = landmarks[LEFT_EYE_OUTER];
  const right = landmarks[RIGHT_EYE_OUTER];
  const nose = landmarks[NOSE_TIP];
  if (!left || !right || !nose) return null;

  // Landmarks are normalised per axis; rescale x to square pixels.
  const lx = left.x * aspect;
  const rx = right.x * aspect;
  const nx = nose.x * aspect;
  const iod = Math.hypot(rx - lx, right.y - left.y);
  if (iod < 1e-4) return null;
  const ux = (rx - lx) / iod;
  const uy = (right.y - left.y) / iod;
  const dx = nx - (lx + rx) / 2;
  const dy = nose.y - (left.y + right.y) / 2;

  return {
    yaw: (dx * ux + dy * uy) / iod,
    pitch: (dy * ux - dx * uy) / iod,
  };
}

function solve3(matrix: number[][], vector: number[]) {
  const m = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const diag = m[col][col];
    if (Math.abs(diag) < 1e-12) return null;
    for (let j = col; j <= 3; j += 1) m[col][j] /= diag;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let j = col; j <= 3; j += 1) m[row][j] -= factor * m[col][j];
    }
  }
  return m.map((row) => row[3]) as [number, number, number];
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// One affine map per axis, fitted to the median pose at each calibration
// target so a stray frame at one target can't skew the fit.
function fitAffine(samples: Array<HeadPose & Point>): Affine | null {
  const groups = new Map<string, Array<HeadPose & Point>>();
  for (const s of samples) {
    const id = `${Math.round(s.x)},${Math.round(s.y)}`;
    groups.set(id, [...(groups.get(id) ?? []), s]);
  }
  const points = [...groups.values()].map((group) => ({
    yaw: median(group.map((s) => s.yaw)),
    pitch: median(group.map((s) => s.pitch)),
    x: group[0].x,
    y: group[0].y,
  }));
  if (points.length < 3) return null;

  const xtx = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const xtyX = [0, 0, 0];
  const xtyY = [0, 0, 0];
  for (const p of points) {
    const row = [p.yaw, p.pitch, 1];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) xtx[i][j] += row[i] * row[j];
      xtyX[i] += row[i] * p.x;
      xtyY[i] += row[i] * p.y;
    }
  }
  const x = solve3(xtx, xtyX);
  const y = solve3(xtx, xtyY);
  return x && y ? { x, y } : null;
}

// One Euro filter (Casiez et al. 2012): heavy smoothing while the head is
// still, little lag when it moves.
class OneEuro {
  private value: number | null = null;
  private derivative = 0;
  private lastTime = 0;
  private minCutoff: number;
  private beta: number;
  private derivativeCutoff: number;

  constructor(minCutoff: number, beta: number, derivativeCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
  }

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(next: number, time: number) {
    if (this.value === null) {
      this.value = next;
      this.lastTime = time;
      return next;
    }
    const dt = Math.max((time - this.lastTime) / 1000, 1e-3);
    this.lastTime = time;
    const rawDerivative = (next - this.value) / dt;
    this.derivative +=
      (rawDerivative - this.derivative) *
      OneEuro.alpha(this.derivativeCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    this.value += (next - this.value) * OneEuro.alpha(cutoff, dt);
    return this.value;
  }

  reset() {
    this.value = null;
    this.derivative = 0;
  }
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

export class HeadTracker {
  private landmarker: FaceLandmarker;
  private lastVideoTime = -1;
  private lastTimestamp = 0;
  private lastDetect: { pose: HeadPose | null; faceOk: boolean } = {
    pose: null,
    faceOk: false,
  };
  private samples: Array<HeadPose & Point> = [];
  private map: Affine | null = null;
  private anchor: Point | null = null;
  private filterX = new OneEuro(0.6, 0.02);
  private filterY = new OneEuro(0.6, 0.02);
  sensitivity = 1;

  constructor(landmarker: FaceLandmarker) {
    this.landmarker = landmarker;
  }

  detect(video: HTMLVideoElement): {
    pose: HeadPose | null;
    faceOk: boolean;
    fresh: boolean;
  } {
    if (video.readyState < 2) return { pose: null, faceOk: false, fresh: false };
    if (video.currentTime === this.lastVideoTime) {
      return { ...this.lastDetect, fresh: false };
    }

    this.lastVideoTime = video.currentTime;
    const timestamp = Math.max(this.lastTimestamp + 1, performance.now());
    this.lastTimestamp = timestamp;
    const aspect = video.videoWidth / Math.max(video.videoHeight, 1);

    try {
      const landmarks = this.landmarker.detectForVideo(video, timestamp)
        .faceLandmarks?.[0];
      this.lastDetect = landmarks
        ? { pose: poseFromLandmarks(landmarks, aspect), faceOk: true }
        : { pose: null, faceOk: false };
    } catch {
      this.lastDetect = { pose: null, faceOk: false };
    }
    return { ...this.lastDetect, fresh: true };
  }

  addSample(pose: HeadPose, point: Point) {
    this.samples.push({ ...pose, ...point });
  }

  // `anchor` is the screen point sensitivity scales around (the first,
  // centre calibration target).
  fit(anchor: Point) {
    this.map = fitAffine(this.samples);
    this.anchor = anchor;
    this.filterX.reset();
    this.filterY.reset();
    return this.map != null;
  }

  reset() {
    this.samples = [];
    this.map = null;
    this.anchor = null;
    this.filterX.reset();
    this.filterY.reset();
  }

  predict(pose: HeadPose): Point | null {
    if (!this.map || !this.anchor) return null;
    const m = this.map;
    const rawX = m.x[0] * pose.yaw + m.x[1] * pose.pitch + m.x[2];
    const rawY = m.y[0] * pose.yaw + m.y[1] * pose.pitch + m.y[2];
    const now = performance.now();
    const x = this.filterX.filter(
      this.anchor.x + (rawX - this.anchor.x) * this.sensitivity,
      now,
    );
    const y = this.filterY.filter(
      this.anchor.y + (rawY - this.anchor.y) * this.sensitivity,
      now,
    );
    return {
      x: Math.min(window.innerWidth - 4, Math.max(4, x)),
      y: Math.min(window.innerHeight - 4, Math.max(4, y)),
    };
  }

  close() {
    try {
      this.landmarker.close();
    } catch {
      // Already released.
    }
  }
}

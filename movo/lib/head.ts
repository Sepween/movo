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

// Image-left / image-right outer eye corners (unmirrored camera).
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const NOSE_TIP = 1;

// Cursor movement per unit of head turn, around the centre calibration key.
const SENSITIVITY = 0.75;

// Eye-aspect-ratio landmarks [corner, top, top, corner, bottom, bottom],
// named from the user's own point of view (MediaPipe's "left eye" is the
// user's left, which appears on the image's right).
const USER_LEFT_EYE = [362, 385, 387, 263, 373, 380] as const;
const USER_RIGHT_EYE = [33, 160, 158, 133, 153, 144] as const;

// Wink tuning; see WinkDetector. Asymmetry is log(left EAR / right EAR)
// minus its calibrated both-open value: 0 with both eyes open, negative for
// a left wink, positive for a right wink.
// Without calibration, the eyes differing by 30% counts as a wink.
const DEFAULT_THRESHOLD = Math.log(1 / 0.7);
// A calibrated wink must differ from open by at least 25%, or we ask again.
const MIN_CALIBRATED_SEPARATION = Math.log(1.25);
// The open eye must stay at least this fraction of its calibrated openness,
// so a near-full blink (two tiny, noisy values) can't look lopsided.
const OPEN_EYE_FLOOR = 0.5;
// Uncalibrated fallback for the same guard, as a raw eye aspect ratio.
const OPEN_EYE_MIN_EAR = 0.12;
const MIN_EAR = 0.01;
const WINK_HOLD_MS = 200;

export type Wink = "left" | "right";
export type EyeOpenness = { left: number; right: number };

export type WinkCalibrationResult =
  | { ok: true }
  | { ok: false; reason: string };

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

// Eye aspect ratio (Soukupová & Čech 2016): mean lid gap over eye width.
// About 0.3 when open, under 0.1 when shut.
function eyeAspectRatio(
  landmarks: NormalizedLandmark[],
  eye: readonly number[],
  aspect: number,
) {
  const p = eye.map((index) => landmarks[index]);
  if (p.some((point) => !point)) return null;
  const dist = (a: NormalizedLandmark, b: NormalizedLandmark) =>
    Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  const width = dist(p[0], p[3]);
  if (width < 1e-5) return null;
  return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * width);
}

function opennessFromLandmarks(
  landmarks: NormalizedLandmark[],
  aspect: number,
): EyeOpenness | null {
  const left = eyeAspectRatio(landmarks, USER_LEFT_EYE, aspect);
  const right = eyeAspectRatio(landmarks, USER_RIGHT_EYE, aspect);
  return left === null || right === null ? null : { left, right };
}

function logRatio(eyes: EyeOpenness) {
  return Math.log(
    Math.max(eyes.left, MIN_EAR) / Math.max(eyes.right, MIN_EAR),
  );
}

// A wink is the two eyes' openness diverging past a threshold for
// WINK_HOLD_MS. Comparing the eyes with each other (not with fixed levels)
// tolerates the open eye squinting along with the wink, and ordinary blinks
// close both eyes together so the ratio barely moves. Fires once per wink;
// the eyes must come back level before the next.
class WinkDetector {
  private openLog = 0;
  private openEars: EyeOpenness | null = null;
  // Thresholds on asymmetry: left is negative, right positive.
  private thresholds = { left: -DEFAULT_THRESHOLD, right: DEFAULT_THRESHOLD };
  private candidate: { eye: Wink; since: number } | null = null;
  private latched = false;

  // Step 1: both eyes open. Sets the reference ratio and openness.
  calibrateOpen(samples: EyeOpenness[]): WinkCalibrationResult {
    if (samples.length < 5) {
      return { ok: false, reason: "Couldn't see your eyes. Face the camera and try again." };
    }
    this.openLog = median(samples.map(logRatio));
    this.openEars = {
      left: median(samples.map((e) => e.left)),
      right: median(samples.map((e) => e.right)),
    };
    this.thresholds = { left: -DEFAULT_THRESHOLD, right: DEFAULT_THRESHOLD };
    return { ok: true };
  }

  // Steps 2 and 3: one eye held shut. The threshold goes halfway between
  // open (0) and this eye's wink.
  calibrateWink(eye: Wink, samples: EyeOpenness[]): WinkCalibrationResult {
    if (samples.length < 5) {
      return { ok: false, reason: "Couldn't see your eyes. Face the camera and try again." };
    }
    const asymmetry = median(samples.map(logRatio)) - this.openLog;
    const signed = eye === "left" ? -asymmetry : asymmetry;
    if (signed < MIN_CALIBRATED_SEPARATION) {
      const percent = Math.round((Math.exp(Math.abs(asymmetry)) - 1) * 100);
      return {
        ok: false,
        reason: `Your ${eye} eye only differed from the other by ${percent}%. Close it more firmly and try again.`,
      };
    }
    this.thresholds[eye] = asymmetry / 2;
    return { ok: true };
  }

  update(eyes: EyeOpenness, time: number): Wink | null {
    return this.decide(eyes, logRatio(eyes) - this.openLog, time);
  }

  private openEnough(eyes: EyeOpenness, openEye: Wink) {
    const ear = eyes[openEye];
    if (this.openEars) return ear >= this.openEars[openEye] * OPEN_EYE_FLOOR;
    return ear >= OPEN_EYE_MIN_EAR;
  }

  private decide(
    eyes: EyeOpenness,
    asymmetry: number,
    time: number,
  ): Wink | null {
    // Back to level (within half of either threshold) re-arms the detector.
    const level =
      Math.abs(asymmetry) <
      Math.min(-this.thresholds.left, this.thresholds.right) / 2;
    if (level) this.latched = false;

    let eye: Wink | null = null;
    if (asymmetry <= this.thresholds.left && this.openEnough(eyes, "right")) {
      eye = "left";
    } else if (
      asymmetry >= this.thresholds.right &&
      this.openEnough(eyes, "left")
    ) {
      eye = "right";
    }

    if (!eye || this.latched) {
      if (!eye) this.candidate = null;
      return null;
    }
    if (this.candidate?.eye !== eye) {
      this.candidate = { eye, since: time };
      return null;
    }
    if (time - this.candidate.since < WINK_HOLD_MS) return null;
    this.candidate = null;
    this.latched = true;
    return eye;
  }

  reset() {
    this.candidate = null;
    this.latched = false;
  }
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

// Median pose at each calibration target, so a stray frame can't skew things.
function targetMedians(samples: Array<HeadPose & Point>) {
  const groups = new Map<string, Array<HeadPose & Point>>();
  for (const s of samples) {
    const id = `${Math.round(s.x)},${Math.round(s.y)}`;
    groups.set(id, [...(groups.get(id) ?? []), s]);
  }
  return [...groups.values()].map((group) => ({
    yaw: median(group.map((s) => s.yaw)),
    pitch: median(group.map((s) => s.pitch)),
    x: group[0].x,
    y: group[0].y,
  }));
}

// One affine map per axis, fitted to the median pose at each target.
function fitAffine(samples: Array<HeadPose & Point>): Affine | null {
  const points = targetMedians(samples);
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
  private winks = new WinkDetector();

  constructor(landmarker: FaceLandmarker) {
    this.landmarker = landmarker;
  }

  calibrateWinkOpen(samples: EyeOpenness[]) {
    return this.winks.calibrateOpen(samples);
  }

  calibrateWink(eye: Wink, samples: EyeOpenness[]) {
    return this.winks.calibrateWink(eye, samples);
  }

  // `eyes` and `wink` are set only on fresh frames; `wink` only on the frame
  // where a wink completes.
  detect(video: HTMLVideoElement): {
    pose: HeadPose | null;
    faceOk: boolean;
    fresh: boolean;
    eyes: EyeOpenness | null;
    wink: Wink | null;
  } {
    if (video.readyState < 2) {
      return { pose: null, faceOk: false, fresh: false, eyes: null, wink: null };
    }
    if (video.currentTime === this.lastVideoTime) {
      return { ...this.lastDetect, fresh: false, eyes: null, wink: null };
    }

    this.lastVideoTime = video.currentTime;
    const timestamp = Math.max(this.lastTimestamp + 1, performance.now());
    this.lastTimestamp = timestamp;
    const aspect = video.videoWidth / Math.max(video.videoHeight, 1);

    let wink: Wink | null = null;
    let eyes: EyeOpenness | null = null;
    try {
      const landmarks = this.landmarker.detectForVideo(video, timestamp)
        .faceLandmarks?.[0];
      if (landmarks) {
        this.lastDetect = {
          pose: poseFromLandmarks(landmarks, aspect),
          faceOk: true,
        };
        eyes = opennessFromLandmarks(landmarks, aspect);
        if (eyes) wink = this.winks.update(eyes, timestamp);
      } else {
        this.lastDetect = { pose: null, faceOk: false };
        this.winks.reset();
      }
    } catch {
      this.lastDetect = { pose: null, faceOk: false };
    }
    return { ...this.lastDetect, fresh: true, eyes, wink };
  }

  addSample(pose: HeadPose, point: Point) {
    this.samples.push({ ...pose, ...point });
  }

  // `anchor` is the screen point SENSITIVITY scales around (the first,
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
      this.anchor.x + (rawX - this.anchor.x) * SENSITIVITY,
      now,
    );
    const y = this.filterY.filter(
      this.anchor.y + (rawY - this.anchor.y) * SENSITIVITY,
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

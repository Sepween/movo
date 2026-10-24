// Thin wrapper around WebGazer.js (vendored from ../WebGazer/www into
// public/webgazer). WebGazer owns the camera, face mesh and ridge regression;
// we feed it calibration clicks at key centres and read its predictions.

export type Point = { x: number; y: number };

type Prediction = { x: number; y: number } | null;

type WebGazer = {
  params: Record<string, unknown>;
  setRegression(name: "ridge" | "weightedRidge" | "threadedRidge"): WebGazer;
  setGazeListener(listener: (data: Prediction, elapsed: number) => void): WebGazer;
  clearGazeListener(): WebGazer;
  saveDataAcrossSessions(value: boolean): WebGazer;
  applyKalmanFilter(value: boolean): WebGazer;
  showVideoPreview(value: boolean): WebGazer;
  showPredictionPoints(value: boolean): WebGazer;
  removeMouseEventListeners(): WebGazer;
  recordScreenPosition(x: number, y: number, eventType?: "click" | "move"): WebGazer;
  clearData(): Promise<void>;
  begin(onFail?: () => void): Promise<WebGazer>;
  pause(): WebGazer;
  stopVideo(): WebGazer;
  end(): WebGazer;
};

declare global {
  interface Window {
    webgazer?: WebGazer;
  }
}

const SCRIPT_URL = "/webgazer/webgazer.js";
const FACE_MESH_PATH = "/webgazer/mediapipe/face_mesh";
// WebGazer's own demo averages its last 4 predictions before drawing the dot.
const SMOOTHING_WINDOW = 4;

let scriptPromise: Promise<WebGazer> | null = null;
let running: WebGazer | null = null;

function loadScript(): Promise<WebGazer> {
  if (window.webgazer) return Promise.resolve(window.webgazer);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.webgazer
        ? resolve(window.webgazer)
        : reject(new Error("WebGazer failed to initialise."));
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Could not load WebGazer."));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export async function startWebGazer(onGaze: (point: Point | null) => void) {
  const webgazer = await loadScript();
  webgazer.params.faceMeshSolutionPath = FACE_MESH_PATH;
  webgazer.params.videoViewerWidth = 160;
  webgazer.params.videoViewerHeight = 120;

  const recent: Point[] = [];
  webgazer
    .setRegression("ridge")
    .saveDataAcrossSessions(false)
    .applyKalmanFilter(true)
    .showPredictionPoints(false)
    .setGazeListener((data) => {
      if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) {
        onGaze(null);
        return;
      }
      recent.push({ x: data.x, y: data.y });
      if (recent.length > SMOOTHING_WINDOW) recent.shift();
      const x = recent.reduce((sum, p) => sum + p.x, 0) / recent.length;
      const y = recent.reduce((sum, p) => sum + p.y, 0) / recent.length;
      onGaze({
        x: Math.min(window.innerWidth, Math.max(0, x)),
        y: Math.min(window.innerHeight, Math.max(0, y)),
      });
    });

  await webgazer.begin();
  // We record calibration samples ourselves at key centres; WebGazer's
  // default listeners would also train on every stray click and mouse move.
  webgazer.removeMouseEventListeners();
  webgazer.showVideoPreview(true).showPredictionPoints(false);
  await webgazer.clearData();
  running = webgazer;
}

export function recordCalibrationPoint(point: Point) {
  running?.recordScreenPosition(point.x, point.y, "click");
}

export async function resetCalibration() {
  await running?.clearData();
}

// True when WebGazer's preview box is green, i.e. both eyes sit inside the
// validation box it draws over the camera preview.
export function faceInBox() {
  const box = document.getElementById(
    String(running?.params.faceFeedbackBoxId ?? "webgazerFaceFeedbackBox"),
  );
  return Boolean(box?.style.border.includes("green"));
}

export function stopWebGazer() {
  const webgazer = running;
  running = null;
  if (!webgazer) return;
  webgazer.clearGazeListener();
  try {
    webgazer.stopVideo();
  } catch {
    // Video was never fully set up.
  }
  try {
    webgazer.end();
  } catch {
    // Already torn down.
  }
}

// WebGazer's calibration demo score: each prediction scores 100% at the
// target and falls linearly to 0% at half the window height away.
export function precisionScore(points: Point[], target: Point) {
  if (points.length === 0) return 0;
  const half = window.innerHeight / 2;
  const total = points.reduce((sum, p) => {
    const distance = Math.hypot(p.x - target.x, p.y - target.y);
    return sum + Math.max(0, 100 - (distance / half) * 100);
  }, 0);
  return Math.round(total / points.length);
}

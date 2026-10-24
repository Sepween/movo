"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { createFaceLandmarker, GazeEngine, type Point } from "@/lib/gaze";
import {
  applyKey,
  CALIBRATION_KEYS,
  findKey,
  KEY_ROWS,
  keyCenter,
  pickGazeKey,
  type KeyDef,
} from "@/lib/keyboard";

const DWELL_MS = 900;
const SWITCH_MS = 160;
const GRACE_MS = 280;
const CAPTURE_MS = 750;
const MIN_SAMPLES = 12;

type Phase = "start" | "loading" | "calibrate" | "typing" | "error";
type InputMode = "eye" | "mouse";

type DwellState = {
  keyId: string | null;
  since: number;
  leftAt: number | null;
  pendingId: string | null;
  pendingSince: number;
  fired: boolean;
};

function emptyDwell(): DwellState {
  return {
    keyId: null,
    since: 0,
    leftAt: null,
    pendingId: null,
    pendingSince: 0,
    fired: false,
  };
}

export function GazeKeyboard() {
  const [phase, setPhase] = useState<Phase>("start");
  const [mode, setMode] = useState<InputMode>("eye");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [firedKey, setFiredKey] = useState<string | null>(null);
  const [gaze, setGaze] = useState<Point | null>(null);
  const [faceOk, setFaceOk] = useState(false);
  const [activePoint, setActivePoint] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [captureProgress, setCaptureProgress] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<GazeEngine | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const keyNodes = useRef(new Map<string, HTMLElement>());
  const dwell = useRef<DwellState>(emptyDwell());
  const phaseRef = useRef<Phase>("start");
  const modeRef = useRef<InputMode>("eye");
  const activePointRef = useRef(0);
  const capturingRef = useRef(false);
  const captureStarted = useRef(0);
  const captureCount = useRef(0);
  const lastUi = useRef(0);
  const faceOkRef = useRef(false);

  phaseRef.current = phase;
  modeRef.current = mode;
  activePointRef.current = activePoint;
  capturingRef.current = capturing;

  const setKeyNode = useCallback((id: string, node: HTMLElement | null) => {
    if (node) keyNodes.current.set(id, node);
    else keyNodes.current.delete(id);
  }, []);

  const typeKey = useCallback((key: KeyDef) => {
    setText((current) => applyKey(current, key));
    setFiredKey(key.id);
    window.setTimeout(() => {
      setFiredKey((current) => (current === key.id ? null : current));
    }, 160);
  }, []);

  const applyGazePoint = useCallback(
    (point: Point) => {
      const now = performance.now();
      const state = dwell.current;
      const hit = pickGazeKey(point.x, point.y, state.keyId, keyNodes.current);

      if (hit && hit === state.keyId) {
        state.leftAt = null;
        state.pendingId = null;
        if (!state.fired && now - state.since >= DWELL_MS) {
          const key = findKey(hit);
          if (key) {
            state.fired = true;
            typeKey(key);
          }
        }
      } else if (hit && hit !== state.keyId) {
        if (state.pendingId !== hit) {
          state.pendingId = hit;
          state.pendingSince = now;
        }
        if (!state.keyId || now - state.pendingSince >= SWITCH_MS) {
          state.keyId = hit;
          state.since = now;
          state.leftAt = null;
          state.pendingId = null;
          state.fired = false;
        }
      } else if (!hit && state.keyId) {
        if (state.leftAt === null) state.leftAt = now;
        if (now - state.leftAt >= GRACE_MS) dwell.current = emptyDwell();
      }

      if (now - lastUi.current > 40) {
        lastUi.current = now;
        const shown = dwell.current.keyId;
        setGaze(point);
        setHoveredKey(shown);
        setProgress(
          shown && !dwell.current.fired
            ? Math.min(1, (now - dwell.current.since) / DWELL_MS)
            : 0,
        );
      }
    },
    [typeKey],
  );

  const finishCalibration = useCallback(() => {
    const fitted = engineRef.current?.fit() ?? false;
    if (!fitted) {
      setError("Calibration failed. Keep your head still and try again.");
      setPhase("error");
      return;
    }
    dwell.current = emptyDwell();
    setCapturing(false);
    setPhase("typing");
  }, []);

  const startCapture = useCallback(() => {
    captureStarted.current = performance.now();
    captureCount.current = 0;
    setCapturing(true);
    setCaptureProgress(0);
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    engineRef.current?.close();
    engineRef.current = null;
  }, []);

  const beginCalibration = useCallback(() => {
    engineRef.current?.reset();
    dwell.current = emptyDwell();
    setActivePoint(0);
    setCapturing(false);
    setCaptureProgress(0);
    setHoveredKey(null);
    setProgress(0);
    setGaze(null);
    setPhase("calibrate");
  }, []);

  const startEyeTracking = useCallback(async () => {
    stopCamera();
    setMode("eye");
    setError(null);
    setPhase("loading");
    dwell.current = emptyDwell();
    faceOkRef.current = false;
    setFaceOk(false);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 640, height: 480 },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Camera preview failed to start.");
      video.srcObject = stream;
      await video.play();

      const landmarker = await createFaceLandmarker();
      engineRef.current = new GazeEngine(landmarker);
      beginCalibration();
    } catch (err) {
      stopCamera();
      setError(
        err instanceof Error
          ? err.message
          : "Camera permission is required for eye tracking.",
      );
      setPhase("error");
    }
  }, [beginCalibration, stopCamera]);

  const startMousePractice = useCallback(() => {
    setMode("mouse");
    setError(null);
    setFaceOk(true);
    dwell.current = emptyDwell();
    setPhase("typing");
  }, []);

  const recalibrate = useCallback(() => {
    if (mode !== "eye" || !engineRef.current) return;
    beginCalibration();
  }, [beginCalibration, mode]);

  const onKeyClick = useCallback(
    (key: KeyDef) => {
      if (phaseRef.current === "calibrate") {
        if (key.id !== CALIBRATION_KEYS[activePointRef.current]) return;
        if (capturingRef.current) return;
        startCapture();
        return;
      }
      typeKey(key);
    },
    [startCapture, typeKey],
  );

  useEffect(() => {
    if (mode !== "eye") return;
    if (phase !== "calibrate" && phase !== "typing") return;

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      const engine = engineRef.current;
      if (!video || !engine) return;

      const detected = engine.detect(video);
      if (detected.faceOk !== faceOkRef.current) {
        faceOkRef.current = detected.faceOk;
        setFaceOk(detected.faceOk);
      }

      if (phaseRef.current === "calibrate") {
        if (!capturingRef.current || !detected.features || !detected.fresh) {
          return;
        }
        const target = keyCenter(
          CALIBRATION_KEYS[activePointRef.current],
          keyNodes.current,
        );
        if (!target) return;
        if (captureCount.current === 0) {
          captureStarted.current = performance.now();
        }
        engine.addSample(detected.features, target);
        captureCount.current += 1;
        const elapsed = performance.now() - captureStarted.current;
        setCaptureProgress(Math.min(1, elapsed / CAPTURE_MS));
        if (elapsed >= CAPTURE_MS && captureCount.current >= MIN_SAMPLES) {
          capturingRef.current = false;
          setCapturing(false);
          const nextIndex = activePointRef.current + 1;
          if (nextIndex >= CALIBRATION_KEYS.length) {
            finishCalibration();
          } else {
            setActivePoint(nextIndex);
            setCaptureProgress(0);
          }
        }
        return;
      }

      if (
        phaseRef.current === "typing" &&
        detected.features &&
        detected.fresh
      ) {
        const point = engine.predict(detected.features);
        if (point) applyGazePoint(point);
      }
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [applyGazePoint, finishCalibration, mode, phase]);

  useEffect(() => {
    if (phase !== "typing" || mode !== "mouse") return;
    const onMove = (event: MouseEvent) =>
      applyGazePoint({ x: event.clientX, y: event.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [applyGazePoint, mode, phase]);

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  const showCamera = mode === "eye" && phase !== "start";
  const activeCalibKey =
    phase === "calibrate" ? CALIBRATION_KEYS[activePoint] : null;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#0b1220] text-[#f4efe4]">
      <video
        ref={videoRef}
        className={`pointer-events-none fixed top-3 left-3 z-40 h-[99px] w-[132px] rounded-2xl object-cover shadow-lg ring-2 -scale-x-100 ${
          showCamera ? "opacity-100" : "opacity-0"
        } ${faceOk ? "ring-emerald-400" : "ring-red-400"}`}
        autoPlay
        muted
        playsInline
      />

      {phase === "start" || phase === "error" ? (
        <StartScreen
          error={error}
          onStartCamera={startEyeTracking}
          onPractice={startMousePractice}
        />
      ) : null}

      {phase === "loading" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm tracking-[0.25em] text-[#d4a017] uppercase">
            Starting camera
          </p>
          <h1 className="max-w-md text-4xl font-semibold tracking-tight">
            Keep your face in the frame.
          </h1>
        </div>
      ) : null}

      {phase === "calibrate" || phase === "typing" ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-5 pt-3 sm:px-8">
          {phase === "calibrate" ? (
            <header className="relative z-20 mb-4 shrink-0 pl-40">
              <p className="text-sm tracking-[0.25em] text-[#d4a017] uppercase">
                Calibration {activePoint + 1} / {CALIBRATION_KEYS.length}
              </p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight">
                {capturing
                  ? "Hold still. Keep looking at that key."
                  : "Look at the highlighted key, then click it."}
              </h1>
              <p className="mt-1 text-[#c8c0b0]">
                {faceOk
                  ? "We're mapping your gaze onto the real keyboard rows."
                  : "Move into the green camera box first."}
              </p>
            </header>
          ) : (
            <header
              className={`mb-3 flex shrink-0 items-start justify-end gap-3 ${mode === "eye" ? "pl-40" : ""}`}
            >
              <button
                type="button"
                onClick={() => setText("")}
                className="rounded-full border border-white/15 px-4 py-2 text-sm"
              >
                Clear
              </button>
              {mode === "eye" ? (
                <button
                  type="button"
                  onClick={recalibrate}
                  className="rounded-full border border-white/15 px-4 py-2 text-sm"
                >
                  Recalibrate
                </button>
              ) : null}
            </header>
          )}

          {phase === "typing" ? (
            <section className="mx-auto mb-4 w-full max-w-6xl shrink-0 rounded-3xl bg-[#f4efe4] px-5 py-4 text-[#0b1220]">
              <p className="text-xs tracking-[0.22em] text-[#8a7f68] uppercase">
                {mode === "eye" ? "Gaze output" : "Mouse practice"} · hold a key
                for 1s
              </p>
              <p className="mt-2 min-h-16 font-mono text-2xl leading-snug break-words whitespace-pre-wrap sm:text-3xl">
                {text}
                <span className="ml-0.5 inline-block w-[2px] animate-pulse bg-[#0b1220] align-baseline">
                  &nbsp;
                </span>
              </p>
            </section>
          ) : null}

          <Keyboard
            hoveredKey={
              phase === "calibrate" ? activeCalibKey : hoveredKey
            }
            progress={phase === "calibrate" ? captureProgress : progress}
            firedKey={phase === "calibrate" ? null : firedKey}
            calibrating={phase === "calibrate"}
            activeCalibKey={activeCalibKey}
            onKeyClick={onKeyClick}
            setKeyNode={setKeyNode}
          />
        </div>
      ) : null}

      {phase === "typing" && gaze ? (
        <div
          className="pointer-events-none fixed z-50 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#d4a017] bg-[#d4a017]/30"
          style={{ left: gaze.x, top: gaze.y }}
        />
      ) : null}
    </div>
  );
}

function StartScreen({
  error,
  onStartCamera,
  onPractice,
}: {
  error: string | null;
  onStartCamera: () => void;
  onPractice: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-6 py-10">
      <div className="space-y-3">
        <p className="text-sm tracking-[0.28em] text-[#d4a017] uppercase">
          Webcam gaze keyboard
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-pretty sm:text-5xl">
          Look at a key for one second to type it.
        </h1>
        <p className="max-w-xl text-base leading-7 text-[#c8c0b0] sm:text-lg sm:leading-8">
          Calibration happens on the keyboard itself, so the map is fitted to
          the real key rows.
        </p>
      </div>
      <ol className="grid gap-3 text-sm text-[#c8c0b0] sm:grid-cols-3">
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Sit an arm&apos;s length away. The camera ring must stay green.
        </li>
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Look at each highlighted key and click it. Hold your gaze while it
          fills.
        </li>
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Then look at a key for 1 second. Keep your head still.
        </li>
      </ol>
      {error ? (
        <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-red-200">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onStartCamera}
          className="rounded-full bg-[#d4a017] px-6 py-3 text-sm font-semibold text-[#0b1220]"
        >
          Enable camera
        </button>
        <button
          type="button"
          onClick={onPractice}
          className="rounded-full border border-white/15 px-6 py-3 text-sm text-[#f4efe4]"
        >
          Practice with mouse
        </button>
      </div>
    </main>
  );
}

function Keyboard({
  hoveredKey,
  progress,
  firedKey,
  calibrating,
  activeCalibKey,
  onKeyClick,
  setKeyNode,
}: {
  hoveredKey: string | null;
  progress: number;
  firedKey: string | null;
  calibrating: boolean;
  activeCalibKey: string | null;
  onKeyClick: (key: KeyDef) => void;
  setKeyNode: (id: string, node: HTMLElement | null) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col justify-end gap-7">
      {KEY_ROWS.map((row, rowIndex) => (
        <div key={rowIndex} className="flex justify-center gap-5">
          {row.map((key) => {
            const hovered = hoveredKey === key.id;
            const fired = firedKey === key.id;
            const isActiveCalib = activeCalibKey === key.id;
            const dimmed = calibrating && !isActiveCalib;
            return (
              <button
                key={key.id}
                type="button"
                ref={(node) => setKeyNode(key.id, node)}
                onClick={() => onKeyClick(key)}
                disabled={calibrating && !isActiveCalib}
                className="relative isolate h-[min(4.25rem,10vh)] overflow-hidden rounded-2xl border text-xl font-semibold select-none sm:text-2xl"
                style={{
                  flex: `${key.width ?? 1} 1 0%`,
                  opacity: dimmed ? 0.28 : 1,
                  borderColor: fired || isActiveCalib
                    ? "#d4a017"
                    : hovered
                      ? "rgba(212,160,23,0.9)"
                      : "rgba(244,239,228,0.12)",
                  background: fired || isActiveCalib ? "#d4a017" : "#151d2e",
                  color: fired || isActiveCalib ? "#0b1220" : "#f4efe4",
                }}
              >
                {hovered && !fired ? (
                  <span
                    className={`absolute inset-x-0 bottom-0 ${
                      isActiveCalib ? "bg-[#0b1220]/20" : "bg-[#d4a017]/35"
                    }`}
                    style={{ height: `${progress * 100}%` }}
                  />
                ) : null}
                <span className="relative">{key.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyKey,
  CALIBRATION_KEYS,
  findKey,
  HEAD_CALIBRATION_KEYS,
  KEY_ROWS,
  keyCenter,
  nextCycle,
  pickGazeKey,
  type Cycle,
  type KeyDef,
} from "@/lib/keyboard";
import { createFaceLandmarker, HeadTracker } from "@/lib/head";
import {
  faceInBox,
  precisionScore,
  recordCalibrationPoint,
  resetCalibration,
  startWebGazer,
  stopWebGazer,
  type Point,
} from "@/lib/webgazer";

const DWELL_MS = 900;
const CYCLE_MS = 800;
const MULTITAP_MS = 900;
const SWITCH_MS = 160;
const GRACE_MS = 280;
const CLICKS_PER_POINT = 5;
const MEASURE_MS = 5000;
const MEASURE_KEY = CALIBRATION_KEYS[CALIBRATION_KEYS.length - 1];
// Head calibration: one click per key, then hold still while poses record.
const CAPTURE_MS = 1000;
const SETTLE_MS = 250;
const MIN_CAPTURE_SAMPLES = 8;
const SENSITIVITIES = [1, 1.5, 2] as const;

type Phase =
  | "start"
  | "loading"
  | "calibrate"
  | "measure"
  | "result"
  | "typing"
  | "error";
type InputMode = "head" | "eye" | "mouse";

function calibrationKeys(mode: InputMode): readonly string[] {
  return mode === "head" ? HEAD_CALIBRATION_KEYS : CALIBRATION_KEYS;
}

type DwellState = {
  keyId: string | null;
  since: number;
  leftAt: number | null;
  pendingId: string | null;
  pendingSince: number;
  fired: boolean;
  lastFire: number;
};

function emptyDwell(): DwellState {
  return {
    keyId: null,
    since: 0,
    leftAt: null,
    pendingId: null,
    pendingSince: 0,
    fired: false,
    lastFire: 0,
  };
}

export function GazeKeyboard() {
  const [phase, setPhase] = useState<Phase>("start");
  const [mode, setMode] = useState<InputMode>("head");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Cycle | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [firedKey, setFiredKey] = useState<string | null>(null);
  const [gaze, setGaze] = useState<(Point & { snapped: boolean }) | null>(
    null,
  );
  const [faceOk, setFaceOk] = useState(false);
  const [activePoint, setActivePoint] = useState(0);
  const [clicks, setClicks] = useState(0);
  const [measureProgress, setMeasureProgress] = useState(0);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureProgress, setCaptureProgress] = useState(0);
  const [sensitivity, setSensitivity] = useState<number>(1);

  const keyNodes = useRef(new Map<string, HTMLElement>());
  const dwell = useRef<DwellState>(emptyDwell());
  const phaseRef = useRef<Phase>("start");
  const modeRef = useRef<InputMode>("head");
  const activePointRef = useRef(0);
  const clicksRef = useRef(0);
  const measured = useRef<Point[]>([]);
  const lastUi = useRef(0);
  const cycleRef = useRef<Cycle | null>(null);
  const onGazeRef = useRef<(point: Point | null) => void>(() => {});
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackerRef = useRef<HeadTracker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturingRef = useRef(false);
  const captureStarted = useRef(0);
  const captureCount = useRef(0);
  const faceOkRef = useRef(false);

  phaseRef.current = phase;
  modeRef.current = mode;
  activePointRef.current = activePoint;

  const setKeyNode = useCallback((id: string, node: HTMLElement | null) => {
    if (node) keyNodes.current.set(id, node);
    else keyNodes.current.delete(id);
  }, []);

  const typeKey = useCallback((key: KeyDef, continuing: boolean) => {
    if (key.chars) {
      const { cycle, replace } = nextCycle(
        key,
        cycleRef.current,
        continuing,
        performance.now(),
      );
      const char = key.chars[cycle.index];
      cycleRef.current = cycle;
      setPending(cycle);
      setText((current) => (replace ? current.slice(0, -1) : current) + char);
    } else {
      cycleRef.current = null;
      setPending(null);
      setText((current) => applyKey(current, key));
    }
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
        const key = findKey(hit);
        if (key && !state.fired && now - state.since >= DWELL_MS) {
          state.fired = true;
          state.lastFire = now;
          typeKey(key, false);
        } else if (
          key?.chars &&
          state.fired &&
          now - state.lastFire >= CYCLE_MS
        ) {
          state.lastFire = now;
          typeKey(key, true);
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
        const snapped = shown ? keyCenter(shown, keyNodes.current) : null;
        setGaze(snapped ? { ...snapped, snapped: true } : { ...point, snapped: false });
        setHoveredKey(shown);
        let fill = 0;
        if (shown && !dwell.current.fired) {
          fill = (now - dwell.current.since) / DWELL_MS;
        } else if (shown && findKey(shown)?.chars) {
          fill = (now - dwell.current.lastFire) / CYCLE_MS;
        }
        setProgress(Math.min(1, fill));
      }
    },
    [typeKey],
  );

  // WebGazer calls this for every frame; route it by phase.
  useEffect(() => {
    onGazeRef.current = (point) => {
      if (!point) return;
      const current = phaseRef.current;
      if (current === "typing") {
        applyGazePoint(point);
        return;
      }
      if (current === "measure") measured.current.push(point);
      if (current === "calibrate" || current === "measure") {
        const now = performance.now();
        if (now - lastUi.current > 40) {
          lastUi.current = now;
          setGaze({ ...point, snapped: false });
        }
      }
    };
  }, [applyGazePoint]);

  const beginCalibration = useCallback(async (forMode: InputMode) => {
    if (forMode === "head") trackerRef.current?.reset();
    else await resetCalibration();
    capturingRef.current = false;
    setCapturing(false);
    setCaptureProgress(0);
    dwell.current = emptyDwell();
    clicksRef.current = 0;
    setClicks(0);
    setActivePoint(0);
    setAccuracy(null);
    setHoveredKey(null);
    setProgress(0);
    setGaze(null);
    setPhase("calibrate");
  }, []);

  const startMeasure = useCallback(() => {
    measured.current = [];
    setMeasureProgress(0);
    setGaze(null);
    setPhase("measure");
  }, []);

  const stopHead = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    trackerRef.current?.close();
    trackerRef.current = null;
  }, []);

  const startHeadTracking = useCallback(async () => {
    stopWebGazer();
    stopHead();
    setMode("head");
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

      const tracker = new HeadTracker(await createFaceLandmarker());
      tracker.sensitivity = sensitivity;
      trackerRef.current = tracker;
      await beginCalibration("head");
    } catch (err) {
      stopHead();
      setError(
        err instanceof Error
          ? err.message
          : "Camera permission is required for head tracking.",
      );
      setPhase("error");
    }
  }, [beginCalibration, sensitivity, stopHead]);

  const startEyeTracking = useCallback(async () => {
    stopWebGazer();
    stopHead();
    setMode("eye");
    setError(null);
    setPhase("loading");
    dwell.current = emptyDwell();
    setFaceOk(false);

    try {
      await startWebGazer((point) => onGazeRef.current(point));
      await beginCalibration("eye");
    } catch (err) {
      stopWebGazer();
      setError(
        err instanceof Error
          ? err.message
          : "Camera permission is required for eye tracking.",
      );
      setPhase("error");
    }
  }, [beginCalibration, stopHead]);

  const startMousePractice = useCallback(() => {
    stopWebGazer();
    stopHead();
    setMode("mouse");
    setError(null);
    setFaceOk(true);
    dwell.current = emptyDwell();
    setPhase("typing");
  }, [stopHead]);

  const startTyping = useCallback(() => {
    dwell.current = emptyDwell();
    setGaze(null);
    setPhase("typing");
  }, []);

  const onKeyClick = useCallback(
    (key: KeyDef) => {
      const current = phaseRef.current;
      if (current === "calibrate" && modeRef.current === "head") {
        if (key.id !== HEAD_CALIBRATION_KEYS[activePointRef.current]) return;
        if (capturingRef.current) return;
        captureStarted.current = 0;
        captureCount.current = 0;
        capturingRef.current = true;
        setCapturing(true);
        setCaptureProgress(0);
        return;
      }
      if (current === "calibrate") {
        if (key.id !== CALIBRATION_KEYS[activePointRef.current]) return;
        const target = keyCenter(key.id, keyNodes.current);
        if (target) recordCalibrationPoint(target);
        clicksRef.current += 1;
        if (clicksRef.current < CLICKS_PER_POINT) {
          setClicks(clicksRef.current);
          return;
        }
        clicksRef.current = 0;
        setClicks(0);
        const nextIndex = activePointRef.current + 1;
        if (nextIndex >= CALIBRATION_KEYS.length) startMeasure();
        else setActivePoint(nextIndex);
        return;
      }
      if (current !== "typing") return;
      const cycle = cycleRef.current;
      typeKey(
        key,
        cycle?.keyId === key.id && performance.now() - cycle.at < MULTITAP_MS,
      );
    },
    [startMeasure, typeKey],
  );

  // Accuracy check: stare at the centre key for MEASURE_MS, then score the
  // predictions the same way WebGazer's calibration demo does.
  useEffect(() => {
    if (phase !== "measure") return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const elapsed = performance.now() - started;
      setMeasureProgress(Math.min(1, elapsed / MEASURE_MS));
      if (elapsed < MEASURE_MS) return;
      window.clearInterval(timer);
      const target = keyCenter(MEASURE_KEY, keyNodes.current);
      setAccuracy(target ? precisionScore(measured.current, target) : 0);
      setPhase("result");
    }, 50);
    return () => window.clearInterval(timer);
  }, [phase]);

  // Head mode: run the face landmarker every frame, record poses while a
  // calibration key is capturing, otherwise turn poses into cursor points.
  useEffect(() => {
    if (mode !== "head") return;
    if (phase === "start" || phase === "loading" || phase === "error") return;

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      const tracker = trackerRef.current;
      if (!video || !tracker) return;

      const detected = tracker.detect(video);
      if (detected.faceOk !== faceOkRef.current) {
        faceOkRef.current = detected.faceOk;
        setFaceOk(detected.faceOk);
      }
      if (!detected.pose || !detected.fresh) return;

      if (phaseRef.current !== "calibrate") {
        const point = tracker.predict(detected.pose);
        if (point) onGazeRef.current(point);
        return;
      }
      if (!capturingRef.current) return;

      const target = keyCenter(
        HEAD_CALIBRATION_KEYS[activePointRef.current],
        keyNodes.current,
      );
      if (!target) return;
      const now = performance.now();
      if (captureStarted.current === 0) captureStarted.current = now;
      const elapsed = now - captureStarted.current;
      if (elapsed >= SETTLE_MS) {
        tracker.addSample(detected.pose, target);
        captureCount.current += 1;
      }
      setCaptureProgress(Math.min(1, elapsed / CAPTURE_MS));
      if (elapsed < CAPTURE_MS || captureCount.current < MIN_CAPTURE_SAMPLES) {
        return;
      }

      capturingRef.current = false;
      setCapturing(false);
      setCaptureProgress(0);
      const nextIndex = activePointRef.current + 1;
      if (nextIndex < HEAD_CALIBRATION_KEYS.length) {
        setActivePoint(nextIndex);
        return;
      }
      const anchor = keyCenter(HEAD_CALIBRATION_KEYS[0], keyNodes.current);
      if (!anchor || !tracker.fit(anchor)) {
        setError("Calibration failed. Keep your face in view and try again.");
        setPhase("error");
        return;
      }
      startMeasure();
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode, phase, startMeasure]);

  useEffect(() => {
    if (mode !== "eye" || phase === "start" || phase === "error") return;
    const timer = window.setInterval(() => setFaceOk(faceInBox()), 250);
    return () => window.clearInterval(timer);
  }, [mode, phase]);

  useEffect(() => {
    if (phase !== "typing" || mode !== "mouse") return;
    const onMove = (event: MouseEvent) =>
      applyGazePoint({ x: event.clientX, y: event.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [applyGazePoint, mode, phase]);

  useEffect(() => {
    return () => {
      stopWebGazer();
      stopHead();
    };
  }, [stopHead]);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPending(null), MULTITAP_MS + 100);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const chooseSensitivity = useCallback((value: number) => {
    setSensitivity(value);
    if (trackerRef.current) trackerRef.current.sensitivity = value;
  }, []);

  const clearText = useCallback(() => {
    cycleRef.current = null;
    setPending(null);
    setText("");
  }, []);

  const calibrating = phase === "calibrate" || phase === "measure";
  const showKeyboard = calibrating || phase === "result" || phase === "typing";
  const activeCalibKey =
    phase === "calibrate"
      ? calibrationKeys(mode)[activePoint]
      : phase === "measure"
        ? MEASURE_KEY
        : null;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#0b1220] text-[#f4efe4]">
      <video
        ref={videoRef}
        className={`pointer-events-none fixed top-3 left-3 z-40 h-[120px] w-[160px] rounded-2xl object-cover shadow-lg ring-2 -scale-x-100 ${
          mode === "head" && phase !== "start" && phase !== "error"
            ? "opacity-100"
            : "opacity-0"
        } ${faceOk ? "ring-emerald-400" : "ring-red-400"}`}
        autoPlay
        muted
        playsInline
      />

      {phase === "start" || phase === "error" ? (
        <StartScreen
          error={error}
          onStartHead={startHeadTracking}
          onStartCamera={startEyeTracking}
          onPractice={startMousePractice}
        />
      ) : null}

      {phase === "loading" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-sm tracking-[0.25em] text-[#d4a017] uppercase">
            {mode === "head" ? "Starting camera" : "Starting WebGazer"}
          </p>
          <h1 className="max-w-md text-4xl font-semibold tracking-tight">
            Keep your face in the frame.
          </h1>
        </div>
      ) : null}

      {showKeyboard ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-5 pt-3 sm:px-8">
          {phase === "typing" ? (
            <header
              className={`mb-3 flex shrink-0 items-start justify-end gap-3 ${mode !== "mouse" ? "pl-48" : ""}`}
            >
              <button
                type="button"
                onClick={clearText}
                className="rounded-full border border-white/15 px-4 py-2 text-sm"
              >
                Clear
              </button>
              {mode === "head" ? (
                <div className="mr-auto flex items-center gap-1 rounded-full border border-white/15 p-1 text-sm">
                  <span className="px-2 text-[#c8c0b0]">Sensitivity</span>
                  {SENSITIVITIES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => chooseSensitivity(value)}
                      className={`rounded-full px-3 py-1 ${
                        sensitivity === value
                          ? "bg-[#d4a017] text-[#0b1220]"
                          : "text-[#f4efe4]"
                      }`}
                    >
                      {value}×
                    </button>
                  ))}
                </div>
              ) : null}
              {mode !== "mouse" ? (
                <button
                  type="button"
                  onClick={() => beginCalibration(mode)}
                  className="rounded-full border border-white/15 px-4 py-2 text-sm"
                >
                  Recalibrate
                </button>
              ) : null}
            </header>
          ) : (
            <CalibrationHeader
              mode={mode}
              phase={phase}
              capturing={capturing}
              activePoint={activePoint}
              clicks={clicks}
              faceOk={faceOk}
              accuracy={accuracy}
              onStart={startTyping}
              onRecalibrate={() => beginCalibration(mode)}
            />
          )}

          {phase === "typing" ? (
            <section className="mx-auto mb-4 w-full max-w-6xl shrink-0 rounded-3xl bg-[#f4efe4] px-5 py-4 text-[#0b1220]">
              <p className="text-xs tracking-[0.22em] text-[#8a7f68] uppercase">
                {mode === "head"
                  ? "Head pointer"
                  : mode === "eye"
                    ? "Gaze output"
                    : "Mouse practice"}{" "}
                · hold a key
                for 1s, keep holding to cycle letters
              </p>
              <p className="mt-2 min-h-16 font-mono text-2xl leading-snug break-words whitespace-pre-wrap sm:text-3xl">
                {pending ? (
                  <>
                    {text.slice(0, -1)}
                    <span className="rounded bg-[#d4a017]/40 underline decoration-2 underline-offset-4">
                      {text.slice(-1)}
                    </span>
                  </>
                ) : (
                  text
                )}
                <span className="ml-0.5 inline-block w-[2px] animate-pulse bg-[#0b1220] align-baseline">
                  &nbsp;
                </span>
              </p>
            </section>
          ) : null}

          <Keyboard
            hoveredKey={calibrating ? activeCalibKey : phase === "typing" ? hoveredKey : null}
            progress={
              phase === "calibrate"
                ? mode === "head"
                  ? captureProgress
                  : clicks / CLICKS_PER_POINT
                : phase === "measure"
                  ? measureProgress
                  : progress
            }
            firedKey={phase === "typing" ? firedKey : null}
            pending={phase === "typing" ? pending : null}
            calibrating={calibrating}
            activeCalibKey={activeCalibKey}
            onKeyClick={onKeyClick}
            setKeyNode={setKeyNode}
          />
        </div>
      ) : null}

      {(phase === "typing" || calibrating) && gaze ? (
        <div
          className={`pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#d4a017] transition-[left,top] duration-150 ease-out ${
            gaze.snapped ? "size-6 bg-[#d4a017]/40" : "size-4 bg-[#d4a017]/15 opacity-60"
          }`}
          style={{ left: gaze.x, top: gaze.y }}
        />
      ) : null}
    </div>
  );
}

function CalibrationHeader({
  mode,
  phase,
  capturing,
  activePoint,
  clicks,
  faceOk,
  accuracy,
  onStart,
  onRecalibrate,
}: {
  mode: InputMode;
  phase: Phase;
  capturing: boolean;
  activePoint: number;
  clicks: number;
  faceOk: boolean;
  accuracy: number | null;
  onStart: () => void;
  onRecalibrate: () => void;
}) {
  const head = mode === "head";
  let eyebrow = `Calibration ${activePoint + 1} / ${calibrationKeys(mode).length}`;
  let title = head
    ? capturing
      ? "Hold still, facing that key."
      : "Turn your face toward the highlighted key, then click it."
    : `Look at the highlighted key and click it ${CLICKS_PER_POINT} times.`;
  let detail = head
    ? faceOk
      ? "Aim with your nose, like a laser pointer. Small, comfortable head turns are enough; you can raise sensitivity later."
      : "Move until the camera ring turns green."
    : faceOk
      ? `Keep your eyes on the key while you click. ${clicks} / ${CLICKS_PER_POINT} clicks.`
      : "Move until the box on the camera preview turns green.";

  if (phase === "measure") {
    eyebrow = "Measuring accuracy";
    title = head
      ? "Keep facing the highlighted key for 5 seconds."
      : "Stare at the highlighted key for 5 seconds.";
    detail = "Don't move the mouse. We're checking how close the predictions land.";
  } else if (phase === "result") {
    eyebrow = "Calibration done";
    title = `Accuracy: ${accuracy ?? 0}%`;
    detail =
      (accuracy ?? 0) >= 70
        ? "Good enough to type. Recalibrate if keys feel off."
        : "That's low. Check your lighting and head position, then recalibrate.";
  }

  return (
    <header className="relative z-20 mb-4 flex shrink-0 flex-wrap items-end justify-between gap-4 pl-48">
      <div>
        <p className="text-sm tracking-[0.25em] text-[#d4a017] uppercase">
          {eyebrow}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-[#c8c0b0]">{detail}</p>
      </div>
      {phase === "result" ? (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onRecalibrate}
            className="rounded-full border border-white/15 px-5 py-2.5 text-sm"
          >
            Recalibrate
          </button>
          <button
            type="button"
            onClick={onStart}
            className="rounded-full bg-[#d4a017] px-5 py-2.5 text-sm font-semibold text-[#0b1220]"
          >
            Start typing
          </button>
        </div>
      ) : null}
    </header>
  );
}

function StartScreen({
  error,
  onStartHead,
  onStartCamera,
  onPractice,
}: {
  error: string | null;
  onStartHead: () => void;
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
          Point at a key for one second to type it.
        </h1>
        <p className="max-w-xl text-base leading-7 text-[#c8c0b0] sm:text-lg sm:leading-8">
          Head tracking moves the cursor with where your face points. Eye
          tracking (WebGazer) follows your gaze instead. Both calibrate on the
          keyboard itself.
        </p>
      </div>
      <ol className="grid gap-3 text-sm text-[#c8c0b0] sm:grid-cols-3">
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Sit an arm&apos;s length away with your face in the camera preview.
        </li>
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Head: face each highlighted key and click it once. Eyes: look at
          each key and click it {CLICKS_PER_POINT} times.
        </li>
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Point at a key for 1 second to type its first letter. Keep pointing
          to cycle to the next one, then move away to keep it.
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
          onClick={onStartHead}
          className="rounded-full bg-[#d4a017] px-6 py-3 text-sm font-semibold text-[#0b1220]"
        >
          Head tracking
        </button>
        <button
          type="button"
          onClick={onStartCamera}
          className="rounded-full border border-white/15 px-6 py-3 text-sm text-[#f4efe4]"
        >
          Eye tracking (WebGazer)
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
  pending,
  calibrating,
  activeCalibKey,
  onKeyClick,
  setKeyNode,
}: {
  hoveredKey: string | null;
  progress: number;
  firedKey: string | null;
  pending: Cycle | null;
  calibrating: boolean;
  activeCalibKey: string | null;
  onKeyClick: (key: KeyDef) => void;
  setKeyNode: (id: string, node: HTMLElement | null) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-4xl min-h-0 flex-1 flex-col justify-end gap-4">
      {KEY_ROWS.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className="flex max-h-48 min-h-0 flex-1 justify-center gap-5"
        >
          {row.map((key) => {
            const hovered = hoveredKey === key.id;
            const fired = firedKey === key.id;
            const isActiveCalib = activeCalibKey === key.id;
            const dimmed = calibrating && !isActiveCalib;
            const cycling = pending?.keyId === key.id ? pending.index : null;
            return (
              <button
                key={key.id}
                type="button"
                ref={(node) => setKeyNode(key.id, node)}
                onClick={() => onKeyClick(key)}
                disabled={calibrating && !isActiveCalib}
                className="relative isolate h-full min-h-16 overflow-hidden rounded-2xl border font-semibold select-none"
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
                <span className="relative flex flex-col items-center leading-none">
                  <span className="text-2xl sm:text-3xl">{key.label}</span>
                  <span className="mt-1.5 font-mono text-sm tracking-[0.2em] uppercase opacity-70 sm:text-base">
                    {cycling !== null && key.chars
                      ? key.chars.map((char, index) => (
                          <span
                            key={index}
                            className={
                              index === cycling
                                ? "text-[#d4a017] underline opacity-100"
                                : ""
                            }
                          >
                            {char}
                          </span>
                        ))
                      : key.sub}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

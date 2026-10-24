"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyKey,
  CALIBRATION_KEYS,
  findKey,
  KEY_ROWS,
  keyCenter,
  nextCycle,
  pickGazeKey,
  type Cycle,
  type KeyDef,
} from "@/lib/keyboard";
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

type Phase =
  | "start"
  | "loading"
  | "calibrate"
  | "measure"
  | "result"
  | "typing"
  | "error";
type InputMode = "eye" | "mouse";

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
  const [mode, setMode] = useState<InputMode>("eye");
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

  const keyNodes = useRef(new Map<string, HTMLElement>());
  const dwell = useRef<DwellState>(emptyDwell());
  const phaseRef = useRef<Phase>("start");
  const modeRef = useRef<InputMode>("eye");
  const activePointRef = useRef(0);
  const clicksRef = useRef(0);
  const measured = useRef<Point[]>([]);
  const lastUi = useRef(0);
  const cycleRef = useRef<Cycle | null>(null);
  const onGazeRef = useRef<(point: Point | null) => void>(() => {});

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

  const beginCalibration = useCallback(async () => {
    await resetCalibration();
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

  const startEyeTracking = useCallback(async () => {
    stopWebGazer();
    setMode("eye");
    setError(null);
    setPhase("loading");
    dwell.current = emptyDwell();
    setFaceOk(false);

    try {
      await startWebGazer((point) => onGazeRef.current(point));
      await beginCalibration();
    } catch (err) {
      stopWebGazer();
      setError(
        err instanceof Error
          ? err.message
          : "Camera permission is required for eye tracking.",
      );
      setPhase("error");
    }
  }, [beginCalibration]);

  const startMousePractice = useCallback(() => {
    stopWebGazer();
    setMode("mouse");
    setError(null);
    setFaceOk(true);
    dwell.current = emptyDwell();
    setPhase("typing");
  }, []);

  const startTyping = useCallback(() => {
    dwell.current = emptyDwell();
    setGaze(null);
    setPhase("typing");
  }, []);

  const onKeyClick = useCallback(
    (key: KeyDef) => {
      const current = phaseRef.current;
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
    return () => stopWebGazer();
  }, []);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPending(null), MULTITAP_MS + 100);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const clearText = useCallback(() => {
    cycleRef.current = null;
    setPending(null);
    setText("");
  }, []);

  const calibrating = phase === "calibrate" || phase === "measure";
  const showKeyboard = calibrating || phase === "result" || phase === "typing";
  const activeCalibKey =
    phase === "calibrate"
      ? CALIBRATION_KEYS[activePoint]
      : phase === "measure"
        ? MEASURE_KEY
        : null;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#0b1220] text-[#f4efe4]">
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
            Starting WebGazer
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
              className={`mb-3 flex shrink-0 items-start justify-end gap-3 ${mode === "eye" ? "pl-48" : ""}`}
            >
              <button
                type="button"
                onClick={clearText}
                className="rounded-full border border-white/15 px-4 py-2 text-sm"
              >
                Clear
              </button>
              {mode === "eye" ? (
                <button
                  type="button"
                  onClick={beginCalibration}
                  className="rounded-full border border-white/15 px-4 py-2 text-sm"
                >
                  Recalibrate
                </button>
              ) : null}
            </header>
          ) : (
            <CalibrationHeader
              phase={phase}
              activePoint={activePoint}
              clicks={clicks}
              faceOk={faceOk}
              accuracy={accuracy}
              onStart={startTyping}
              onRecalibrate={beginCalibration}
            />
          )}

          {phase === "typing" ? (
            <section className="mx-auto mb-4 w-full max-w-6xl shrink-0 rounded-3xl bg-[#f4efe4] px-5 py-4 text-[#0b1220]">
              <p className="text-xs tracking-[0.22em] text-[#8a7f68] uppercase">
                {mode === "eye" ? "Gaze output" : "Mouse practice"} · hold a key
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
                ? clicks / CLICKS_PER_POINT
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
  phase,
  activePoint,
  clicks,
  faceOk,
  accuracy,
  onStart,
  onRecalibrate,
}: {
  phase: Phase;
  activePoint: number;
  clicks: number;
  faceOk: boolean;
  accuracy: number | null;
  onStart: () => void;
  onRecalibrate: () => void;
}) {
  let eyebrow = `Calibration ${activePoint + 1} / ${CALIBRATION_KEYS.length}`;
  let title = `Look at the highlighted key and click it ${CLICKS_PER_POINT} times.`;
  let detail = faceOk
    ? `Keep your eyes on the key while you click. ${clicks} / ${CLICKS_PER_POINT} clicks.`
    : "Move until the box on the camera preview turns green.";

  if (phase === "measure") {
    eyebrow = "Measuring accuracy";
    title = "Stare at the highlighted key for 5 seconds.";
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
          Eye tracking runs on WebGazer. Calibration happens on the keyboard
          itself, so the model is trained on the real key positions.
        </p>
      </div>
      <ol className="grid gap-3 text-sm text-[#c8c0b0] sm:grid-cols-3">
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Sit an arm&apos;s length away. The box on the camera preview must
          stay green.
        </li>
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Click each highlighted key {CLICKS_PER_POINT} times while looking at
          it, then stare at the centre key for 5 seconds.
        </li>
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Look at a key for 1 second to type its first letter. Keep looking to
          cycle to the next one, then look away to keep it.
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

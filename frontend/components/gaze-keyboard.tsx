"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  applyKey,
  CALIBRATION_KEYS,
  deleteLastWord,
  findKey,
  HEAD_CALIBRATION_KEYS,
  KEY_ROWS,
  keyCenter,
  nextCycle,
  pickGazeKey,
  type Cycle,
  type KeyDef,
} from "@/lib/keyboard";
import {
  createFaceLandmarker,
  HeadTracker,
  type EyeOpenness,
  type HeadPose,
} from "@/lib/head";
import { speakText } from "@/lib/speech";
import {
  isWordDigit,
  loadDictionary,
  previewWord,
  suggest,
  type Dictionary,
} from "@/lib/t9";
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
// Keeping the pointer on a key presses it again at this interval.
const REPEAT_MS = 900;
// Adaptive delete: each repeat of a held backspace comes BACKSPACE_SPEEDUP
// times sooner than the last (floored at BACKSPACE_MIN_MS); after
// BACKSPACE_WORD_AFTER repeats it deletes whole words every BACKSPACE_WORD_MS.
const BACKSPACE_SPEEDUP = 0.75;
const BACKSPACE_MIN_MS = 150;
const BACKSPACE_WORD_AFTER = 8;
const BACKSPACE_WORD_MS = 400;
// Shows a corner button that fills the box with random words, for testing.
const DEBUG_TOOLS = true;
const MULTITAP_MS = 900;
const SWITCH_MS = 160;
const GRACE_MS = 280;
const CLICKS_PER_POINT = 5;
const MEASURE_MS = 5000;
const MEASURE_KEY = CALIBRATION_KEYS[CALIBRATION_KEYS.length - 1];
// Head calibration is hands-free: a key records once the head has turned
// toward it and held still (pose within STILL_TOLERANCE over
// STILL_WINDOW_MS) for STILL_MS, then for CAPTURE_MS more. Moving resets it.
const STILL_WINDOW_MS = 400;
const STILL_TOLERANCE = 0.02;
const STILL_MS = 600;
const CAPTURE_MS = 1000;
const MIN_CAPTURE_SAMPLES = 8;
// The first (centre) key waits this long so the user can settle; later keys
// instead require the head to have turned at least MIN_TURN from the last
// key, so a still head can't be recorded against the wrong target.
const FIRST_POINT_DELAY_MS = 1500;
const MIN_TURN = 0.04;
// Wink calibration runs on a timer: get ready, close the eye, then record.
// A failed step retries after WINK_RETRY_MS; after WINK_MAX_ATTEMPTS it
// falls back to the default threshold so nobody gets stuck.
const WINK_READY_MS = 2000;
const WINK_SETTLE_MS = 700;
const WINK_CAPTURE_MS = 1200;
const WINK_TOTAL_MS = WINK_READY_MS + WINK_SETTLE_MS + WINK_CAPTURE_MS;
const WINK_RETRY_MS = 2500;
const WINK_MAX_ATTEMPTS = 3;
const WINK_STEPS = [
  {
    id: "open",
    title: "Both eyes open",
    instruction: "Keep both eyes open and relaxed.",
  },
  {
    id: "left",
    title: "Wink your left eye",
    instruction: "Close only your LEFT eye and hold it.",
  },
  {
    id: "right",
    title: "Wink your right eye",
    instruction: "Close only your RIGHT eye and hold it.",
  },
] as const;
// Action keys beside the output box. They snap and dwell like the keypad but
// never repeat when held.
const CLEAR_KEY: KeyDef = { id: "clear", label: "Clear" };
const SPEAK_KEY: KeyDef = { id: "speak", label: "Read aloud" };
// Full-width snap strips along the top and bottom of the output box. Holding
// one for SCROLL_DELAY_MS scrolls the box at SCROLL_SPEED px/s.
const SCROLL_UP_KEY: KeyDef = { id: "scroll-up", label: "Scroll up" };
const SCROLL_DOWN_KEY: KeyDef = { id: "scroll-down", label: "Scroll down" };
const SCROLL_DIRECTION: Record<string, number> = {
  [SCROLL_UP_KEY.id]: -1,
  [SCROLL_DOWN_KEY.id]: 1,
};
const SCROLL_DELAY_MS = 400;
const SCROLL_SPEED = 60;
// Dwell buttons for the calibration result and the pause panel.
const START_TYPING_KEY: KeyDef = { id: "start-typing", label: "Start typing" };
const RECALIBRATE_KEY: KeyDef = { id: "recalibrate", label: "Recalibrate" };
const CONTROL_KEYS = [
  CLEAR_KEY,
  SPEAK_KEY,
  SCROLL_UP_KEY,
  SCROLL_DOWN_KEY,
  START_TYPING_KEY,
  RECALIBRATE_KEY,
];
// Keys that act once however long you keep pointing at them.
const ONCE_KEY_IDS = new Set([
  CLEAR_KEY.id,
  SPEAK_KEY.id,
  START_TYPING_KEY.id,
  RECALIBRATE_KEY.id,
]);
// What still responds to the pointer while paused.
const PAUSE_KEY_IDS = new Set([
  CLEAR_KEY.id,
  SPEAK_KEY.id,
  SCROLL_UP_KEY.id,
  SCROLL_DOWN_KEY.id,
  RECALIBRATE_KEY.id,
]);
const RESULT_KEY_IDS = new Set([START_TYPING_KEY.id, RECALIBRATE_KEY.id]);
const SUGGESTION_COUNT = 4;
const SUGGESTION_PREFIX = "suggest-";

// Predictive: one press per letter, words come from the dictionary.
// Multi-tap: press (or keep pointing) to cycle a key's letters.
type Entry = "predictive" | "multitap";
const ENTRIES: Array<{ id: Entry; label: string }> = [
  { id: "predictive", label: "Predictive" },
  { id: "multitap", label: "Multi-tap" },
];

type Phase =
  | "start"
  | "loading"
  | "calibrate"
  | "measure"
  | "result"
  | "winkCalibrate"
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
  // Repeats since the first press while held on the same key.
  repeats: number;
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
    repeats: 0,
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
  const [captureProgress, setCaptureProgress] = useState(0);
  const [entry, setEntry] = useState<Entry>("predictive");
  const [digits, setDigits] = useState("");
  const [dict, setDict] = useState<Dictionary | null>(null);
  const [paused, setPaused] = useState(false);
  const [winkStep, setWinkStep] = useState(0);
  const [winkFallback, setWinkFallback] = useState(false);
  const [winkProgress, setWinkProgress] = useState(0);
  const [winkError, setWinkError] = useState<string | null>(null);

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
  // Hands-free head calibration state for the current key.
  const poseWindow = useRef<Array<HeadPose & { t: number }>>([]);
  const stillSince = useRef(0);
  const pointSamples = useRef<HeadPose[]>([]);
  const pointShownAt = useRef(0);
  const lastPointPose = useRef<HeadPose | null>(null);
  const faceOkRef = useRef(false);
  const entryRef = useRef<Entry>("predictive");
  const digitsRef = useRef("");
  const dictRef = useRef<Dictionary | null>(null);
  const suggestionsRef = useRef<KeyDef[]>([]);
  const pausedRef = useRef(false);
  const outputRef = useRef<HTMLParagraphElement>(null);
  const textRef = useRef("");
  const winkStepRef = useRef(0);
  const winkAttempts = useRef(0);
  const winkRetryAt = useRef(0);
  const winkCaptureStart = useRef(0);
  const winkSamples = useRef<EyeOpenness[]>([]);
  // Actions defined after typeKey that its dwell keys need to trigger.
  const actionsRef = useRef({ startTyping: () => {}, recalibrate: () => {} });

  phaseRef.current = phase;
  modeRef.current = mode;
  activePointRef.current = activePoint;

  const setKeyNode = useCallback((id: string, node: HTMLElement | null) => {
    if (node) keyNodes.current.set(id, node);
    else keyNodes.current.delete(id);
  }, []);

  // Turns the digit sequence being typed into its best word.
  const commitComposing = useCallback(() => {
    const sequence = digitsRef.current;
    if (!sequence) return;
    const word = previewWord(dictRef.current, sequence);
    digitsRef.current = "";
    setDigits("");
    setText((current) => current + word);
  }, []);

  const setSequence = useCallback((next: string) => {
    digitsRef.current = next;
    setDigits(next);
  }, []);

  // `wholeWord` makes backspace delete a word (adaptive delete).
  const typeKey = useCallback((key: KeyDef, continuing: boolean, wholeWord = false) => {
    setFiredKey(key.id);
    window.setTimeout(() => {
      setFiredKey((current) => (current === key.id ? null : current));
    }, 160);

    if (key.id === CLEAR_KEY.id) {
      cycleRef.current = null;
      setPending(null);
      setSequence("");
      setText("");
      return;
    }
    if (key.id === START_TYPING_KEY.id) {
      actionsRef.current.startTyping();
      return;
    }
    if (key.id === RECALIBRATE_KEY.id) {
      actionsRef.current.recalibrate();
      return;
    }
    if (key.id === SPEAK_KEY.id) {
      speakText(textRef.current + previewWord(dictRef.current, digitsRef.current));
      return;
    }
    if (key.id.startsWith(SUGGESTION_PREFIX)) {
      cycleRef.current = null;
      setPending(null);
      setSequence("");
      setText((current) => current + key.label + " ");
      return;
    }
    if (entryRef.current === "predictive") {
      if (isWordDigit(key.id)) {
        cycleRef.current = null;
        setPending(null);
        setSequence(digitsRef.current + key.id);
        return;
      }
      if (key.id === "backspace" && digitsRef.current) {
        setSequence(wholeWord ? "" : digitsRef.current.slice(0, -1));
        return;
      }
      commitComposing();
    }

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
      setText((current) =>
        wholeWord && key.id === "backspace"
          ? deleteLastWord(current)
          : applyKey(current, key),
      );
    }
  }, [commitComposing, setSequence]);

  const resolveKey = useCallback((id: string) => {
    const action = CONTROL_KEYS.find((key) => key.id === id);
    if (action) return action;
    if (!id.startsWith(SUGGESTION_PREFIX)) return findKey(id);
    return suggestionsRef.current.find((key) => key.id === id) ?? null;
  }, []);

  // Keeping the pointer on a key cycles its letters in multi-tap; in
  // predictive mode only the punctuation key (1) still cycles.
  const cyclesOnHold = useCallback(
    (key: KeyDef | null) =>
      Boolean(
        key?.chars && (entryRef.current === "multitap" || !isWordDigit(key.id)),
      ),
    [],
  );

  // Suggestions and action keys act once, so holding them must not repeat.
  // Backspace speeds up the longer it's held (see BACKSPACE_*).
  const holdInterval = useCallback(
    (key: KeyDef | null, repeats = 0) => {
      if (!key || key.id.startsWith(SUGGESTION_PREFIX)) return null;
      if (ONCE_KEY_IDS.has(key.id)) return null;
      if (key.id === "backspace") {
        if (repeats >= BACKSPACE_WORD_AFTER) return BACKSPACE_WORD_MS;
        return Math.max(
          BACKSPACE_MIN_MS,
          REPEAT_MS * BACKSPACE_SPEEDUP ** repeats,
        );
      }
      return cyclesOnHold(key) ? CYCLE_MS : REPEAT_MS;
    },
    [cyclesOnHold],
  );

  // `allowed`, if given, limits which keys the pointer can select (e.g. only
  // the pause-panel keys while paused).
  const applyGazePoint = useCallback(
    (point: Point, allowed?: Set<string>) => {
      const now = performance.now();
      const state = dwell.current;
      const hit = pickGazeKey(
        point.x,
        point.y,
        state.keyId,
        keyNodes.current,
        allowed ? (id) => allowed.has(id) : undefined,
      );
      const scrollDir = hit ? SCROLL_DIRECTION[hit] : undefined;

      if (hit && hit === state.keyId && scrollDir) {
        state.leftAt = null;
        state.pendingId = null;
        const output = outputRef.current;
        const last = state.lastFire > state.since ? state.lastFire : now;
        if (output && now - state.since >= SCROLL_DELAY_MS) {
          output.scrollTop += (scrollDir * SCROLL_SPEED * (now - last)) / 1000;
        }
        state.lastFire = now;
      } else if (hit && hit === state.keyId) {
        state.leftAt = null;
        state.pendingId = null;
        const key = resolveKey(hit);
        const interval = holdInterval(key, state.repeats);
        if (key && !state.fired && now - state.since >= DWELL_MS) {
          state.fired = true;
          state.lastFire = now;
          state.repeats = 0;
          typeKey(key, false);
        } else if (
          key &&
          interval !== null &&
          state.fired &&
          now - state.lastFire >= interval
        ) {
          state.lastFire = now;
          state.repeats += 1;
          // Multi-tap keys cycle their letters; everything else repeats.
          typeKey(
            key,
            cyclesOnHold(key),
            state.repeats > BACKSPACE_WORD_AFTER,
          );
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
          state.repeats = 0;
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
        if (shown && SCROLL_DIRECTION[shown]) {
          fill = (now - dwell.current.since) / SCROLL_DELAY_MS;
        } else if (shown && !dwell.current.fired) {
          fill = (now - dwell.current.since) / DWELL_MS;
        } else if (shown) {
          const interval = holdInterval(
            resolveKey(shown),
            dwell.current.repeats,
          );
          if (interval !== null) {
            fill = (now - dwell.current.lastFire) / interval;
          }
        }
        setProgress(Math.min(1, fill));
      }
    },
    [cyclesOnHold, holdInterval, resolveKey, typeKey],
  );

  // While paused the cursor still moves, but only Clear, Read aloud and the
  // scroll strips respond.
  const setPausedState = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPaused(next);
    dwell.current = emptyDwell();
    setHoveredKey(null);
    setProgress(0);
  }, []);

  const chooseEntry = useCallback(
    (next: Entry) => {
      commitComposing();
      cycleRef.current = null;
      setPending(null);
      entryRef.current = next;
      setEntry(next);
    },
    [commitComposing],
  );

  // WebGazer calls this for every frame; route it by phase.
  useEffect(() => {
    onGazeRef.current = (point) => {
      if (!point) return;
      const current = phaseRef.current;
      if (current === "typing") {
        applyGazePoint(point, pausedRef.current ? PAUSE_KEY_IDS : undefined);
        return;
      }
      if (current === "result") {
        applyGazePoint(point, RESULT_KEY_IDS);
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
    poseWindow.current = [];
    stillSince.current = 0;
    pointSamples.current = [];
    pointShownAt.current = performance.now();
    lastPointPose.current = null;
    setCaptureProgress(0);
    dwell.current = emptyDwell();
    clicksRef.current = 0;
    setClicks(0);
    setActivePoint(0);
    setAccuracy(null);
    setHoveredKey(null);
    setProgress(0);
    setGaze(null);
    setPausedState(false);
    setPhase("calibrate");
  }, [setPausedState]);

  const startMeasure = useCallback(() => {
    measured.current = [];
    setMeasureProgress(0);
    setGaze(null);
    setPhase("measure");
  }, []);

  const startWinkCalibration = useCallback(() => {
    winkStepRef.current = 0;
    winkAttempts.current = 0;
    winkRetryAt.current = 0;
    winkSamples.current = [];
    winkCaptureStart.current = performance.now();
    setWinkStep(0);
    setWinkProgress(0);
    setWinkError(null);
    setWinkFallback(false);
    setGaze(null);
    setPhase("winkCalibrate");
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

      trackerRef.current = new HeadTracker(await createFaceLandmarker());
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
  }, [beginCalibration, stopHead]);

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
    setPausedState(false);
    setGaze(null);
    setPhase("typing");
  }, [setPausedState]);

  useEffect(() => {
    actionsRef.current = {
      startTyping,
      recalibrate: () => void beginCalibration(modeRef.current),
    };
  }, [beginCalibration, startTyping]);

  const onKeyClick = useCallback(
    (key: KeyDef) => {
      const current = phaseRef.current;
      if (current === "result" && RESULT_KEY_IDS.has(key.id)) {
        typeKey(key, false);
        return;
      }
      // Head calibration is hands-free; clicks only drive eye calibration.
      if (current === "calibrate" && modeRef.current === "head") return;
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
      // Left wink pauses/resumes; right wink switches typing mode.
      if (detected.wink && phaseRef.current === "typing") {
        if (detected.wink === "left") setPausedState(!pausedRef.current);
        else {
          chooseEntry(
            entryRef.current === "predictive" ? "multitap" : "predictive",
          );
        }
      }
      if (phaseRef.current === "winkCalibrate") {
        // Timed by the clock, not by camera frames, so the bar always moves;
        // if frames stall, the step simply fails and retries.
        const now = performance.now();
        if (winkRetryAt.current) {
          if (now < winkRetryAt.current) return;
          winkRetryAt.current = 0;
          winkSamples.current = [];
          winkCaptureStart.current = now;
          setWinkError(null);
        }
        const elapsed = now - winkCaptureStart.current;
        if (
          detected.fresh &&
          detected.eyes &&
          elapsed >= WINK_READY_MS + WINK_SETTLE_MS
        ) {
          winkSamples.current.push(detected.eyes);
        }
        setWinkProgress(Math.min(1, elapsed / WINK_TOTAL_MS));
        if (elapsed < WINK_TOTAL_MS) return;

        const step = WINK_STEPS[winkStepRef.current];
        const result =
          step.id === "open"
            ? tracker.calibrateWinkOpen(winkSamples.current)
            : tracker.calibrateWink(step.id, winkSamples.current);
        if (!result.ok) {
          winkAttempts.current += 1;
          if (winkAttempts.current < WINK_MAX_ATTEMPTS) {
            setWinkError(`${result.reason} Retrying…`);
            winkRetryAt.current = now + WINK_RETRY_MS;
            return;
          }
          // Out of attempts: keep the default threshold for this step.
          setWinkFallback(true);
        }
        const next = winkStepRef.current + 1;
        if (next >= WINK_STEPS.length) {
          startMeasure();
          return;
        }
        winkStepRef.current = next;
        winkAttempts.current = 0;
        winkSamples.current = [];
        winkCaptureStart.current = now;
        setWinkStep(next);
        setWinkError(null);
        setWinkProgress(0);
        return;
      }
      if (!detected.pose || !detected.fresh) return;

      if (phaseRef.current !== "calibrate") {
        const point = tracker.predict(detected.pose);
        if (point) onGazeRef.current(point);
        return;
      }
      const target = keyCenter(
        HEAD_CALIBRATION_KEYS[activePointRef.current],
        keyNodes.current,
      );
      if (!target) return;
      const now = performance.now();
      const pose = detected.pose;
      const recent = poseWindow.current;
      recent.push({ ...pose, t: now });
      while (recent.length && recent[0].t < now - STILL_WINDOW_MS) recent.shift();

      const meanYaw = recent.reduce((sum, p) => sum + p.yaw, 0) / recent.length;
      const meanPitch = recent.reduce((sum, p) => sum + p.pitch, 0) / recent.length;
      const still =
        recent[0].t <= now - STILL_WINDOW_MS * 0.8 &&
        recent.every(
          (p) =>
            Math.abs(p.yaw - meanYaw) < STILL_TOLERANCE &&
            Math.abs(p.pitch - meanPitch) < STILL_TOLERANCE,
        );
      const last = lastPointPose.current;
      const turned = last
        ? Math.hypot(pose.yaw - last.yaw, pose.pitch - last.pitch) >= MIN_TURN
        : now - pointShownAt.current >= FIRST_POINT_DELAY_MS;

      if (!still || !turned) {
        if (stillSince.current !== 0) {
          stillSince.current = 0;
          pointSamples.current = [];
          setCaptureProgress(0);
        }
        return;
      }
      if (stillSince.current === 0) stillSince.current = now;
      const held = now - stillSince.current;
      if (held >= STILL_MS) pointSamples.current.push(pose);
      setCaptureProgress(Math.min(1, held / (STILL_MS + CAPTURE_MS)));
      if (
        held < STILL_MS + CAPTURE_MS ||
        pointSamples.current.length < MIN_CAPTURE_SAMPLES
      ) {
        return;
      }

      for (const sample of pointSamples.current) tracker.addSample(sample, target);
      const samples = pointSamples.current;
      lastPointPose.current = {
        yaw: samples.reduce((sum, p) => sum + p.yaw, 0) / samples.length,
        pitch: samples.reduce((sum, p) => sum + p.pitch, 0) / samples.length,
      };
      stillSince.current = 0;
      pointSamples.current = [];
      poseWindow.current = [];
      pointShownAt.current = now;
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
      startWinkCalibration();
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [
    chooseEntry,
    mode,
    phase,
    setPausedState,
    startMeasure,
    startWinkCalibration,
  ]);

  useEffect(() => {
    if (mode !== "eye" || phase === "start" || phase === "error") return;
    const timer = window.setInterval(() => setFaceOk(faceInBox()), 250);
    return () => window.clearInterval(timer);
  }, [mode, phase]);

  useEffect(() => {
    if (phase !== "typing" || mode !== "mouse") return;
    const onMove = (event: MouseEvent) =>
      onGazeRef.current({ x: event.clientX, y: event.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [mode, phase]);

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

  useEffect(() => {
    let cancelled = false;
    loadDictionary()
      .then((loaded) => {
        if (cancelled) return;
        dictRef.current = loaded;
        setDict(loaded);
      })
      .catch(() => {
        // Without a dictionary, predictive mode falls back to first letters.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const suggestions = useMemo<KeyDef[]>(
    () =>
      suggest(dict, digits, SUGGESTION_COUNT).map((word, index) => ({
        id: `${SUGGESTION_PREFIX}${index}`,
        label: word,
      })),
    [dict, digits],
  );
  const composing = useMemo(() => previewWord(dict, digits), [dict, digits]);

  useEffect(() => {
    suggestionsRef.current = suggestions;
  }, [suggestions]);

  // The output box is two lines tall; keep the newest text in view.
  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [text, composing, phase]);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  // DEBUG_TOOLS: append ~40 random common words to test deleting/scrolling.
  const addDebugWords = useCallback(() => {
    const pool = dictRef.current?.entries.slice(0, 2000).map((e) => e.word) ?? [
      "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog",
    ];
    const words = Array.from(
      { length: 40 },
      () => pool[Math.floor(Math.random() * pool.length)],
    );
    commitComposing();
    setText((current) => current + words.join(" ") + " ");
  }, [commitComposing]);

  const actionKey = (key: KeyDef) => (
    <KeyButton
      keyDef={key}
      compact
      hovered={hoveredKey === key.id}
      fired={firedKey === key.id}
      progress={progress}
      isActiveCalib={false}
      dimmed={false}
      cycling={null}
      onClick={() => onKeyClick(key)}
      setKeyNode={setKeyNode}
    />
  );

  // Invisible until the pointer is on it; tints while counting down and
  // stronger while scrolling.
  const scrollStrip = (key: KeyDef, edge: string) => {
    const hovered = hoveredKey === key.id;
    return (
      <div
        ref={(node) => setKeyNode(key.id, node)}
        data-snap="row"
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 h-[38%] transition-colors ${edge} ${
          edge === "top-0" ? "rounded-t-3xl" : "rounded-b-3xl"
        } ${
          hovered
            ? progress >= 1
              ? "bg-[#d4a017]/25"
              : "bg-[#d4a017]/10"
            : "bg-transparent"
        }`}
      />
    );
  };

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
      {/* The landmarker reads frames from this element, so it stays mounted
          and playing, just never shown. */}
      <video
        ref={videoRef}
        aria-hidden
        className="pointer-events-none fixed top-0 left-0 size-px opacity-0"
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
            <div className="mx-auto mb-4 flex w-full max-w-6xl shrink-0 items-stretch gap-4">
              <div className="flex w-28 shrink-0 sm:w-32">
                {actionKey(CLEAR_KEY)}
              </div>
              <section
                className="relative min-w-0 flex-1 rounded-3xl bg-[#f4efe4] px-5 py-4 text-[#0b1220]"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs tracking-[0.22em] text-[#8a7f68] uppercase">
                    {entry === "predictive"
                      ? "One press per letter, then pick a word"
                      : "Keep pointing to cycle letters"}
                  </p>
                  <div className="flex items-center gap-3">
                    {paused ? (
                      <span className="rounded-full bg-[#d4a017] px-3 py-1 text-xs font-semibold tracking-[0.15em] uppercase">
                        Paused
                      </span>
                    ) : null}
                    {mode === "head" ? (
                      <span className="text-xs text-[#8a7f68]">
                        wink right to switch
                      </span>
                    ) : null}
                    <EntrySlider value={entry} onChange={chooseEntry} />
                  </div>
                </div>
                <p
                  ref={outputRef}
                  className="mt-2 h-[2lh] overflow-y-auto font-mono text-2xl leading-snug break-words whitespace-pre-wrap sm:text-3xl"
                >
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
                  {composing ? (
                    <span className="rounded bg-[#d4a017]/40 underline decoration-2 underline-offset-4">
                      {composing}
                    </span>
                  ) : null}
                  <span className="ml-0.5 inline-block w-[2px] animate-pulse bg-[#0b1220] align-baseline">
                    &nbsp;
                  </span>
                </p>
                {scrollStrip(SCROLL_UP_KEY, "top-0")}
                {scrollStrip(SCROLL_DOWN_KEY, "bottom-0")}
              </section>
              <div className="flex w-28 shrink-0 sm:w-32">
                {actionKey(SPEAK_KEY)}
              </div>
            </div>
          ) : (
            <CalibrationHeader
              mode={mode}
              phase={phase}
              capturing={captureProgress > 0}
              activePoint={activePoint}
              clicks={clicks}
              faceOk={faceOk}
              accuracy={accuracy}
              winkFallback={winkFallback}
              renderKey={actionKey}
            />
          )}

          <div
            className={`relative flex min-h-0 flex-1 flex-col transition-opacity ${
              paused && phase === "typing" ? "opacity-30" : ""
            }`}
          >
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
              suggestions={
                phase === "typing" && entry === "predictive" ? suggestions : null
              }
              composing={digits.length > 0}
              calibrating={calibrating}
              activeCalibKey={activeCalibKey}
              onKeyClick={onKeyClick}
              setKeyNode={setKeyNode}
            />
          </div>
          {DEBUG_TOOLS && phase === "typing" ? (
            <button
              type="button"
              onClick={addDebugWords}
              className="fixed bottom-0.5 left-3 z-30 text-[11px] text-[#c8c0b0]/70"
            >
              Debug: add words
            </button>
          ) : null}
          {phase === "typing" && mode !== "head" ? (
            <div className="fixed right-3 bottom-0.5 z-30 text-[11px] text-[#c8c0b0]/70">
              <button type="button" onClick={() => setPausedState(!paused)}>
                {paused ? "Resume" : "Pause"}
              </button>
            </div>
          ) : null}
          {paused && phase === "typing" ? (
            <div className="fixed inset-x-0 bottom-[22vh] z-30 flex justify-center px-4">
              <div className="rounded-3xl border border-[#d4a017]/60 bg-[#0b1220]/90 px-8 py-5 text-center shadow-2xl">
                <p className="text-sm tracking-[0.25em] text-[#d4a017] uppercase">
                  Paused
                </p>
                <p className="mt-1 text-xl font-semibold">
                  {mode === "head"
                    ? "Wink your left eye to resume."
                    : "Press Resume to keep typing."}
                </p>
                {mode !== "mouse" ? (
                  <div className="mx-auto mt-4 flex h-20 w-64">
                    {actionKey(RECALIBRATE_KEY)}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === "winkCalibrate" ? (
        <WinkCalibration
          step={winkStep}
          progress={winkProgress}
          error={winkError}
          faceOk={faceOk}
        />
      ) : null}

      {(phase === "typing" || phase === "result" || calibrating) && gaze ? (
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
  winkFallback,
  renderKey,
}: {
  mode: InputMode;
  phase: Phase;
  capturing: boolean;
  activePoint: number;
  clicks: number;
  faceOk: boolean;
  accuracy: number | null;
  winkFallback: boolean;
  renderKey: (key: KeyDef) => ReactNode;
}) {
  const head = mode === "head";
  let eyebrow = `Calibration ${activePoint + 1} / ${calibrationKeys(mode).length}`;
  let title = head
    ? capturing
      ? "Hold still, facing that key."
      : "Turn your face toward the highlighted key and hold still."
    : `Look at the highlighted key and click it ${CLICKS_PER_POINT} times.`;
  let detail = head
    ? faceOk
      ? "Aim with your nose, like a laser pointer. It records by itself once you hold still."
      : "No face detected. Move into the camera's view."
    : faceOk
      ? `Keep your eyes on the key while you click. ${clicks} / ${CLICKS_PER_POINT} clicks.`
      : "Face not centred. Move into the middle of the camera's view.";

  if (phase === "measure") {
    eyebrow = "Measuring accuracy";
    title = head
      ? "Keep facing the highlighted key for 5 seconds."
      : "Stare at the highlighted key for 5 seconds.";
    detail = "Hold still. We're checking how close the pointer lands.";
  } else if (phase === "result") {
    eyebrow = "Calibration done";
    title = `Accuracy: ${accuracy ?? 0}%`;
    detail =
      (accuracy ?? 0) >= 70
        ? "Good enough to type. Point at a button to continue."
        : "That's low. Check your lighting and head position, then recalibrate.";
    if (winkFallback) {
      detail += " Some winks couldn't be calibrated, so they use the default.";
    }
  }

  return (
    <header className="relative z-20 mb-4 flex shrink-0 flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-sm tracking-[0.25em] text-[#d4a017] uppercase">
          {eyebrow}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-[#c8c0b0]">{detail}</p>
      </div>
      {phase === "result" ? (
        <div className="flex h-20 gap-4">
          <div className="flex w-48">{renderKey(RECALIBRATE_KEY)}</div>
          <div className="flex w-48">{renderKey(START_TYPING_KEY)}</div>
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
          Head: face each highlighted key and hold still; it records by
          itself. Eyes: look at each key and click it {CLICKS_PER_POINT} times.
        </li>
        <li className="rounded-2xl border border-white/10 bg-white/5 p-4">
          Point at a key for 1 second to press it. Press each letter&apos;s key
          once (4-6-6-3 for &ldquo;good&rdquo;), then pick a suggestion.
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

function WinkCalibration({
  step,
  progress,
  error,
  faceOk,
}: {
  step: number;
  progress: number;
  error: string | null;
  faceOk: boolean;
}) {
  const current = WINK_STEPS[step];
  const elapsed = progress * WINK_TOTAL_MS;
  const status = error
    ? "Retrying in a moment…"
    : elapsed < WINK_READY_MS
      ? `Get ready… ${Math.ceil((WINK_READY_MS - elapsed) / 1000)}`
      : elapsed < WINK_READY_MS + WINK_SETTLE_MS
        ? current.id === "open"
          ? "Eyes open now"
          : `Close your ${current.id.toUpperCase()} eye now`
        : "Hold it…";
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 py-10">
      <div>
        <p className="text-sm tracking-[0.25em] text-[#d4a017] uppercase">
          Wink calibration {step + 1} / {WINK_STEPS.length}
        </p>
        <h1 className="mt-1 text-4xl font-semibold tracking-tight">
          {current.title}
        </h1>
        <p className="mt-2 text-lg text-[#c8c0b0]">
          {faceOk
            ? current.instruction
            : "No face detected. Move into the camera's view."}
        </p>
      </div>

      <ol className="grid grid-cols-3 gap-3 text-sm">
        {WINK_STEPS.map((item, index) => (
          <li
            key={item.id}
            className={`rounded-2xl border p-3 ${
              index < step
                ? "border-emerald-400/50 text-emerald-300"
                : index === step
                  ? "border-[#d4a017] text-[#f4efe4]"
                  : "border-white/10 text-[#c8c0b0]"
            }`}
          >
            {index < step ? "✓ " : ""}
            {item.title}
          </li>
        ))}
      </ol>

      <div className="h-3 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-[#d4a017] transition-[width] duration-100"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <p className="text-2xl font-semibold text-[#d4a017]">{status}</p>

      {error ? (
        <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-red-200">
          {error}
        </p>
      ) : null}
    </main>
  );
}

// Two-position slider for the typing mode; the thumb slides to the active one.
function EntrySlider({
  value,
  onChange,
}: {
  value: Entry;
  onChange: (value: Entry) => void;
}) {
  const index = ENTRIES.findIndex((option) => option.id === value);
  return (
    <div
      role="radiogroup"
      aria-label="Typing mode"
      className="relative grid grid-cols-2 rounded-full bg-[#0b1220]/10 p-1 text-sm font-semibold"
    >
      <span
        aria-hidden
        className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-[#0b1220] transition-transform duration-300 ease-out"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {ENTRIES.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={`relative rounded-full px-4 py-1.5 transition-colors ${
            value === option.id ? "text-[#f4efe4]" : "text-[#0b1220]/55"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Keyboard({
  hoveredKey,
  progress,
  firedKey,
  pending,
  suggestions,
  composing,
  calibrating,
  activeCalibKey,
  onKeyClick,
  setKeyNode,
}: {
  hoveredKey: string | null;
  progress: number;
  firedKey: string | null;
  pending: Cycle | null;
  // null hides the suggestion row (multi-tap or calibration).
  suggestions: KeyDef[] | null;
  composing: boolean;
  calibrating: boolean;
  activeCalibKey: string | null;
  onKeyClick: (key: KeyDef) => void;
  setKeyNode: (id: string, node: HTMLElement | null) => void;
}) {
  const button = (key: KeyDef, compact = false) => {
    const isActiveCalib = activeCalibKey === key.id;
    return (
      <KeyButton
        key={key.id}
        keyDef={key}
        compact={compact}
        hovered={hoveredKey === key.id}
        fired={firedKey === key.id}
        progress={progress}
        isActiveCalib={isActiveCalib}
        dimmed={calibrating && !isActiveCalib}
        cycling={pending?.keyId === key.id ? pending.index : null}
        onClick={() => onKeyClick(key)}
        setKeyNode={setKeyNode}
      />
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl min-h-0 flex-1 flex-col justify-end gap-4">
      {suggestions ? (
        <div className="flex h-[min(5rem,10vh)] shrink-0 justify-center gap-3">
          {Array.from({ length: SUGGESTION_COUNT }, (_, index) =>
            suggestions[index] ? (
              button(suggestions[index], true)
            ) : (
              <div
                key={`empty-${index}`}
                className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-[#c8c0b0]/60"
              >
                {index === 0 && composing ? "No match" : null}
              </div>
            ),
          )}
        </div>
      ) : null}
      {KEY_ROWS.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className="flex max-h-48 min-h-0 flex-1 justify-center gap-5"
        >
          {row.map((key) => button(key))}
        </div>
      ))}
    </div>
  );
}

function KeyButton({
  keyDef: key,
  compact,
  hovered,
  fired,
  progress,
  isActiveCalib,
  dimmed,
  cycling,
  onClick,
  setKeyNode,
}: {
  keyDef: KeyDef;
  compact: boolean;
  hovered: boolean;
  fired: boolean;
  progress: number;
  isActiveCalib: boolean;
  dimmed: boolean;
  cycling: number | null;
  onClick: () => void;
  setKeyNode: (id: string, node: HTMLElement | null) => void;
}) {
  return (
    <button
      type="button"
      ref={(node) => setKeyNode(key.id, node)}
      onClick={onClick}
      disabled={dimmed}
      className={`relative isolate h-full overflow-hidden rounded-2xl border font-semibold select-none ${
        compact ? "" : "min-h-16"
      }`}
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
      {compact ? (
        <span className="relative text-xl sm:text-2xl">{key.label}</span>
      ) : (
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
      )}
    </button>
  );
}

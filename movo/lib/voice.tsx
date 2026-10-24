"use client";

import { useRef, useState } from "react";
type Voice = { id: string; name: string };
type Store = { voices: Voice[]; selected: string };

const KEY = "elevenlabs-voices";
const LEGACY = "elevenlabs-voice-id";

const SHARED: Voice[] = [
  { id: "pNInz6obpgDQGcFmaJgB", name: "Male default" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Female default" },
  { id: "loK43gIA95yp5GIVlO9e", name: "Shrenik Voice" },
  { id: "7c2w1GgwcQy5wC2IMFEj", name: "Evelyn Voice" },
];

const SHARED_IDS = new Set(SHARED.map((voice) => voice.id));

function options(store: Store): Voice[] {
  return [
    ...SHARED,
    ...store.voices.filter((voice) => !SHARED_IDS.has(voice.id)),
  ];
}

function load(): Store {
  let store: Store = { voices: [], selected: SHARED[0].id };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) store = JSON.parse(raw) as Store;
    else {
      const legacy = localStorage.getItem(LEGACY);
      if (legacy) {
        store = {
          voices: [{ id: legacy, name: "Voice 1" }],
          selected: legacy,
        };
      }
    }
  } catch {
    /* ignore */
  }
  if (!store.selected) store.selected = SHARED[0].id;
  return store;
}

function save(store: Store) {
  localStorage.setItem(KEY, JSON.stringify(store));
  localStorage.setItem(LEGACY, store.selected);
}

let audio: HTMLAudioElement | null = null;

export async function speakCloned(text: string) {
  const selected = load().selected || SHARED[0].id;
  const trimmed = text.trim();
  if (!trimmed) return;
  const body = new FormData();
  body.set("action", "speak");
  body.set("voiceId", selected);
  body.set("text", trimmed);
  const res = await fetch("/api/voice", { method: "POST", body });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  audio?.pause();
  audio = new Audio(url);
  audio.play();
}

function labelFor(file: File, existing: Voice[]) {
  const base = file.name.replace(/\.[^.]+$/, "") || "Voice";
  const taken = new Set(existing.map((v) => v.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export type { Voice };

// Every voice the patient can pick from: the shared defaults, then uploads.
export function voiceOptions(): Voice[] {
  return options(load());
}

export function selectedVoiceId(): string {
  return load().selected || SHARED[0].id;
}

export function selectVoice(id: string) {
  save({ ...load(), selected: id });
}

// Caretaker-only: upload a recording (audio or .mp4) to clone a new voice.
// The new voice becomes the selected one.
export function AddVoiceButton({ onAdded }: { onAdded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const pick = (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    setStatus("");
    const name = labelFor(file, load().voices);
    const body = new FormData();
    body.set("file", file);
    body.set("name", name);
    void fetch("/api/voice", { method: "POST", body })
      .then(async (res) => {
        const data = (await res.json()) as { voiceId?: string; error?: string };
        if (!res.ok || !data.voiceId) throw new Error(data.error ?? "Clone failed");
        save({
          voices: [...load().voices, { id: data.voiceId, name }],
          selected: data.voiceId,
        });
        setStatus(`Added “${name}”`);
        onAdded();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Clone failed"),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <input
        ref={input}
        type="file"
        accept="audio/*,video/mp4,.mp4,.m4a"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          pick(file);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="rounded-full border border-[#0b1220]/15 px-5 py-2.5 text-sm disabled:opacity-50"
      >
        {busy ? "Cloning voice…" : "Add speaking voice"}
      </button>
      {status ? <p className="text-xs text-emerald-700">{status}</p> : null}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

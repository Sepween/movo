"use client";

import { useEffect, useRef, useState } from "react";

type Voice = { id: string; name: string };
type Store = { voices: Voice[]; selected: string };

const KEY = "elevenlabs-voices";
const LEGACY = "elevenlabs-voice-id";

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Store;
  } catch {
    /* ignore */
  }
  const legacy = localStorage.getItem(LEGACY);
  if (legacy) return { voices: [{ id: legacy, name: "Voice 1" }], selected: legacy };
  return { voices: [], selected: "" };
}

function save(store: Store) {
  localStorage.setItem(KEY, JSON.stringify(store));
  localStorage.setItem(LEGACY, store.selected);
}

let audio: HTMLAudioElement | null = null;

export async function speakCloned(text: string) {
  const { selected } = load();
  const trimmed = text.trim();
  if (!selected || !trimmed) return;
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

export function AddVoice() {
  const input = useRef<HTMLInputElement>(null);
  const [store, setStore] = useState<Store>({ voices: [], selected: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setStore(load()), []);

  const pick = (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    const name = labelFor(file, load().voices);
    const body = new FormData();
    body.set("file", file);
    body.set("name", name);
    void fetch("/api/voice", { method: "POST", body })
      .then(async (res) => {
        const data = (await res.json()) as { voiceId?: string; error?: string };
        if (!res.ok || !data.voiceId) throw new Error(data.error ?? "Clone failed");
        const next: Store = {
          voices: [...load().voices, { id: data.voiceId, name }],
          selected: data.voiceId,
        };
        save(next);
        setStore(next);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Clone failed"),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          pick(file);
        }}
      />
      {store.voices.length ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold tracking-wide text-[#d4a017]">
            Voice Added!
          </p>
          <select
            value={store.selected}
            onChange={(event) => {
              const next = { ...load(), selected: event.target.value };
              save(next);
              setStore(next);
            }}
            className="rounded-full border border-white/15 bg-[#151d2e] px-4 py-2 text-sm"
          >
            {store.voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className="rounded-full border border-white/15 px-4 py-2 text-sm disabled:opacity-50"
          >
            {busy ? "Cloning…" : "Add another"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="rounded-full border border-white/15 px-6 py-3 text-sm disabled:opacity-50"
        >
          {busy ? "Cloning voice…" : "Add voice"}
        </button>
      )}
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
    </div>
  );
}

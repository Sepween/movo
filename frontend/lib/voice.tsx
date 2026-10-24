"use client";

import { useEffect, useRef, useState } from "react";
import {
  addCustomWord,
  loadCustomWords,
  removeCustomWord,
} from "@/lib/t9";

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

export function AddVoice() {
  const input = useRef<HTMLInputElement>(null);
  const [store, setStore] = useState<Store>({
    voices: [],
    selected: SHARED[0].id,
  });
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
      <div className="flex flex-wrap items-center gap-3">
        {store.voices.length ? (
          <p className="text-sm font-semibold tracking-wide text-[#d4a017]">
            Voice Added!
          </p>
        ) : null}
        <select
          value={store.selected || SHARED[0].id}
          onChange={(event) => {
            const next = { ...load(), selected: event.target.value };
            save(next);
            setStore(next);
          }}
          className="rounded-full border border-white/15 bg-[#151d2e] px-4 py-2 text-sm"
        >
          {options(store).map((voice) => (
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
          {busy ? "Cloning…" : store.voices.length ? "Add another" : "Add voice"}
        </button>
      </div>
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
    </div>
  );
}

export function AddWords() {
  const [words, setWords] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  useEffect(() => setWords(loadCustomWords()), []);

  const submit = () => {
    const nextError = addCustomWord(value);
    if (nextError) {
      setError(nextError);
      return;
    }
    setValue("");
    setError("");
    setWords(loadCustomWords());
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
          placeholder="Name or custom word"
          className="rounded-full border border-white/15 bg-[#151d2e] px-4 py-2 text-sm"
        />
        <button
          type="button"
          onClick={submit}
          className="rounded-full border border-white/15 px-4 py-2 text-sm"
        >
          Add word
        </button>
      </div>
      {words.length ? (
        <div className="flex flex-wrap gap-2">
          {words.map((word) => (
            <button
              key={word}
              type="button"
              title="Remove"
              onClick={() => {
                removeCustomWord(word);
                setWords(loadCustomWords());
              }}
              className="rounded-full border border-white/15 px-3 py-1 text-sm"
            >
              {word} ×
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-200">{error}</p> : null}
    </div>
  );
}

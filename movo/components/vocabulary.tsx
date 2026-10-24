"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  addCustomWord,
  loadCustomWords,
  removeCustomWord,
  renameCustomWord,
} from "@/lib/t9";

// Caretaker page for the personalized vocabulary: view, add, respell and
// delete the patient's own words. Mouse and keyboard only.
// `closeButton` is the point-and-hold ✕ that returns to settings.
export function VocabularyPage({ closeButton }: { closeButton: ReactNode }) {
  const [words, setWords] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [error, setError] = useState("");

  useEffect(() => setWords(loadCustomWords()), []);

  const refresh = () => setWords(loadCustomWords());

  const add = () => {
    const problem = addCustomWord(draft);
    setError(problem);
    if (problem) return;
    setDraft("");
    refresh();
  };

  const saveEdit = () => {
    if (editing === null) return;
    const problem = renameCustomWord(editing, editValue);
    setError(problem);
    if (problem) return;
    setEditing(null);
    refresh();
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 overflow-y-auto px-6 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm tracking-[0.25em] text-[#1f5fd1] uppercase">
            Settings
          </p>
          <h1 className="mt-1 text-4xl font-semibold tracking-tight">
            Personalized vocabulary
          </h1>
          <p className="mt-2 text-[#5b6577]">
            Names and words added here are suggested first while typing.
          </p>
        </div>
        {closeButton}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
        className="flex gap-3"
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="New word or name"
          className="min-w-0 flex-1 rounded-full border border-[#0b1220]/15 bg-white px-5 py-2.5"
        />
        <button
          type="submit"
          className="rounded-full bg-[#1f5fd1] px-5 py-2.5 text-sm font-semibold text-white"
        >
          Add word
        </button>
      </form>

      {error ? (
        <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-red-700">
          {error}
        </p>
      ) : null}

      {words.length === 0 ? (
        <p className="text-[#5b6577]">No words yet.</p>
      ) : (
        <ul className="divide-y divide-[#0b1220]/10 rounded-2xl border border-[#0b1220]/10">
          {words.map((word) => (
            <li key={word} className="flex items-center gap-3 px-4 py-3">
              {editing === word ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveEdit();
                  }}
                  className="flex min-w-0 flex-1 gap-2"
                >
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(event) => setEditValue(event.target.value)}
                    className="min-w-0 flex-1 rounded-full border border-[#0b1220]/15 bg-white px-4 py-1.5"
                  />
                  <button
                    type="submit"
                    className="rounded-full bg-[#1f5fd1] px-4 py-1.5 text-sm font-semibold text-white"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setError("");
                    }}
                    className="rounded-full border border-[#0b1220]/15 px-4 py-1.5 text-sm"
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-lg">{word}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(word);
                      setEditValue(word);
                      setError("");
                    }}
                    className="rounded-full border border-[#0b1220]/15 px-4 py-1.5 text-sm"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeCustomWord(word);
                      refresh();
                    }}
                    className="rounded-full border border-red-400/30 px-4 py-1.5 text-sm text-red-700"
                  >
                    Delete
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

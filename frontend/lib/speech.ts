// Read-aloud hook for the keyboard's "Read" key. Called with everything in
// the output box (including the word currently being typed).
//
// Intentionally a no-op for now: text-to-speech is being implemented
// separately. Fill this in; nothing else needs to change.
export function speakText(text: string): void {
  void text;
}

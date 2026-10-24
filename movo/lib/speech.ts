// Read-aloud hook for the keyboard's "Read" key. Called with everything in
// the output box (including the word currently being typed).
import { speakCloned } from "@/lib/voice";

export function speakText(text: string): void {
  void speakCloned(text);
}

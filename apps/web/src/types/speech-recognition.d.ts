/**
 * Minimale ambient types voor de Web Speech API (SpeechRecognition).
 *
 * TypeScript's ingebouwde `lib.dom.d.ts` bevat deze API niet (het is geen
 * W3C-standaard, enkel breed geïmplementeerd) — vandaar deze eigen,
 * bewust beperkte declaratie i.p.v. een extra `@types/*`-package erbij te
 * halen voor een handvol velden. Enkel wat `useSpeechToText.ts` effectief
 * gebruikt is hier getypeerd.
 *
 * Ondersteuning: Chrome/Edge (desktop + Android) via `webkitSpeechRecognition`,
 * Safari (iOS 14.5+/macOS) via hetzelfde geprefixte object. Firefox
 * ondersteunt dit niet — `useSpeechToText` detecteert dat via
 * `isSupported` en de aanroepende component verbergt dan de microfoonknop.
 */

interface SpeechRecognitionEventResultAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionEventResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionEventResultAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionEventResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((this: SpeechRecognition, event: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, event: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, event: Event) => void) | null;
  onstart: ((this: SpeechRecognition, event: Event) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

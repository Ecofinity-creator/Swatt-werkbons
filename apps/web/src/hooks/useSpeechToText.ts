import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Spraak-naar-tekst voor omschrijvingsvelden (sectie 7 van de briefing:
 * "Ondersteun eventueel speech-to-text wanneer eenvoudig beschikbaar").
 * Gebouwd op de browser-eigen Web Speech API — geen server-transcriptie,
 * geen extra kosten/latency, werkt meteen op elke telefoon met Chrome/Safari.
 *
 * BELANGRIJKE BEPERKING: dit stuurt audio naar de spraakherkenningsdienst
 * van de browserleverancier (Google bij Chrome, Apple bij Safari) — dit
 * vereist dus internetverbinding, ook al staat de rest van de app straks
 * (zie offline-modus) beperkt offline te werken. Op een werf zonder bereik
 * valt dit terug op gewoon typen; de microfoonknop verbergt zichzelf niet
 * automatisch bij offline (dat weet de browser-API ons niet vooraf te
 * vertellen), maar `onerror` vangt de mislukte poging netjes op.
 *
 * Mobiele browsers (vooral Android Chrome) stoppen `SpeechRecognition`
 * vaak stil na een korte stilte, ook met `continuous: true`. Om dat voor de
 * gebruiker te laten aanvoelen als "gewoon doorluisteren tot ik zelf stop",
 * herstart deze hook de recognition automatisch zolang de gebruiker niet
 * expliciet op de knop heeft gedrukt om te stoppen (`desiredRef`).
 */

export interface UseSpeechToTextResult {
  /** False in browsers zonder Web Speech API (bv. Firefox) — knop dan verbergen. */
  isSupported: boolean;
  isListening: boolean;
  /** Tussentijds, nog niet definitief resultaat — enkel ter info tonen, niet opslaan. */
  interimText: string;
  /** Korte, gebruiksvriendelijke foutmelding — of null als er niets mis is. */
  error: string | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function describeError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'permission-denied':
      return 'Microfoontoegang geweigerd. Sta microfoongebruik toe in de browserinstellingen.';
    case 'no-speech':
      return 'Geen spraak gedetecteerd. Probeer opnieuw.';
    case 'network':
      return 'Geen internetverbinding voor spraakherkenning. Typ de omschrijving handmatig.';
    case 'audio-capture':
      return 'Geen microfoon gevonden op dit toestel.';
    case 'aborted':
      return '';
    default:
      return 'Spraakherkenning is mislukt. Typ de omschrijving handmatig.';
  }
}

/**
 * @param onFinalResult — wordt aangeroepen met elk definitief herkend tekstfragment
 *   (niet-cumulatief: de aanroeper voegt dit zelf samen met de bestaande tekst).
 * @param lang — BCP-47 taalcode, standaard Belgisch-Nederlands.
 */
export function useSpeechToText(
  onFinalResult: (text: string) => void,
  lang = 'nl-BE',
): UseSpeechToTextResult {
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const desiredRef = useRef(false);
  const onFinalResultRef = useRef(onFinalResult);
  onFinalResultRef.current = onFinalResult;

  const Ctor = getSpeechRecognitionConstructor();
  const isSupported = Ctor !== null;

  const stop = useCallback(() => {
    desiredRef.current = false;
    setIsListening(false);
    setInterimText('');
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!Ctor) return;
    setError(null);
    desiredRef.current = true;

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setIsListening(true);

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const alternative = result[0];
        const transcript = alternative?.transcript ?? '';
        if (result.isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }
      if (final.trim()) {
        onFinalResultRef.current(final.trim());
      }
      setInterimText(interim);
    };

    recognition.onerror = (event) => {
      const message = describeError(event.error);
      if (message) setError(message);
      if (event.error === 'not-allowed' || event.error === 'permission-denied') {
        desiredRef.current = false;
      }
    };

    recognition.onend = () => {
      setInterimText('');
      // Mobiele browsers stoppen vanzelf na stilte — herstart zolang de
      // gebruiker zelf niet op "stop" heeft gedrukt.
      if (desiredRef.current) {
        try {
          recognition.start();
        } catch {
          setIsListening(false);
        }
      } else {
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setIsListening(false);
    }
  }, [Ctor, lang]);

  // Bij unmount (bv. gebruiker navigeert weg tijdens het opnemen) altijd
  // netjes stoppen — anders blijft de microfoon van het toestel actief.
  useEffect(() => {
    return () => {
      desiredRef.current = false;
      recognitionRef.current?.stop();
    };
  }, []);

  return { isSupported, isListening, interimText, error, start, stop };
}

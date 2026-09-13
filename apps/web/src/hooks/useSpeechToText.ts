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
 *
 * BUGFIX (13/9/2026, klantvraag — "bij elk woord herbegint hij met de zin
 * te bouwen", zelfde bug als eerder bij de spraakgestuurde todo-lijstmaker):
 * de oorspronkelijke opzet gaf enkel het NIEUWE tekstfragment terug aan de
 * aanroeper, die dit zelf tegen de eigen React-state (`value`-prop) plakte.
 * Op mobiel komen "definitieve" resultaten soms woord per woord, sneller
 * dan React kan her-renderen — het volgende woord voert dan nog de VORIGE
 * (stale) `value` mee via de `onFinalResult`-closure, en het net toegevoegde
 * woord wordt overschreven i.p.v. aangevuld: het lijkt dan alsof de zin
 * telkens opnieuw begint. Los van React-timing dus.
 *
 * Fix: deze hook houdt de opbouw nu zelf bij in refs (`baseTextRef` = de
 * tekst die al in het veld stond bij het starten, `sessionTranscriptRef` =
 * alles wat deze dictee-sessie al definitief herkend is) — synchroon,
 * onafhankelijk van React se her-render-cyclus. `onFinalResult` krijgt
 * voortaan de VOLLEDIGE, kant-en-klare veldtekst (niet enkel het fragment);
 * de aanroeper hoeft niets meer zelf samen te voegen. Bewuste beperking:
 * manueel typen ZOLANG de microfoon actief luistert, wordt bij het
 * volgende definitieve woord overschreven (de mic "bezit" het veld tijdens
 * een sessie) — typen vóór/na het luisteren blijft gewoon werken.
 */

export interface UseSpeechToTextResult {
  /** False in browsers zonder Web Speech API (bv. Firefox) — knop dan verbergen. */
  isSupported: boolean;
  isListening: boolean;
  /** Tussentijds, nog niet definitief resultaat — enkel ter info tonen, niet opslaan. */
  interimText: string;
  /** Korte, gebruiksvriendelijke foutmelding — of null als er niets mis is. */
  error: string | null;
  /** `currentValue`: de tekst die al in het veld staat — wordt als basis gebruikt, zie toelichting hierboven. */
  start: (currentValue: string) => void;
  stop: () => void;
}

/** Plakt een nieuw tekstfragment na de bestaande tekst, met precies één spatie ertussen (ongeacht trailing whitespace in `current`). */
function appendText(current: string, addition: string): string {
  const trimmedCurrent = current.replace(/\s+$/, '');
  if (!trimmedCurrent) return addition;
  return `${trimmedCurrent} ${addition}`;
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
 * @param onFinalResult — wordt aangeroepen met de volledige, kant-en-klare
 *   veldtekst (basis + alles wat deze sessie al definitief herkend is) —
 *   zie de bugfix-toelichting hierboven. Gewoon rechtstreeks doorgeven aan
 *   `onChange` van het veld, geen samenvoeg-logica meer nodig bij de
 *   aanroeper.
 * @param lang — BCP-47 taalcode, standaard Belgisch-Nederlands.
 */
export function useSpeechToText(
  onFinalResult: (fullText: string) => void,
  lang = 'nl-BE',
): UseSpeechToTextResult {
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const desiredRef = useRef(false);
  const onFinalResultRef = useRef(onFinalResult);
  onFinalResultRef.current = onFinalResult;

  // Bron van waarheid voor de opbouw tijdens een dictee-sessie — bewust
  // refs (synchroon, niet aan React se render-cyclus gekoppeld), zie de
  // bugfix-toelichting hierboven. `baseTextRef` wordt enkel bij `start()`
  // gezet; `sessionTranscriptRef` groeit per definitief woord/zin en
  // overleeft de automatische her-starts hieronder (`onend`) — die zijn
  // enkel een technische heropstart van de browser-API, geen nieuwe
  // dictee-sessie voor de gebruiker.
  const baseTextRef = useRef('');
  const sessionTranscriptRef = useRef('');

  const Ctor = getSpeechRecognitionConstructor();
  const isSupported = Ctor !== null;

  const stop = useCallback(() => {
    desiredRef.current = false;
    setIsListening(false);
    setInterimText('');
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(
    (currentValue: string) => {
      if (!Ctor) return;
      setError(null);
      desiredRef.current = true;
      baseTextRef.current = currentValue;
      sessionTranscriptRef.current = '';

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
          sessionTranscriptRef.current = appendText(sessionTranscriptRef.current, final.trim());
          onFinalResultRef.current(appendText(baseTextRef.current, sessionTranscriptRef.current));
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
    },
    [Ctor, lang],
  );

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

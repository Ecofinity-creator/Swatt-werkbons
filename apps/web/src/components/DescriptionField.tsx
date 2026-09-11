import { useSpeechToText } from '../hooks/useSpeechToText';
import { MicrophoneIcon } from './icons';

/**
 * Herbruikbaar "Uitgevoerde werkzaamheden"-veld met optionele
 * spraak-naar-tekst (sectie 7 + backlog-extra 11/9/2026 — "precies waarom
 * techniekers een tijdregistratie-app haten" was het typen op de werf).
 *
 * Gewone <textarea> blijft altijd gewoon werken (typen kan nog steeds,
 * ook tijdens/na het gebruik van de microfoon). De microfoonknop verschijnt
 * enkel als de browser dit ondersteunt (`isSupported`) — progressive
 * enhancement, geen kapotte knop op niet-ondersteunde browsers.
 */
function appendSpeechText(current: string, addition: string): string {
  const trimmedCurrent = current.replace(/\s+$/, '');
  if (!trimmedCurrent) return addition;
  return `${trimmedCurrent} ${addition}`;
}

interface DescriptionFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}

export function DescriptionField({
  id,
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled = false,
}: DescriptionFieldProps) {
  const { isSupported, isListening, interimText, error, start, stop } = useSpeechToText((finalText) => {
    onChange(appendSpeechText(value, finalText));
  });

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm text-neutral-300">
          {label}
        </label>
        {isSupported && (
          <button
            type="button"
            onClick={() => (isListening ? stop() : start())}
            disabled={disabled}
            aria-pressed={isListening}
            aria-label={isListening ? 'Stop spraakherkenning' : 'Start spraakherkenning'}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-60 ${
              isListening
                ? 'animate-pulse border-red-700 bg-red-900 text-white'
                : 'border-neutral-700 bg-neutral-950 text-swatt-gold'
            }`}
          >
            <MicrophoneIcon className="h-5 w-5" />
          </button>
        )}
      </div>
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold disabled:opacity-60"
      />
      {isListening && (
        <p className="text-sm italic text-neutral-400">
          {interimText ? `Luistert: “${interimText}”` : 'Luistert... spreek de werkzaamheden in.'}
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

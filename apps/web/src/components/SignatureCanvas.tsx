import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/**
 * Phase 7 — handtekening-canvas voor de eindklant (sectie 10 van de
 * projectbrief). Pointer Events (niet losse mouse-/touch-handlers) voor
 * consistent gedrag op telefoon, tablet én desktop-muis in één implementatie.
 * `devicePixelRatio`-bewuste sizing zodat lijnen scherp blijven op een
 * high-DPI telefoonscherm.
 */
export interface SignatureCanvasHandle {
  clear: () => void;
  isEmpty: () => boolean;
  /** PNG als data-URL, of `null` wanneer nog niets getekend is. */
  toDataUrl: () => string | null;
}

export interface SignatureCanvasProps {
  /** Wordt aangeroepen na elke tekenbeweging, zodat de omringende pagina bv. een knop kan (de)activeren. */
  onChange?: () => void;
}

export const SignatureCanvas = forwardRef<SignatureCanvasHandle, SignatureCanvasProps>(function SignatureCanvas(
  { onChange },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const hasDrawnRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      const context = canvas.getContext('2d');
      if (context) {
        context.scale(ratio, ratio);
        context.lineWidth = 2.5;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.strokeStyle = '#111111';
      }
      // Een resize (bv. schermrotatie) wist het canvas onvermijdelijk — dat is
      // aanvaardbaar: de gebruiker tekent pas vlak vóór het bevestigen.
      hasDrawnRef.current = false;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useImperativeHandle(ref, () => ({
    clear: () => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (canvas && context) {
        const ratio = window.devicePixelRatio || 1;
        context.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
      }
      hasDrawnRef.current = false;
    },
    isEmpty: () => !hasDrawnRef.current,
    toDataUrl: () => (hasDrawnRef.current ? (canvasRef.current?.toDataURL('image/png') ?? null) : null),
  }));

  function pointFromEvent(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    isDrawingRef.current = true;
    lastPointRef.current = pointFromEvent(event);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    const from = lastPointRef.current;
    const to = pointFromEvent(event);
    if (!context || !from) return;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    lastPointRef.current = to;
    hasDrawnRef.current = true;
    onChange?.();
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    isDrawingRef.current = false;
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className="h-48 w-full touch-none rounded-lg bg-white"
      aria-label="Handtekening — teken hier met je vinger of stylus"
    />
  );
});

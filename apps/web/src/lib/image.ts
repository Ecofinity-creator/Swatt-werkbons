/**
 * Phase 6 — foto's (sectie 9 van de projectbrief: "Maak foto's automatisch
 * kleiner voordat ze geüpload worden om mobiele data en opslag te beperken,
 * zonder de bruikbaarheid te verliezen"). Comprimeert/verkleint een foto
 * VOLLEDIG in de browser (via `createImageBitmap` + `<canvas>`) vóór ze
 * ooit naar de backend gaat — bewust geen server-side beeldbewerking
 * (bv. `sharp`): dat vermijdt een native-binary-dependency en verkleint de
 * upload al op het punt waar mobiele data het duurst is.
 *
 * Twee varianten per foto: een "optimized" versie (bruikbaar in de PDF/
 * detailweergave) en een kleine "thumbnail" (voor het overzichtsraster).
 */

export interface CompressedImage {
  optimizedDataBase64: string;
  optimizedMimeType: 'image/jpeg';
  thumbnailDataBase64: string;
  thumbnailMimeType: 'image/jpeg';
}

const OPTIMIZED_MAX_DIMENSION = 1600;
const OPTIMIZED_QUALITY = 0.8;
const THUMBNAIL_MAX_DIMENSION = 320;
const THUMBNAIL_QUALITY = 0.7;

export async function compressImageFile(file: File): Promise<CompressedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const optimizedDataBase64 = await drawAndEncode(bitmap, OPTIMIZED_MAX_DIMENSION, OPTIMIZED_QUALITY);
    const thumbnailDataBase64 = await drawAndEncode(bitmap, THUMBNAIL_MAX_DIMENSION, THUMBNAIL_QUALITY);
    return {
      optimizedDataBase64,
      optimizedMimeType: 'image/jpeg',
      thumbnailDataBase64,
      thumbnailMimeType: 'image/jpeg',
    };
  } finally {
    bitmap.close();
  }
}

async function drawAndEncode(bitmap: ImageBitmap, maxDimension: number, quality: number): Promise<string> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Kon de foto niet verwerken op dit toestel (canvas niet beschikbaar).');
  }
  context.drawImage(bitmap, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) {
    throw new Error('Kon de foto niet comprimeren.');
  }
  return blobToBase64(blob);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Onverwacht resultaat bij het lezen van de foto.'));
        return;
      }
      // dataURL heeft de vorm "data:image/jpeg;base64,AAAA..." — enkel het stuk na de komma versturen.
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Kon de foto niet lezen.'));
    reader.readAsDataURL(blob);
  });
}

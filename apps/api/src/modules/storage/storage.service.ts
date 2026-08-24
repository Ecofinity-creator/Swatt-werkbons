import type { PrismaClient } from '@prisma/client';

/** Eén opgehaald bestand: ruwe bytes + het bewaarde MIME-type. */
export interface StoredFileData {
  mimeType: string;
  data: Buffer;
}

/**
 * Abstractielaag voor binaire opslag (foto's, handtekeningafbeeldingen — Phase
 * 6/7). Bewust een klein, generiek interface (save/read/delete) i.p.v.
 * rechtstreeks Prisma-calls in de aanroepende services: sectie 2 van de
 * projectbrief vraagt expliciet om zo'n abstraction/service layer, zodat de
 * implementatie later vervangen kan worden (bv. door een echte S3-compatibele
 * opslag) zonder de aanroepende code te wijzigen.
 *
 * De `key` die `save()` teruggeeft is voor de aanroeper altijd een
 * ondoorzichtige string — nooit interpreteren of parsen. Vandaag is dat een
 * `StoredFile.id` (UUID); bij een toekomstige S3-implementatie zou dat een
 * object-key zijn. Precies daarom hebben WorkOrderPhoto/WorkOrderSignature
 * ook bewust GEEN Prisma-foreign-key naar StoredFile (zie schema.prisma).
 */
export interface StorageService {
  /** Slaat `data` op en geeft een ondoorzichtige key terug om later mee op te halen/te verwijderen. */
  save(data: Buffer, mimeType: string): Promise<string>;
  /** Gooit een fout wanneer de key niet (meer) bestaat. */
  read(key: string): Promise<StoredFileData>;
  /** Idempotent: verwijderen van een reeds-verwijderde of onbestaande key faalt niet. */
  delete(key: string): Promise<void>;
}

export class StoredFileNotFoundError extends Error {
  constructor(key: string) {
    super(`Opgeslagen bestand met key "${key}" bestaat niet (meer).`);
    this.name = 'StoredFileNotFoundError';
  }
}

/**
 * Snel-te-starten implementatie op vraag van Steven ("opslag in de
 * database") — bewaart bytes als bytea in Postgres via het generieke
 * `StoredFile`-model. Geen enkele aanroepende code (WorkOrderPhotoService,
 * WorkOrderSignatureService, de routes) weet dat dit vandaag de database is;
 * die zien enkel deze `StorageService`-interface.
 */
export class DatabaseStorageService implements StorageService {
  constructor(private readonly prisma: PrismaClient) {}

  async save(data: Buffer, mimeType: string): Promise<string> {
    const stored = await this.prisma.storedFile.create({
      data: { mimeType, data, sizeBytes: data.byteLength },
    });
    return stored.id;
  }

  async read(key: string): Promise<StoredFileData> {
    const stored = await this.prisma.storedFile.findUnique({ where: { id: key } });
    if (!stored) {
      throw new StoredFileNotFoundError(key);
    }
    return { mimeType: stored.mimeType, data: Buffer.from(stored.data) };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.prisma.storedFile.delete({ where: { id: key } });
    } catch {
      // Idempotent: een reeds-verwijderde of onbestaande key is geen fout —
      // het gewenste eindresultaat ("deze key bestaat niet meer") is al waar.
    }
  }
}

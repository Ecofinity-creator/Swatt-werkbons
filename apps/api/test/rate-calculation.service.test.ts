import { describe, expect, it } from 'vitest';
import { allocateHoursAcrossEntries, computeRatePercent, splitEffectiveHours } from '../src/modules/rates/rate-calculation.service';

const EMPLOYEE = { overtimeRatePercent: 150, shiftWorkRatePercent: 120, nightWorkRatePercent: 150 };

describe('splitEffectiveHours()', () => {
  it('DAILY: exact op de grens (8u) levert geen overuren op', () => {
    expect(splitEffectiveHours(8, { overtimeThresholdType: 'DAILY', overtimeWeeklyThresholdHours: null })).toEqual({
      normalHours: 8,
      overtimeHours: 0,
    });
  });

  it('DAILY: net erover (8,5u) levert 0,5u overuren op', () => {
    expect(splitEffectiveHours(8.5, { overtimeThresholdType: 'DAILY', overtimeWeeklyThresholdHours: null })).toEqual({
      normalHours: 8,
      overtimeHours: 0.5,
    });
  });

  it('DAILY: ruim eronder (6u) levert enkel normale uren op', () => {
    expect(splitEffectiveHours(6, { overtimeThresholdType: 'DAILY', overtimeWeeklyThresholdHours: null })).toEqual({
      normalHours: 6,
      overtimeHours: 0,
    });
  });

  it('WEEKLY: gebruikt de ingestelde drempel (bv. 39u), niet de vaste 8u', () => {
    expect(splitEffectiveHours(42, { overtimeThresholdType: 'WEEKLY', overtimeWeeklyThresholdHours: 39 })).toEqual({
      normalHours: 39,
      overtimeHours: 3,
    });
  });

  it('WEEKLY: valt terug op 39u wanneer geen drempel ingevuld is (defensief — zou normaal altijd ingevuld zijn)', () => {
    expect(splitEffectiveHours(40, { overtimeThresholdType: 'WEEKLY', overtimeWeeklyThresholdHours: null })).toEqual({
      normalHours: 39,
      overtimeHours: 1,
    });
  });

  it('WEEKLY: een andere CAO-drempel (40u) werkt even goed', () => {
    expect(splitEffectiveHours(42, { overtimeThresholdType: 'WEEKLY', overtimeWeeklyThresholdHours: 40 })).toEqual({
      normalHours: 40,
      overtimeHours: 2,
    });
  });
});

describe('allocateHoursAcrossEntries() — Phase 12, deel E', () => {
  const DAILY = { overtimeThresholdType: 'DAILY' as const, overtimeWeeklyThresholdHours: null };

  it('twee registraties op één dag, samen onder de drempel: allebei volledig normaal', () => {
    const result = allocateHoursAcrossEntries(
      [
        { id: 'a', hours: 3 },
        { id: 'b', hours: 4 },
      ],
      DAILY,
    );
    expect(result.get('a')).toEqual({ normalHours: 3, overtimeHours: 0 });
    expect(result.get('b')).toEqual({ normalHours: 4, overtimeHours: 0 });
  });

  it('de tweede registratie duwt de dag over de drempel: enkel het teveel is overuren', () => {
    const result = allocateHoursAcrossEntries(
      [
        { id: 'a', hours: 6 },
        { id: 'b', hours: 3 }, // 6+3=9 > 8 → 2u normaal, 1u overuren op deze registratie
      ],
      DAILY,
    );
    expect(result.get('a')).toEqual({ normalHours: 6, overtimeHours: 0 });
    expect(result.get('b')).toEqual({ normalHours: 2, overtimeHours: 1 });
  });

  it('een registratie die al na de drempel begint: volledig overuren', () => {
    const result = allocateHoursAcrossEntries(
      [
        { id: 'a', hours: 8 },
        { id: 'b', hours: 2 },
      ],
      DAILY,
    );
    expect(result.get('a')).toEqual({ normalHours: 8, overtimeHours: 0 });
    expect(result.get('b')).toEqual({ normalHours: 0, overtimeHours: 2 });
  });

  it('werkt ook met een WEEKLY-drempel over meerdere (dag-)registraties', () => {
    const result = allocateHoursAcrossEntries(
      [
        { id: 'ma', hours: 14 },
        { id: 'di', hours: 14 },
        { id: 'wo', hours: 14 },
      ],
      { overtimeThresholdType: 'WEEKLY', overtimeWeeklyThresholdHours: 39 },
    );
    expect(result.get('ma')).toEqual({ normalHours: 14, overtimeHours: 0 });
    expect(result.get('di')).toEqual({ normalHours: 14, overtimeHours: 0 });
    expect(result.get('wo')).toEqual({ normalHours: 11, overtimeHours: 3 }); // 14+14=28, +14=42 → 39-28=11 normaal, 3 over
  });
});

describe('computeRatePercent()', () => {
  it('geen enkele toeslag van toepassing: 100% op alles', () => {
    expect(computeRatePercent(EMPLOYEE, { overtimeApplies: false, premiumType: 'NONE' })).toEqual({
      normalPercent: 100,
      overtimePercent: 100,
    });
  });

  it('enkel overuren van toepassing: normale uren 100%, overuren 150%', () => {
    expect(computeRatePercent(EMPLOYEE, { overtimeApplies: true, premiumType: 'NONE' })).toEqual({
      normalPercent: 100,
      overtimePercent: 150,
    });
  });

  it('enkel ploegenwerk: geldt op zowel normale uren als overuren (er zijn hier geen overuren)', () => {
    expect(computeRatePercent(EMPLOYEE, { overtimeApplies: false, premiumType: 'SHIFT_WORK' })).toEqual({
      normalPercent: 120,
      overtimePercent: 120,
    });
  });

  it('overuren + nachtwerk combineren: opgeteld boven 100%, niet vermenigvuldigd (100+50+50=200%)', () => {
    expect(computeRatePercent(EMPLOYEE, { overtimeApplies: true, premiumType: 'NIGHT_WORK' })).toEqual({
      normalPercent: 150,
      overtimePercent: 200,
    });
  });

  it('overuren + ploegenwerk combineren (100+50+20=170%)', () => {
    expect(computeRatePercent(EMPLOYEE, { overtimeApplies: true, premiumType: 'SHIFT_WORK' })).toEqual({
      normalPercent: 120,
      overtimePercent: 170,
    });
  });

  it('respecteert de individuele percentages van de medewerker, niet enkel de defaults', () => {
    const customEmployee = { overtimeRatePercent: 200, shiftWorkRatePercent: 110, nightWorkRatePercent: 175 };
    expect(computeRatePercent(customEmployee, { overtimeApplies: true, premiumType: 'NIGHT_WORK' })).toEqual({
      normalPercent: 175,
      overtimePercent: 275,
    });
  });
});

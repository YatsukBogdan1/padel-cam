// Pure logic: the booking grid, the free-period rule, and what counts as a
// download. No bindings needed, but these run in workerd too, so Intl's timezone
// data is the runtime's own -- the same one that serves players.

import { describe, expect, it } from 'vitest';
import { isWholeFileRequest } from '../src/handlers';
import { endTimeOptions, formatLocalTime, isValidTimezone } from '../src/matches';
import { isFree } from '../src/types';
import { fromAcceptLanguage, STRINGS } from '../src/i18n';

const lisbon30 = { timezone: 'Europe/Lisbon', slot_minutes: 30 };
const labels = (now: number, venue = lisbon30) => endTimeOptions(venue, now).map((o) => o.label);

describe('endTimeOptions', () => {
  it('offers the booking grid in local time, not UTC', () => {
    // 18:10Z in July is 19:10 in Lisbon (WEST, UTC+1).
    expect(labels(Date.parse('2026-07-15T18:10:00Z'))).toEqual([
      '19:30', '20:00', '20:30', '21:00', '21:30',
    ]);
  });

  it('lets a group that started late still pick the end of its booking', () => {
    // 20 minutes before a slot boundary: that boundary must be offered, or a
    // late group is forced to record into the next booking.
    expect(labels(Date.parse('2026-07-15T18:10:00Z'))[0]).toBe('19:30');
  });

  it('never offers an end time closer than 15 minutes or further than 2.5 hours', () => {
    const now = Date.parse('2026-07-15T18:20:30Z'); // 19:20:30 local
    const options = endTimeOptions(lisbon30, now);
    expect(options.map((o) => o.label)).toEqual(['20:00', '20:30', '21:00', '21:30']);
    for (const o of options) {
      expect(o.at - now).toBeGreaterThanOrEqual(15 * 60_000);
      expect(o.at - now).toBeLessThanOrEqual(150 * 60_000);
    }
  });

  it('includes a boundary exactly 15 minutes away', () => {
    expect(labels(Date.parse('2026-07-15T18:15:00Z'))[0]).toBe('19:30');
  });

  it('respects the venue slot length', () => {
    const hourly = { timezone: 'Europe/Lisbon', slot_minutes: 60 };
    expect(labels(Date.parse('2026-07-15T18:10:00Z'), hourly)).toEqual(['20:00', '21:00']);
  });

  it('aligns to local time in a half-hour timezone', () => {
    // 12:40Z is 18:10 in Kolkata (UTC+5:30). A grid computed from UTC would
    // offer 18:30/19:30 there -- wrong by half an hour.
    const kolkata = { timezone: 'Asia/Kolkata', slot_minutes: 60 };
    const options = endTimeOptions(kolkata, Date.parse('2026-07-15T12:40:00Z'));
    expect(options.map((o) => o.label)).toEqual(['19:00', '20:00']);
    expect(options[0]!.at).toBe(Date.parse('2026-07-15T13:30:00Z'));
  });

  it('stays on the grid across the autumn clock change', () => {
    // Lisbon falls back at 02:00 WEST on 2026-10-25 (01:00Z). Labels may repeat,
    // but every one must still sit on a slot boundary, in strictly later time.
    const options = endTimeOptions(lisbon30, Date.parse('2026-10-25T00:10:00Z'));
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o.label).toMatch(/:(00|30)$/);
    for (let i = 1; i < options.length; i++) {
      expect(options[i]!.at).toBeGreaterThan(options[i - 1]!.at);
    }
  });

  it('returns times on whole minutes', () => {
    for (const o of endTimeOptions(lisbon30, Date.parse('2026-07-15T18:10:42.123Z'))) {
      expect(o.at % 60_000).toBe(0);
    }
  });
});

describe('formatLocalTime / isValidTimezone', () => {
  it('formats in the venue zone with a 24-hour clock', () => {
    expect(formatLocalTime(Date.parse('2026-01-15T23:05:00Z'), 'Europe/Lisbon')).toBe('23:05');
    expect(formatLocalTime(Date.parse('2026-07-15T23:05:00Z'), 'Europe/Lisbon')).toBe('00:05');
  });

  it('accepts IANA zones and rejects anything else', () => {
    expect(isValidTimezone('Europe/Lisbon')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('isFree', () => {
  const rec = (started_at: number, purchased = 0) => ({ started_at, purchased });

  it('is free when no free period was ever set', () => {
    expect(isFree(rec(5), { free_until: null })).toBe(true);
    expect(isFree(rec(5), null)).toBe(true);
  });

  it('judges by when the match started, so moving the date never takes a video back', () => {
    expect(isFree(rec(999), { free_until: 1000 })).toBe(true);
    expect(isFree(rec(1000), { free_until: 1000 })).toBe(false);
    expect(isFree(rec(1001), { free_until: 1000 })).toBe(false);
  });

  it('always lets a purchased recording through', () => {
    expect(isFree(rec(5000, 1), { free_until: 1000 })).toBe(true);
  });
});

describe('isWholeFileRequest', () => {
  const req = (range?: string) =>
    new Request('http://x/', range ? { headers: { range } } : undefined);

  it('counts a plain request and one starting at byte 0', () => {
    expect(isWholeFileRequest(req())).toBe(true);
    expect(isWholeFileRequest(req('bytes=0-'))).toBe(true);
    expect(isWholeFileRequest(req('bytes=0-1023'))).toBe(true);
  });

  it('does not count seeking or a resumed download', () => {
    expect(isWholeFileRequest(req('bytes=1024-2047'))).toBe(false);
    expect(isWholeFileRequest(req('bytes=5000-'))).toBe(false);
  });
});

describe('fromAcceptLanguage (player pages)', () => {
  it('is pt-PT unless English is ranked above any Portuguese', () => {
    expect(fromAcceptLanguage(null)).toBe('pt');
    expect(fromAcceptLanguage('')).toBe('pt');
    expect(fromAcceptLanguage('pt-PT,pt;q=0.9,en;q=0.8')).toBe('pt');
    expect(fromAcceptLanguage('pt-BR,en;q=0.9')).toBe('pt');
    expect(fromAcceptLanguage('en-GB,en;q=0.9,pt;q=0.8')).toBe('en');
    expect(fromAcceptLanguage('en;q=0.4,pt;q=0.6')).toBe('pt');
    // Only other languages: Portugal first, unless English is listed at all.
    expect(fromAcceptLanguage('es-ES,fr;q=0.8')).toBe('pt');
    expect(fromAcceptLanguage('es-ES,en;q=0.5')).toBe('en');
    // q=0 means "not this one".
    expect(fromAcceptLanguage('en;q=0,pt;q=0.1')).toBe('pt');
    expect(fromAcceptLanguage('*')).toBe('pt');
  });

  it('has every string in both languages, and none of them empty', () => {
    const keys = Object.keys(STRINGS.pt).sort();
    expect(Object.keys(STRINGS.en).sort()).toEqual(keys);
    for (const lang of ['pt', 'en'] as const) {
      for (const [k, v] of Object.entries(STRINGS[lang])) {
        const text = typeof v === 'function' ? (v as (a: string, b: number) => string)('X', 1) : v;
        expect(text, `${lang}.${k}`).not.toBe('');
      }
    }
  });
});

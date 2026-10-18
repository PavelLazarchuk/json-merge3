import { describe, expect, it } from 'vitest';
import { jsonEqual } from './json';
import { merge3 } from './merge';
import type { Conflict, Json } from './types';

function random(seed: number) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const int = (max: number) => Math.floor(next() * max);
    const pick = <T>(items: readonly T[]) => items[int(items.length)] as T;
    return { next, int, pick };
}

type Random = ReturnType<typeof random>;
type Doc = Record<string, Json>;
const KEYS = ['a', 'b', 'c', 'd', 'e', 'f'];

function value(rng: Random, depth: number): Json {
    switch (rng.int(depth > 2 ? 4 : 6)) {
        case 0:
            return null;
        case 1:
            return rng.int(5);
        case 2:
            return rng.pick(['x', 'y', 'z']);
        case 3:
            return rng.next() < 0.5;
        case 4:
            return Array.from({ length: rng.int(3) }, () => rng.int(3));
        default:
            return object(rng, depth + 1);
    }
}

function object(rng: Random, depth: number): Doc {
    const doc: Doc = {};
    for (const key of KEYS) if (rng.next() < 0.5) doc[key] = value(rng, depth);
    return doc;
}

function edit(rng: Random, doc: Doc, depth = 0): Doc {
    const key = rng.pick(KEYS);
    const copy = { ...doc };
    const current = copy[key];
    const roll = rng.next();
    if (current && typeof current === 'object' && !Array.isArray(current) && roll < 0.5) {
        copy[key] = edit(rng, current as Doc, depth + 1);
    } else if (roll < 0.75) {
        copy[key] = value(rng, depth + 1);
    } else {
        delete copy[key];
    }
    return copy;
}

const mirror = (conflict: Conflict): Conflict => {
    const kind =
        conflict.kind === 'delete-edit'
            ? 'edit-delete'
            : conflict.kind === 'edit-delete'
              ? 'delete-edit'
              : conflict.kind;
    const { base, ours, theirs, path } = conflict;
    return {
        kind,
        path,
        ...(base !== undefined && { base }),
        ...(theirs !== undefined && { ours: theirs }),
        ...(ours !== undefined && { theirs: ours }),
    };
};

const CASES = 400;

describe('merge laws on random documents', () => {
    it('merging with an unchanged side returns the other side', () => {
        const rng = random(1);
        for (let run = 0; run < CASES; run += 1) {
            const base = object(rng, 0);
            const changed = edit(rng, edit(rng, base));
            expect(merge3(base, base, changed)).toMatchObject({ ok: true, value: changed });
            expect(merge3(base, changed, base)).toMatchObject({ ok: true, value: changed });
            expect(merge3(base, changed, changed)).toMatchObject({ ok: true, value: changed });
        }
    });

    it('is symmetric: swapping sides mirrors conflicts and the preferred value', () => {
        const rng = random(2);
        for (let run = 0; run < CASES; run += 1) {
            const base = object(rng, 0);
            const ours = edit(rng, edit(rng, base));
            const theirs = edit(rng, edit(rng, base));
            const forward = merge3(base, ours, theirs);
            const backward = merge3(base, theirs, ours, { prefer: 'theirs' });
            expect(jsonEqual(forward.value, backward.value)).toBe(true);
            expect(backward.conflicts).toEqual(forward.conflicts.map(mirror));
        }
    });

    it('keeps every change when the two edits touch different top-level members', () => {
        const rng = random(3);
        for (let run = 0; run < CASES; run += 1) {
            const base = object(rng, 0);
            const ours = { ...base };
            const theirs = { ...base };
            for (const key of KEYS) {
                const target = KEYS.indexOf(key) % 2 === 0 ? ours : theirs;
                if (rng.next() < 0.4) target[key] = value(rng, 1);
                else if (rng.next() < 0.2) delete target[key];
            }
            const { ok, value: merged } = merge3(base, ours, theirs);
            expect(ok).toBe(true);
            for (const key of KEYS) {
                const source = KEYS.indexOf(key) % 2 === 0 ? ours : theirs;
                expect(jsonEqual(merged[key], source[key])).toBe(true);
            }
        }
    });

    it('applying the result again changes nothing', () => {
        const rng = random(4);
        for (let run = 0; run < CASES; run += 1) {
            const base = object(rng, 0);
            const ours = edit(rng, base);
            const theirs = edit(rng, base);
            const once = merge3(base, ours, theirs, {
                prefer: rng.next() < 0.5 ? 'ours' : 'theirs',
            }).value;
            expect(merge3(base, once, once).value).toBe(once);
            expect(merge3(ours, once, once).value).toBe(once);
        }
    });

    it('never reports a conflict when the result could take both sides', () => {
        const rng = random(5);
        for (let run = 0; run < CASES; run += 1) {
            const base = object(rng, 0);
            const ours = edit(rng, base);
            const theirs = edit(rng, base);
            for (const conflict of merge3(base, ours, theirs).conflicts) {
                expect(jsonEqual(conflict.ours, conflict.theirs)).toBe(false);
                expect(jsonEqual(conflict.base, conflict.ours)).toBe(false);
                expect(jsonEqual(conflict.base, conflict.theirs)).toBe(false);
            }
        }
    });

    it('set arrays always contain exactly the surviving and added elements', () => {
        const rng = random(6);
        for (let run = 0; run < CASES; run += 1) {
            const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
            const pickSet = () => pool.filter(() => rng.next() < 0.5);
            const base = pickSet();
            const ours = pickSet();
            const theirs = pickSet();
            const merged = merge3(
                { s: base },
                { s: ours },
                { s: theirs },
                { arrays: { '/s': 'set' } }
            ).value.s;
            const expected = pool.filter(item => {
                const inBase = base.includes(item);
                const keptByOurs = ours.includes(item);
                const keptByTheirs = theirs.includes(item);
                return inBase ? keptByOurs && keptByTheirs : keptByOurs || keptByTheirs;
            });
            expect([...merged].sort()).toEqual(expected);
        }
    });
});

import { describe, expect, it } from 'vitest';
import {
    comparePaths,
    compilePatterns,
    fromPointer,
    lookup,
    lookupInherited,
    toPointer,
} from './path';

describe('JSON Pointer', () => {
    it('round-trips segments, escaping ~ and / as RFC 6901 requires', () => {
        const segments = ['a/b', '~1', '', 'plain', '~/~'];
        expect(toPointer(segments)).toBe('/a~1b/~01//plain/~0~1~0');
        expect(fromPointer(toPointer(segments))).toEqual(segments);
        expect(toPointer([])).toBe('');
        expect(fromPointer('')).toEqual([]);
        expect(fromPointer('/')).toEqual(['']);
    });
});

describe('comparePaths', () => {
    it('orders segment by segment, shorter prefixes first', () => {
        expect(comparePaths(['a', 'b'], ['a!b'])).toBeLessThan(0);
        expect(comparePaths(['a'], ['a', 'b'])).toBeLessThan(0);
        expect(comparePaths(['b'], ['a', 'z'])).toBeGreaterThan(0);
        expect(comparePaths(['x'], ['x'])).toBe(0);
    });

    it('compares UTF-16 code units, so astral characters sort by their surrogates', () => {
        expect(comparePaths(['\u{1F600}'], ['￿'])).toBeLessThan(0);
    });
});

describe('patterns', () => {
    const patterns = compilePatterns(
        { '/a': 1, '/a/*': 2, '/**/c': 3, '/x/**': 4, '': 5 },
        rule => rule as number
    );

    it('matches literal, single and multi-segment wildcards', () => {
        expect(lookup(patterns, ['a'])).toBe(1);
        expect(lookup(patterns, ['a', 'b'])).toBe(2);
        expect(lookup(patterns, ['q', 'r', 'c'])).toBe(3);
        expect(lookup(patterns, ['c'])).toBe(3);
        expect(lookup(patterns, ['x'])).toBe(4);
        expect(lookup(patterns, ['x', 'y', 'z'])).toBe(4);
        expect(lookup(patterns, [])).toBe(5);
        expect(lookup(patterns, ['b'])).toBeUndefined();
        expect(lookup(patterns, ['a', 'b', 'd'])).toBeUndefined();
    });

    it('matches several ** in time linear in the path, not exponential', () => {
        const globs = compilePatterns({ '/**/a/**/a/**/a/**/b': 1 }, rule => rule as number);
        const deep = Array.from({ length: 500 }, () => 'a');
        const started = performance.now();
        expect(lookup(globs, deep)).toBeUndefined();
        expect(lookup(globs, [...deep, 'b'])).toBe(1);
        expect(lookup(globs, ['a', 'x', 'a', 'a', 'y', 'b'])).toBe(1);
        expect(lookup(globs, ['a', 'a', 'b'])).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(200);
    });

    it('prefers the most specific pattern', () => {
        expect(lookup(patterns, ['a', 'c'])).toBe(2);
        expect(lookup(patterns, ['x', 'c'])).toBe(3);
    });

    it('inherits the rule of the deepest matching ancestor', () => {
        expect(lookupInherited(patterns, ['a', 'b', 'd', 'e'])).toBe(2);
        expect(lookupInherited(patterns, ['zzz'])).toBe(5);
        expect(lookupInherited([], ['a'])).toBeUndefined();
        expect(
            lookupInherited(
                compilePatterns({ '/k': 1 }, rule => rule as number),
                ['j']
            )
        ).toBeUndefined();
    });

    it('rejects patterns that are not JSON Pointers', () => {
        expect(() => compilePatterns({ items: 1 }, rule => rule)).toThrow(
            `options: pattern "items" is not a JSON Pointer — expected '' or a string starting with '/'`
        );
    });

    it('unescapes pattern segments', () => {
        const escaped = compilePatterns({ '/a~1b': 1 }, rule => rule as number);
        expect(lookup(escaped, ['a/b'])).toBe(1);
    });
});

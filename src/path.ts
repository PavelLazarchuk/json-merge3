export function toPointer(segments: readonly string[]): string {
    return segments.map(segment => `/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

export function fromPointer(pointer: string): string[] {
    if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) {
        throw new TypeError(
            `${JSON.stringify(pointer)} is not a JSON Pointer — expected '' or a string starting with '/'`
        );
    }
    if (/~(?![01])/.test(pointer)) {
        throw new TypeError(
            `${JSON.stringify(pointer)} is not a JSON Pointer — '~' must be escaped as '~0'`
        );
    }
    return pointer === ''
        ? []
        : pointer
              .slice(1)
              .split('/')
              .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function comparePaths(a: readonly string[], b: readonly string[]): number {
    const shared = Math.min(a.length, b.length);
    for (let index = 0; index < shared; index += 1) {
        const left = a[index] as string;
        const right = b[index] as string;
        if (left !== right) return left < right ? -1 : 1;
    }
    return a.length - b.length;
}

export interface Pattern<T> {
    readonly segments: readonly string[];
    readonly rule: T;
    readonly literals: number;
    readonly globs: number;
    readonly order: number;
}

export function compilePatterns<T>(
    record: Readonly<Record<string, T>> | undefined,
    check: (rule: unknown, pattern: string) => T
): Pattern<T>[] {
    if (record === undefined) return [];
    return Object.keys(record).map((source, order) => {
        let segments: string[];
        try {
            segments = fromPointer(source);
        } catch (error) {
            throw new TypeError(`options: pattern ${(error as Error).message}`, { cause: error });
        }
        return {
            segments,
            rule: check(record[source], source),
            literals: segments.filter(segment => segment !== '*' && segment !== '**').length,
            globs: segments.filter(segment => segment === '**').length,
            order,
        };
    });
}

function matches(pattern: Pattern<unknown>, path: readonly string[]): boolean {
    const { segments } = pattern;
    let patternIndex = 0;
    let pathIndex = 0;
    let globIndex = -1;
    let globPathIndex = 0;
    while (pathIndex < path.length) {
        const segment = segments[patternIndex];
        if (segment === '**') {
            globIndex = patternIndex;
            globPathIndex = pathIndex;
            patternIndex += 1;
        } else if (segment !== undefined && (segment === '*' || segment === path[pathIndex])) {
            patternIndex += 1;
            pathIndex += 1;
        } else if (globIndex !== -1) {
            globPathIndex += 1;
            patternIndex = globIndex + 1;
            pathIndex = globPathIndex;
        } else {
            return false;
        }
    }
    while (segments[patternIndex] === '**') patternIndex += 1;
    return patternIndex === segments.length;
}

function moreSpecific(
    candidate: Pattern<unknown>,
    depth: number,
    best: Pattern<unknown> | undefined,
    bestDepth: number
): boolean {
    if (!best) return true;
    if (candidate.literals !== best.literals) return candidate.literals > best.literals;
    if (depth !== bestDepth) return depth > bestDepth;
    if (candidate.globs !== best.globs) return candidate.globs < best.globs;
    return candidate.order < best.order;
}

export function lookup<T>(patterns: readonly Pattern<T>[], path: readonly string[]): T | undefined {
    let best: Pattern<T> | undefined;
    for (const pattern of patterns) {
        if (matches(pattern, path) && moreSpecific(pattern, 0, best, 0)) best = pattern;
    }
    return best?.rule;
}

export function lookupInherited<T>(
    patterns: readonly Pattern<T>[],
    path: readonly string[]
): T | undefined {
    let best: Pattern<T> | undefined;
    let bestDepth = -1;
    for (let depth = path.length; depth >= 0; depth -= 1) {
        const prefix = path.slice(0, depth);
        for (const pattern of patterns) {
            if (matches(pattern, prefix) && moreSpecific(pattern, depth, best, bestDepth)) {
                best = pattern;
                bestDepth = depth;
            }
        }
    }
    return best?.rule;
}

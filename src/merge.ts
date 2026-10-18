import {
    MISSING,
    MergeInputError,
    checkJson,
    identityOf,
    isPlainObject,
    kindOf,
    memberKeys,
    memberOf,
    memoizedEqual,
    preview,
    setMember,
    type Equality,
    type JsonObject,
    type Slot,
} from './json';
import {
    comparePaths,
    compilePatterns,
    lookup,
    lookupInherited,
    toPointer,
    type Pattern,
} from './path';
import type {
    ArrayRule,
    Conflict,
    ConflictKind,
    Json,
    MergeOptions,
    MergeResult,
    Resolution,
    ResolvedConflict,
    Strategy,
} from './types';

const STRATEGIES: readonly Strategy[] = ['ours', 'theirs', 'base', 'max', 'min', 'counter'];
const DEFAULT_MAX_DEPTH = 512;

interface Context {
    readonly options: MergeOptions;
    readonly prefer: 'ours' | 'theirs';
    readonly arrays: readonly Pattern<ArrayRule>[];
    readonly keyed: boolean;
    readonly strategies: readonly Pattern<Strategy>[];
    readonly maxDepth: number;
    readonly equal: Equality;
    readonly path: string[];
    readonly conflicts: [readonly string[], Conflict][];
    readonly resolved: [readonly string[], ResolvedConflict][];
}

interface Element {
    readonly by: string;
    readonly id: string;
}

function checkArrayRule(rule: unknown, pattern: string): ArrayRule {
    if (rule === 'atomic' || rule === 'set') return rule;
    if (
        isPlainObject(rule) &&
        typeof rule.by === 'string' &&
        rule.by !== '' &&
        Object.keys(rule).length === 1
    ) {
        return { by: rule.by };
    }
    throw new TypeError(
        `options.arrays[${JSON.stringify(pattern)}]: expected 'atomic', 'set' or { by: 'id' }`
    );
}

function checkStrategy(rule: unknown, pattern: string): Strategy {
    if (STRATEGIES.includes(rule as Strategy)) return rule as Strategy;
    throw new TypeError(
        `options.strategies[${JSON.stringify(pattern)}]: expected one of ${STRATEGIES.join(', ')}`
    );
}

function contextFrom(options: MergeOptions): Context {
    if (typeof options !== 'object' || options === null) {
        throw new TypeError('options: expected an object');
    }
    const { prefer = 'ours', resolve, maxDepth = DEFAULT_MAX_DEPTH } = options;
    if (prefer !== 'ours' && prefer !== 'theirs') {
        throw new TypeError(`options.prefer: expected 'ours' or 'theirs'`);
    }
    if (resolve !== undefined && typeof resolve !== 'function') {
        throw new TypeError('options.resolve: expected a function');
    }
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
        throw new TypeError('options.maxDepth: expected a positive integer');
    }
    const arrays = compilePatterns(options.arrays, checkArrayRule);
    return {
        options,
        prefer,
        arrays,
        keyed: arrays.some(pattern => typeof pattern.rule === 'object'),
        strategies: compilePatterns(options.strategies, checkStrategy),
        maxDepth,
        equal: memoizedEqual(),
        path: [],
        conflicts: [],
        resolved: [],
    };
}

interface Indexed {
    readonly order: string[];
    readonly items: Map<string, Json>;
}

function indexById(
    by: string,
    side: string,
    array: readonly Json[],
    path: readonly string[]
): Indexed {
    const order: string[] = [];
    const items = new Map<string, Json>();
    array.forEach((item, index) => {
        const fail = (message: string): never => {
            throw new MergeInputError(side, [...path, String(index)], message);
        };
        if (!isPlainObject(item)) {
            fail(`is not an object, so it has no ${JSON.stringify(by)} to merge by`);
        }
        const id = memberOf(item as JsonObject, by);
        if (typeof id !== 'string' && typeof id !== 'number') {
            fail(`has no string or number ${JSON.stringify(by)} to merge by`);
        }
        const key = String(id);
        if (items.has(key)) fail(`repeats ${by} ${JSON.stringify(id)} — ids must be unique`);
        order.push(key);
        items.set(key, item);
    });
    return { order, items };
}

function checkKeyedArrays(context: Context, value: Json, side: string, path: string[]): void {
    if (Array.isArray(value)) {
        const rule = lookup(context.arrays, path);
        if (typeof rule === 'object') {
            const { order, items } = indexById(rule.by, side, value, path);
            for (const id of order) {
                path.push(id);
                checkKeyedArrays(context, items.get(id) as Json, side, path);
                path.pop();
            }
        } else {
            value.forEach((item, index) => {
                path.push(String(index));
                checkKeyedArrays(context, item, side, path);
                path.pop();
            });
        }
    } else if (isPlainObject(value)) {
        for (const key of memberKeys(value)) {
            path.push(key);
            checkKeyedArrays(context, value[key] as Json, side, path);
            path.pop();
        }
    }
}

function kindOfConflict(base: Slot, ours: Slot, theirs: Slot): ConflictKind {
    if (base === MISSING) return 'add-add';
    if (ours === MISSING) return 'delete-edit';
    if (theirs === MISSING) return 'edit-delete';
    const kind = kindOf(base);
    return kindOf(ours) === kind && kindOf(theirs) === kind ? 'value' : 'type';
}

function describeConflict(
    kind: ConflictKind,
    path: readonly string[],
    base: Slot,
    ours: Slot,
    theirs: Slot
): Conflict {
    return {
        kind,
        path: toPointer(path),
        ...(base !== MISSING && { base }),
        ...(ours !== MISSING && { ours }),
        ...(theirs !== MISSING && { theirs }),
    };
}

const ISO_TIMESTAMP =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

interface Instant {
    readonly ms: number;
    readonly fraction: string;
}

function instantOf(text: string): Instant | null {
    const match = ISO_TIMESTAMP.exec(text);
    if (!match) return null;
    const [, year, month, day, hours = '0', minutes = '0', seconds = '0', fraction = '', zone] =
        match;
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    date.setUTCHours(Number(hours), Number(minutes), Number(seconds), 0);
    let ms = date.getTime();
    if (zone && zone.toUpperCase() !== 'Z') {
        const digits = zone.slice(1).replace(':', '');
        const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
        ms -= zone.startsWith('-') ? -offset : offset;
    }
    return Number.isFinite(ms) ? { ms, fraction: fraction.replace(/0+$/, '') } : null;
}

function compareInstants(a: Instant, b: Instant): number {
    if (a.ms !== b.ms) return a.ms - b.ms;
    const width = Math.max(a.fraction.length, b.fraction.length);
    const left = a.fraction.padEnd(width, '0');
    const right = b.fraction.padEnd(width, '0');
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareValues(a: number | string, b: number | string): number {
    if (typeof a === 'string' && typeof b === 'string') {
        const left = instantOf(a);
        const right = instantOf(b);
        const order = left !== null && right !== null ? compareInstants(left, right) : 0;
        if (order !== 0) return order;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

function applyStrategy(strategy: Strategy, conflict: Conflict): Resolution | undefined {
    if (strategy === 'ours' || strategy === 'theirs' || strategy === 'base') {
        return { use: strategy };
    }
    const { kind, base, ours, theirs } = conflict;
    if (kind === 'order') return undefined;
    if (strategy === 'counter') {
        if (typeof ours !== 'number' || typeof theirs !== 'number') return undefined;
        const origin = typeof base === 'number' ? base : 0;
        const total = origin + (ours - origin) + (theirs - origin);
        return Number.isFinite(total) ? { value: total } : undefined;
    }
    const comparable =
        (typeof ours === 'number' && typeof theirs === 'number') ||
        (typeof ours === 'string' && typeof theirs === 'string');
    if (!comparable) return undefined;
    const order = compareValues(ours, theirs);
    const oursWins = strategy === 'max' ? order > 0 : order < 0;
    return { use: oursWins ? 'ours' : 'theirs' };
}

function checkResolution(
    context: Context,
    answer: unknown,
    path: readonly string[],
    element: Element | undefined
): Resolution {
    if (isPlainObject(answer)) {
        const keys = Object.keys(answer);
        if (keys.length === 1) {
            const { use, value, remove } = answer as Record<string, unknown>;
            if (use === 'ours' || use === 'theirs' || use === 'base') return { use };
            if (remove === true) return { remove: true };
            if (keys[0] === 'value') {
                checkJson(value, 'resolve()', context.maxDepth, path);
                if (context.keyed) checkKeyedArrays(context, value as Json, 'resolve()', [...path]);
                if (element) {
                    const id = isPlainObject(value) ? memberOf(value, element.by) : MISSING;
                    if (
                        (typeof id !== 'string' && typeof id !== 'number') ||
                        String(id) !== element.id
                    ) {
                        throw new MergeInputError(
                            'resolve()',
                            path,
                            `must be an object with ${element.by} ${JSON.stringify(element.id)} — it replaces an element of an array merged by ${JSON.stringify(element.by)}`
                        );
                    }
                }
                return { value: value as Json };
            }
        }
    }
    throw new MergeInputError(
        'resolve()',
        path,
        `returned ${preview(answer)} — expected { use: 'ours' | 'theirs' | 'base' }, { value } or { remove: true }`
    );
}

function settle(context: Context, conflict: Conflict, element?: Element): Resolution | undefined {
    const path = [...context.path];
    const strategy = lookupInherited(context.strategies, path);
    const fromStrategy = strategy === undefined ? undefined : applyStrategy(strategy, conflict);
    if (fromStrategy !== undefined) {
        context.resolved.push([path, { ...conflict, resolution: fromStrategy, by: 'strategy' }]);
        return fromStrategy;
    }
    const { resolve } = context.options;
    const answer = resolve?.call(context.options, conflict);
    if (answer !== undefined) {
        const resolution = checkResolution(context, answer, path, element);
        context.resolved.push([path, { ...conflict, resolution, by: 'resolve' }]);
        return resolution;
    }
    context.conflicts.push([path, conflict]);
    return undefined;
}

function conflictAt(
    context: Context,
    base: Slot,
    ours: Slot,
    theirs: Slot,
    element: Element | undefined
): Slot {
    const kind = kindOfConflict(base, ours, theirs);
    const conflict = describeConflict(kind, context.path, base, ours, theirs);
    const resolution = settle(context, conflict, element) ?? { use: context.prefer };
    if ('remove' in resolution) return MISSING;
    if ('value' in resolution) return resolution.value;
    return resolution.use === 'ours' ? ours : resolution.use === 'theirs' ? theirs : base;
}

function mergeSlot(
    context: Context,
    base: Slot,
    ours: Slot,
    theirs: Slot,
    element?: Element
): Slot {
    const { equal } = context;
    if (equal(ours, theirs)) return ours;
    if (equal(base, ours)) return theirs;
    if (equal(base, theirs)) return ours;
    if (ours !== MISSING && theirs !== MISSING) {
        if (isPlainObject(base) && isPlainObject(ours) && isPlainObject(theirs)) {
            return mergeObjects(context, base, ours, theirs);
        }
        if (Array.isArray(ours) && Array.isArray(theirs)) {
            const rule = lookup(context.arrays, context.path) ?? 'atomic';
            if (rule !== 'atomic') {
                const from: readonly Json[] = Array.isArray(base) ? base : [];
                return rule === 'set'
                    ? mergeSets(from, ours, theirs)
                    : mergeById(context, rule.by, from, ours, theirs);
            }
        }
    }
    return conflictAt(context, base, ours, theirs, element);
}

function mergeObjects(
    context: Context,
    base: JsonObject,
    ours: JsonObject,
    theirs: JsonObject
): Json {
    const keys = new Set([...memberKeys(ours), ...memberKeys(theirs), ...memberKeys(base)]);
    const merged: Record<string, Json> = {};
    let unchanged = true;
    for (const key of keys) {
        const oursValue = memberOf(ours, key);
        context.path.push(key);
        const value = mergeSlot(context, memberOf(base, key), oursValue, memberOf(theirs, key));
        context.path.pop();
        if (value !== MISSING) setMember(merged, key, value);
        if (value !== oursValue) unchanged = false;
    }
    return unchanged ? ours : merged;
}

function mergeSets(base: readonly Json[], ours: readonly Json[], theirs: readonly Json[]): Json {
    const inBase = new Set(base.map(identityOf));
    const inTheirs = new Set(theirs.map(identityOf));
    const taken = new Set<string>();
    const merged: Json[] = [];
    for (const item of ours) {
        const id = identityOf(item);
        if (taken.has(id) || (inBase.has(id) && !inTheirs.has(id))) continue;
        taken.add(id);
        merged.push(item);
    }
    for (const item of theirs) {
        const id = identityOf(item);
        if (taken.has(id) || inBase.has(id)) continue;
        taken.add(id);
        merged.push(item);
    }
    return sameItems(merged, ours) ? ours : merged;
}

const sameItems = (a: readonly unknown[], b: readonly unknown[]) =>
    a.length === b.length && a.every((item, index) => item === b[index]);

const only = (order: readonly string[], keep: { has(id: string): boolean }) =>
    order.filter(id => keep.has(id));

const END = Symbol('end');

function placeAll(
    primary: readonly string[],
    sequences: readonly (readonly string[])[],
    merged: Map<string, Json>
): string[] {
    const placed = new Set(primary);
    const before = new Map<string | typeof END, string[]>();
    for (const sequence of sequences) {
        let next: string | typeof END = END;
        for (let index = sequence.length - 1; index >= 0; index -= 1) {
            const id = sequence[index] as string;
            if (!merged.has(id)) continue;
            if (!placed.has(id)) {
                const list = before.get(next);
                if (list) list.push(id);
                else before.set(next, [id]);
                placed.add(id);
            }
            next = id;
        }
    }
    const order: string[] = [];
    const roots: (string | typeof END)[] = [...primary, END];
    for (const root of roots) {
        const stack: [string | typeof END, number][] = [[root, 0]];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1] as [string | typeof END, number];
            const children = before.get(frame[0]);
            if (children && frame[1] < children.length) {
                stack.push([children[frame[1]] as string, 0]);
                frame[1] += 1;
                continue;
            }
            stack.pop();
            if (frame[0] !== END) order.push(frame[0]);
        }
    }
    return order;
}

function mergeById(
    context: Context,
    by: string,
    baseArray: readonly Json[],
    oursArray: readonly Json[],
    theirsArray: readonly Json[]
): Slot {
    const { path } = context;
    const base = indexById(by, 'base', baseArray, path);
    const ours = indexById(by, 'ours', oursArray, path);
    const theirs = indexById(by, 'theirs', theirsArray, path);
    const conflictMark = context.conflicts.length;
    const resolvedMark = context.resolved.length;

    const merged = new Map<string, Json>();
    for (const id of new Set([...ours.order, ...theirs.order, ...base.order])) {
        path.push(id);
        const value = mergeSlot(
            context,
            base.items.get(id) ?? MISSING,
            ours.items.get(id) ?? MISSING,
            theirs.items.get(id) ?? MISSING,
            { by, id }
        );
        path.pop();
        if (value !== MISSING) merged.set(id, value);
    }

    const common = new Set(only(only(base.order, ours.items), theirs.items));
    const baseCommon = only(base.order, common);
    const oursCommon = only(ours.order, common);
    const theirsCommon = only(theirs.order, common);
    const oursMoved = !sameItems(oursCommon, baseCommon);
    const theirsMoved = !sameItems(theirsCommon, baseCommon);

    let primary = theirsMoved && !oursMoved ? theirs : ours;
    if (oursMoved && theirsMoved && !sameItems(oursCommon, theirsCommon)) {
        const conflict = describeConflict('order', path, baseArray, oursArray, theirsArray);
        const resolution = settle(context, conflict) ?? { use: context.prefer };
        if ('remove' in resolution || 'value' in resolution) {
            const own = context.resolved.pop() as [readonly string[], ResolvedConflict];
            context.conflicts.length = conflictMark;
            context.resolved.length = resolvedMark;
            context.resolved.push(own);
            return 'remove' in resolution ? MISSING : resolution.value;
        }
        primary = resolution.use === 'theirs' ? theirs : resolution.use === 'base' ? base : ours;
    }

    const order = placeAll(
        only(primary.order, merged),
        [ours.order, theirs.order, base.order],
        merged
    );
    const result = order.map(id => merged.get(id) as Json);
    return sameItems(result, oursArray) ? oursArray : result;
}

export function merge3<T>(base: T, ours: T, theirs: T, options: MergeOptions = {}): MergeResult<T> {
    const context = contextFrom(options);
    const sides = { base, ours, theirs } as const;
    for (const side of ['base', 'ours', 'theirs'] as const) {
        checkJson(sides[side], side, context.maxDepth);
        if (context.keyed) checkKeyedArrays(context, sides[side] as Json, side, []);
    }

    const value = mergeSlot(context, base as Json, ours as Json, theirs as Json);
    if (value === MISSING) {
        throw new MergeInputError('resolve()', [], 'cannot remove the whole document');
    }
    const byPath = <C>(entries: [readonly string[], C][]) =>
        entries.sort(([a], [b]) => comparePaths(a, b)).map(([, conflict]) => conflict);
    const conflicts = byPath(context.conflicts);
    return {
        ok: conflicts.length === 0,
        value: value as T,
        conflicts,
        resolved: byPath(context.resolved),
    };
}

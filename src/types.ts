export type Json =
    | null
    | boolean
    | number
    | string
    | readonly Json[]
    | { readonly [key: string]: Json | undefined };

export type ConflictKind = 'value' | 'type' | 'add-add' | 'delete-edit' | 'edit-delete' | 'order';

export interface Conflict {
    readonly kind: ConflictKind;
    readonly path: string;
    readonly base?: Json;
    readonly ours?: Json;
    readonly theirs?: Json;
}

export type Resolution =
    | { readonly use: 'ours' | 'theirs' | 'base' }
    | { readonly value: Json }
    | { readonly remove: true };

export interface ResolvedConflict extends Conflict {
    readonly resolution: Resolution;
    readonly by: 'strategy' | 'resolve';
}

export type ArrayRule = 'atomic' | 'set' | { readonly by: string };

export type Strategy = 'ours' | 'theirs' | 'base' | 'max' | 'min' | 'counter';

export interface MergeOptions {
    readonly prefer?: 'ours' | 'theirs';
    readonly arrays?: Readonly<Record<string, ArrayRule>>;
    readonly strategies?: Readonly<Record<string, Strategy>>;
    readonly resolve?: (conflict: Conflict) => Resolution | undefined | void;
    readonly maxDepth?: number;
}

export interface MergeResult<T> {
    readonly ok: boolean;
    readonly value: T;
    readonly conflicts: readonly Conflict[];
    readonly resolved: readonly ResolvedConflict[];
}

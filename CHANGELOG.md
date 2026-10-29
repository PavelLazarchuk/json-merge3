# json-merge3

## 1.0.2

### Patch Changes

- 2ec3ee7: Fix `counter` dropping one of two identical increments, and reject malformed pattern options
  
  - A `counter` strategy now adds both deltas when both sides made the same change: `10 → 11` on both sides merges to `12`, not `11`. This also holds for counters nested in objects or id-merged arrays that both sides changed identically. The settled change is listed in `result.resolved`.
  - `options.arrays` and `options.strategies` that are not an object — `null`, an array, a string — now throw `options.arrays: expected an object of path patterns` instead of a `Cannot convert undefined or null to object` or a misleading JSON Pointer error.

## 1.0.1

### Patch Changes

- 7ef1ea0: Add npm version and downloads badges to the README.

## 1.0.0

### Major Changes

- Initial release.
- TypeScript support.
- Documentation.

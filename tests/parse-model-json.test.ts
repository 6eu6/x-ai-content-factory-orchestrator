import { describe, it, expect } from 'vitest';
import { parseModelJson } from '../lib/model-router';

describe('parseModelJson', () => {
  it('parses plain JSON', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json code fences', () => {
    expect(parseModelJson('```json\n{"a":1,"b":"x"}\n```')).toEqual({ a: 1, b: 'x' });
  });

  it('strips bare ``` fences', () => {
    expect(parseModelJson('```\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('ignores prose around the JSON object', () => {
    expect(parseModelJson('Here is the result: {"a":1} hope it helps')).toEqual({ a: 1 });
  });

  it('parses arrays', () => {
    expect(parseModelJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('returns {} for empty / non-string input', () => {
    expect(parseModelJson('')).toEqual({});
    // @ts-expect-error testing runtime guard
    expect(parseModelJson(null)).toEqual({});
  });
});

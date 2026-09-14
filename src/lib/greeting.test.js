import { describe, it, expect } from 'vitest';
import { greeting } from './greeting';

describe('greeting', () => {
  it('follows the clock', () => {
    expect(greeting(new Date(2026, 8, 14, 9))).toBe('Morning');
    expect(greeting(new Date(2026, 8, 14, 11, 59))).toBe('Morning');
    expect(greeting(new Date(2026, 8, 14, 12))).toBe('Afternoon');
    expect(greeting(new Date(2026, 8, 14, 16, 59))).toBe('Afternoon');
    expect(greeting(new Date(2026, 8, 14, 17))).toBe('Evening');
  });
});

import { describe, it, expect } from 'vitest';
import { rejectReason, MAX_BYTES, ACCEPT } from './funDayImage';

const file = (over = {}) => ({ name: 'sept.png', type: 'image/png', size: 400 * 1024, ...over });

describe('rejectReason', () => {
  it('takes an ordinary screenshot or photo', () => {
    expect(rejectReason(file())).toBeNull();
    expect(rejectReason(file({ name: 'IMG_5718.HEIC', type: 'image/heic' }))).toBeNull();
    expect(rejectReason(file({ type: 'image/jpeg', size: 3 * 1024 * 1024 }))).toBeNull();
  });

  it('turns away a PDF with a useful sentence, not an error code', () => {
    const why = rejectReason(file({ name: 'FunDay.pdf', type: 'application/pdf' }));
    expect(why).toMatch(/image/i);
    expect(why).toMatch(/screenshot or a photo/i);
  });

  it('says how big the file actually was', () => {
    const why = rejectReason(file({ size: MAX_BYTES + 1 }));
    expect(why).toMatch(/8\.0 MB/);
    expect(why).toMatch(/limit is 8 MB/);
  });

  it('asks for a file when there is none', () => {
    expect(rejectReason(null)).toMatch(/Pick an image/);
  });

  it('offers the picker the formats a phone actually produces', () => {
    expect(ACCEPT).toContain('image/heic');
    expect(ACCEPT).toContain('image/jpeg');
  });
});

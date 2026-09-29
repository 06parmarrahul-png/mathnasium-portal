import { describe, it, expect } from 'vitest';
import { signingString, expectedSignature, verifyTwilioSignature } from './twilioSignature.js';

const TOKEN = 'test_auth_token';
const URL_ = 'https://ratio.example/api/notify?action=sms-inbound&centerId=langley';

describe('rebuilding what Twilio signed', () => {
  it('sorts the fields and concatenates them onto the URL', () => {
    expect(signingString('https://x/y', { b: '2', a: '1' })).toBe('https://x/ya1b2');
  });

  it('signs the URL alone when there is no body', () => {
    expect(signingString('https://x/y', {})).toBe('https://x/y');
    expect(signingString('https://x/y', null)).toBe('https://x/y');
  });

  it('treats a missing value as empty rather than "undefined"', () => {
    expect(signingString('u', { a: undefined })).toBe('ua');
  });
});

describe('verifying an inbound webhook', () => {
  const params = { From: '+16045550143', Body: 'STOP', To: '+18005550100' };

  it('accepts a request Twilio actually signed', () => {
    const signature = expectedSignature(TOKEN, URL_, params);
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params, signature })).toBe(true);
  });

  it('rejects a forged STOP for somebody else’s number', () => {
    // The attack this exists to stop: anyone who finds the URL marking a
    // number as withdrawn — or worse, as consenting.
    const signature = expectedSignature(TOKEN, URL_, params);
    const forged = { ...params, From: '+16045559999' };
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params: forged, signature })).toBe(false);
  });

  it('rejects a signature made with the wrong token', () => {
    const signature = expectedSignature('other_token', URL_, params);
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params, signature })).toBe(false);
  });

  it('rejects one signed for a different URL', () => {
    const signature = expectedSignature(TOKEN, 'https://ratio.example/elsewhere', params);
    expect(verifyTwilioSignature({ authToken: TOKEN, url: URL_, params, signature })).toBe(false);
  });

  it('says no, rather than throwing, when anything is missing or junk', () => {
    for (const bad of [
      { authToken: null, url: URL_, params, signature: 'x' },
      { authToken: TOKEN, url: URL_, params, signature: null },
      { authToken: TOKEN, url: URL_, params, signature: 'not-base64!!' },
      { authToken: TOKEN, url: URL_, params: null, signature: 'abc' },
    ]) {
      expect(() => verifyTwilioSignature(bad)).not.toThrow();
      expect(verifyTwilioSignature(bad)).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { escapeHtml, loopbackRedirectHost, loopbackRedirectUri } from '../connector/oauthLoopback.js';

describe('escapeHtml', () => {
  it('转义回调页会拼进去的字符', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)"> & '`)).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;',
    );
  });
});

describe('loopbackRedirectHost', () => {
  it('Microsoft 用 localhost, Google 用 127.0.0.1', () => {
    expect(loopbackRedirectHost('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')).toBe('localhost');
    expect(loopbackRedirectHost('https://slack.com/oauth/v2/authorize')).toBe('localhost');
    expect(loopbackRedirectHost('https://accounts.google.com/o/oauth2/v2/auth')).toBe('127.0.0.1');
  });

  it('拼出来的回调带 /callback', () => {
    expect(loopbackRedirectUri(43123, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'))
      .toBe('http://localhost:43123/callback');
    expect(loopbackRedirectUri(43123, 'https://accounts.google.com/o/oauth2/v2/auth'))
      .toBe('http://127.0.0.1:43123/callback');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthorizationUrl,
  getServerKey,
  storeTokens,
  loadStoredTokens,
  clearStoredTokens,
} from '../oauth.js';
import { CONFIG_DIR } from '@neoxlabs/platform/utils/config.js';

const TOKEN_STORE_FILE = 'mcp-oauth-tokens.json';
const tokenStorePath = path.join(CONFIG_DIR, TOKEN_STORE_FILE);

describe('PKCE', () => {
  it('generates code_verifier of correct length', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('generates different verifiers each time', () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    expect(v1).not.toBe(v2);
  });

  it('generates valid S256 code_challenge', () => {
    const verifier = 'test-verifier-string-for-pkce-challenge';
    const challenge = generateCodeChallenge(verifier);
    // S256 challenge is base64url encoded SHA256
    expect(challenge).toBeTruthy();
    expect(challenge.length).toBeGreaterThan(0);
    // base64url: no +, /, =
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it('same verifier produces same challenge', () => {
    const verifier = 'deterministic-test';
    const c1 = generateCodeChallenge(verifier);
    const c2 = generateCodeChallenge(verifier);
    expect(c1).toBe(c2);
  });
});

describe('buildAuthorizationUrl', () => {
  const metadata = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
  };

  it('builds correct URL with all params', () => {
    const url = buildAuthorizationUrl(
      metadata, 'client-123', 'http://localhost:8080/callback',
      'challenge-abc', 'state-xyz', 'read write',
    );

    expect(url).toContain('https://auth.example.com/authorize?');
    expect(url).toContain('client_id=client-123');
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge=challenge-abc');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=state-xyz');
    expect(url).toContain('scope=read+write');
  });

  it('omits scope if not provided', () => {
    const url = buildAuthorizationUrl(
      metadata, 'client-123', 'http://localhost:8080/callback',
      'challenge', 'state',
    );
    expect(url).not.toContain('scope=');
  });
});

describe('getServerKey', () => {
  it('generates consistent keys', () => {
    const k1 = getServerKey('my-server', 'https://example.com/mcp');
    const k2 = getServerKey('my-server', 'https://example.com/mcp');
    expect(k1).toBe(k2);
  });

  it('generates different keys for different URLs', () => {
    const k1 = getServerKey('server', 'https://a.com/mcp');
    const k2 = getServerKey('server', 'https://b.com/mcp');
    expect(k1).not.toBe(k2);
  });

  it('includes server name in key', () => {
    const key = getServerKey('my-server', 'https://example.com');
    expect(key).toContain('my-server');
    expect(key).toContain('|');
  });
});

describe('Token Storage', () => {
  // 备份和恢复 token store
  let backup: string | null = null;

  beforeEach(() => {
    try {
      backup = fs.readFileSync(tokenStorePath, 'utf-8');
    } catch {
      backup = null;
    }
  });

  afterEach(() => {
    if (backup !== null) {
      fs.writeFileSync(tokenStorePath, backup, 'utf-8');
    } else {
      try { fs.unlinkSync(tokenStorePath); } catch { /* ignore */ }
    }
  });

  it('stores and loads tokens', () => {
    storeTokens(
      'test-server', 'https://test.example.com',
      { client_id: 'cid-123' },
      {
        access_token: 'at-abc',
        refresh_token: 'rt-xyz',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'read',
      },
    );

    const loaded = loadStoredTokens('test-server', 'https://test.example.com');
    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe('at-abc');
    expect(loaded!.refreshToken).toBe('rt-xyz');
    expect(loaded!.clientId).toBe('cid-123');
    expect(loaded!.scope).toBe('read');
    expect(loaded!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('clears tokens', () => {
    storeTokens(
      'to-clear', 'https://clear.example.com',
      { client_id: 'cid' },
      { access_token: 'at', token_type: 'Bearer' },
    );

    expect(loadStoredTokens('to-clear', 'https://clear.example.com')).not.toBeNull();

    clearStoredTokens('to-clear', 'https://clear.example.com');

    expect(loadStoredTokens('to-clear', 'https://clear.example.com')).toBeNull();
  });

  it('returns null for unknown server', () => {
    expect(loadStoredTokens('nonexistent', 'https://nope.com')).toBeNull();
  });
});

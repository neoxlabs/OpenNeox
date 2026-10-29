import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildConnectorAuthorizeUrl,
  buildOAuthTokenBody,
  connectorOAuthProvider,
  parseDotEnv,
  parseOAuthTokenPayload,
  resolveAuthorizeRedirectUri,
  resolveConnectorClientId,
  resolveConnectorClientSecret,
  resolveLoopbackListenPort,
} from '../connector/oauthTokens.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const MS_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const SLACK_AUTH = 'https://slack.com/oauth/v2/authorize';

const envKeys = [
  'NEOX_SECRETS_DIR',
  'NEOX_GOOGLE_OAUTH_CLIENT_ID',
  'NEOX_GOOGLE_OAUTH_CLIENT_SECRET',
  'NEOX_MICROSOFT_OAUTH_CLIENT_ID',
  'NEOX_MICROSOFT_OAUTH_CLIENT_SECRET',
  'NEOX_SLACK_OAUTH_CLIENT_ID',
  'NEOX_SLACK_OAUTH_CLIENT_SECRET',
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of envKeys) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of envKeys) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
});

describe('connectorOAuthProvider', () => {
  it('认 Google / Microsoft / Slack 主机', () => {
    expect(connectorOAuthProvider(GOOGLE_AUTH)).toBe('google');
    expect(connectorOAuthProvider(MS_AUTH)).toBe('microsoft');
    expect(connectorOAuthProvider(SLACK_AUTH)).toBe('slack');
    expect(connectorOAuthProvider('https://example.com/oauth')).toBe('other');
  });
});

describe('parseDotEnv', () => {
  it('忽略注释和空行，去掉引号', () => {
    expect(parseDotEnv([
      '# comment',
      '',
      'NEOX_GOOGLE_OAUTH_CLIENT_ID=abc.apps.googleusercontent.com',
      'NEOX_GOOGLE_OAUTH_CLIENT_SECRET="s3cret"',
    ].join('\n'))).toEqual({
      NEOX_GOOGLE_OAUTH_CLIENT_ID: 'abc.apps.googleusercontent.com',
      NEOX_GOOGLE_OAUTH_CLIENT_SECRET: 's3cret',
    });
  });
});

describe('resolveConnectorClientSecret', () => {
  it('Google 优先读环境变量', () => {
    process.env.NEOX_GOOGLE_OAUTH_CLIENT_SECRET = 'from-env';
    expect(resolveConnectorClientSecret(GOOGLE_AUTH)).toBe('from-env');
  });

  it('环境变量空时读 ~/.neox-secrets/google-oauth.env', async () => {
    delete process.env.NEOX_GOOGLE_OAUTH_CLIENT_SECRET;
    const dir = await mkdtemp(join(tmpdir(), 'neox-oauth-secrets-'));
    process.env.NEOX_SECRETS_DIR = dir;
    await writeFile(join(dir, 'google-oauth.env'), [
      'NEOX_GOOGLE_OAUTH_CLIENT_ID=id-from-file',
      'NEOX_GOOGLE_OAUTH_CLIENT_SECRET=secret-from-file',
    ].join('\n'), 'utf8');
    expect(resolveConnectorClientSecret(GOOGLE_AUTH)).toBe('secret-from-file');
    expect(resolveConnectorClientId(
      { kind: 'oauth2', authorizeUrl: GOOGLE_AUTH, tokenUrl: 'https://oauth2.googleapis.com/token', scopes: [] },
      {},
      GOOGLE_AUTH,
    )).toBe('id-from-file');
  });

  it('Microsoft 公共客户端可以没有 secret', () => {
    delete process.env.NEOX_MICROSOFT_OAUTH_CLIENT_SECRET;
    process.env.NEOX_SECRETS_DIR = join(tmpdir(), 'neox-oauth-secrets-missing');
    expect(resolveConnectorClientSecret(MS_AUTH)).toBeUndefined();
  });

  it('Slack 读 slack-oauth.env', async () => {
    delete process.env.NEOX_SLACK_OAUTH_CLIENT_ID;
    delete process.env.NEOX_SLACK_OAUTH_CLIENT_SECRET;
    const dir = await mkdtemp(join(tmpdir(), 'neox-oauth-secrets-'));
    process.env.NEOX_SECRETS_DIR = dir;
    await writeFile(join(dir, 'slack-oauth.env'), [
      'NEOX_SLACK_OAUTH_CLIENT_ID=1.2',
      'NEOX_SLACK_OAUTH_CLIENT_SECRET=slack-secret',
    ].join('\n'), 'utf8');
    expect(resolveConnectorClientSecret(SLACK_AUTH)).toBe('slack-secret');
    expect(resolveConnectorClientId(
      { kind: 'oauth2', authorizeUrl: SLACK_AUTH, tokenUrl: 'https://slack.com/api/oauth.v2.access', scopes: [] },
      {},
      SLACK_AUTH,
    )).toBe('1.2');
  });
});

describe('buildOAuthTokenBody', () => {
  it('有 secret 就带上，没有就不写这个字段', () => {
    const withSecret = buildOAuthTokenBody({
      grantType: 'authorization_code',
      clientId: 'cid',
      clientSecret: 's',
      code: 'c',
      verifier: 'v',
      redirectUri: 'http://127.0.0.1:9/callback',
    });
    expect(withSecret.get('client_secret')).toBe('s');
    expect(withSecret.get('code_verifier')).toBe('v');

    const publicClient = buildOAuthTokenBody({
      grantType: 'refresh_token',
      clientId: 'cid',
      refreshToken: 'r',
    });
    expect(publicClient.has('client_secret')).toBe(false);
    expect(publicClient.get('grant_type')).toBe('refresh_token');
  });
});

describe('parseOAuthTokenPayload', () => {
  it('读 Slack authed_user 用户票', () => {
    const tokens = parseOAuthTokenPayload({
      ok: true,
      authed_user: {
        access_token: 'xoxp-user',
        refresh_token: 'xoxe-r',
        expires_in: 120,
        scope: 'search:read',
      },
    });
    expect(tokens.accessToken).toBe('xoxp-user');
    expect(tokens.refreshToken).toBe('xoxe-r');
    expect(tokens.scope).toBe('search:read');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it('ok:false 当失败', () => {
    expect(() => parseOAuthTokenPayload({ ok: false, error: 'invalid_code' })).toThrow('invalid_code');
  });
});

describe('buildConnectorAuthorizeUrl', () => {
  it('Slack 用 user_scope 逗号列表，不写 Google 的 access_type', () => {
    const url = new URL(buildConnectorAuthorizeUrl({
      authorizeUrl: SLACK_AUTH,
      clientId: '1.2',
      redirectUri: 'https://neox-dev.com/oauth/slack/callback',
      state: 'st',
      codeChallenge: 'ch',
      scopes: ['search:read', 'chat:write'],
    }));
    expect(url.searchParams.get('user_scope')).toBe('search:read,chat:write');
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.searchParams.get('redirect_uri')).toBe('https://neox-dev.com/oauth/slack/callback');
  });
});

describe('resolveAuthorizeRedirectUri / loopback port', () => {
  it('有公开回调就用它，并固定 58721', () => {
    const auth = {
      kind: 'oauth2' as const,
      authorizeUrl: SLACK_AUTH,
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: ['chat:write'],
      redirectUri: 'https://neox-dev.com/oauth/slack/callback',
    };
    expect(resolveAuthorizeRedirectUri(auth, 'http://localhost:9/callback'))
      .toBe('https://neox-dev.com/oauth/slack/callback');
    expect(resolveLoopbackListenPort(auth)).toBe(58721);
  });
});

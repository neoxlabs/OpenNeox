import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import { NeoxInput, NeoxButton, PageTitle } from '../../../components/settings-base';
import './ShareTab.clay.css';

type Cfg = { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl: string };
type TestResult = { ok: boolean; stage?: 'config' | 'upload' | 'public'; url?: string; error?: string; missing?: string[] };
const EMPTY: Cfg = { accountId: '', bucket: '', accessKeyId: '', secretAccessKey: '', publicBaseUrl: '' };

export default function ShareTab(): React.ReactElement {
  const { isZh } = useI18n();
  const api = (window as any).neox;
  const [cfg, setCfg] = React.useState<Cfg>(EMPTY);
  const [showSecret, setShowSecret] = React.useState(false);
  const [busy, setBusy] = React.useState<'save' | 'test' | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [test, setTest] = React.useState<TestResult | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    void Promise.resolve(api?.shareGetConfig?.()).then((c: Partial<Cfg> | undefined) => setCfg({ ...EMPTY, ...(c ?? {}) }));
  }, [api]);

  const set = (k: keyof Cfg) => (e: React.ChangeEvent<HTMLInputElement>) => { setCfg((c) => ({ ...c, [k]: e.target.value })); setSaved(false); };

  const save = async (): Promise<boolean> => {
    setBusy('save'); setErr(null);
    try {
      const r = await api?.shareSetConfig?.(cfg);
      if (!r?.success) throw new Error(r?.error || 'save failed');
      setSaved(true);
      return true;
    } catch (e: any) { setErr(String(e?.message ?? e)); return false; } finally { setBusy(null); }
  };

  const runTest = async () => {
    setTest(null);
    if (!(await save())) return;
    setBusy('test');
    try { setTest(await api?.shareTest?.()); } catch (e: any) { setTest({ ok: false, error: String(e?.message ?? e) }); } finally { setBusy(null); }
  };

  const fields: Array<{ k: keyof Cfg; label: string; ph: string; secret?: boolean }> = [
    { k: 'accountId', label: isZh ? '账号 ID' : 'Account ID', ph: '0123456789abcdef…' },
    { k: 'bucket', label: isZh ? '桶名' : 'Bucket', ph: 'my-pages' },
    { k: 'accessKeyId', label: isZh ? 'S3 访问密钥 ID' : 'S3 access key ID', ph: 'Access Key ID' },
    { k: 'secretAccessKey', label: isZh ? 'S3 机密访问密钥' : 'S3 secret access key', ph: 'Secret Access Key', secret: true },
    { k: 'publicBaseUrl', label: isZh ? '公开访问地址' : 'Public URL', ph: 'https://pub-xxxx.r2.dev' },
  ];

  /* 五项都填了才算「已配置」(只看本页现有的配置, 不查上游) */
  const configured = fields.every((f) => cfg[f.k].trim() !== '');

  const testLine = (() => {
    if (!test) return null;
    if (test.ok) return <p className="share-test is-ok">{isZh ? '可以用了。测试页: ' : 'Ready. Test page: '}<a href={test.url} target="_blank" rel="noreferrer">{test.url}</a></p>;
    const msg = test.stage === 'config'
      ? (isZh ? `还没填完: ${(test.missing ?? []).length} 项` : `Missing ${(test.missing ?? []).length} field(s)`)
      : test.stage === 'upload'
        ? (isZh ? `传不上去 —— 检查账号 ID、桶名和两个密钥 (${test.error})` : `Upload failed — check the account ID, bucket and keys (${test.error})`)
        : (isZh ? `传上去了, 但公开地址打不开 —— 桶要开公开访问, 地址要填对 (${test.error})` : `Uploaded, but the public URL does not open — enable public access on the bucket and check the URL (${test.error})`);
    return <p className="share-test is-bad">{msg}</p>;
  })();

  return (
    <div className="share-tab sh3">
      <PageTitle
        title={isZh ? '网页分享' : 'Page sharing'}
        subtitle={isZh ? '把做好的网页发成链接给别人' : 'Turn what you built into a link for others'}
      />

      <section className="sh3-card sh3-status">
        <span className="sh3-status__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a3.8 3.8 0 0 1 .5 7.5H7Z" />
          </svg>
        </span>
        <div className="sh3-status__text">
          <h3>{isZh ? '用你自己的 Cloudflare R2' : 'Your own Cloudflare R2'}</h3>
          <p>{isZh
            ? 'Agent 做好的页面传到你自己的 Cloudflare R2, 拿到链接就能发给别人。Neox 不经手你的文件。'
            : 'Pages the agent builds go to your own Cloudflare R2 and come back as a link you can send. Neox never holds your files.'}</p>
          <a href="https://dash.cloudflare.com/?to=/:account/r2" target="_blank" rel="noopener noreferrer" className="mfs-link">
            {isZh ? '打开 Cloudflare' : 'Open Cloudflare'} ↗
          </a>
        </div>
        <span className={`sh3-badge${configured ? '' : ' is-warm'}`}>
          {configured ? (isZh ? '已配置' : 'Configured') : (isZh ? '未配置' : 'Not set up')}
        </span>
      </section>

      <section className="sh3-card ws-config">
        <h4>{isZh ? '准备一个 R2 桶' : 'Set up an R2 bucket'}</h4>
        <ol className="share-steps">
          <li>{isZh ? 'R2 → 新建桶。' : 'R2 → Create bucket.'}</li>
          <li>{isZh ? '桶的设置 → 公开访问 → 打开 r2.dev 子域 (或绑自己的域名), 复制那个地址。' : 'Bucket settings → Public access → enable the r2.dev subdomain (or a custom domain) and copy the URL.'}</li>
          <li>{isZh ? 'R2 → 管理 API 令牌 → 创建令牌 (对象读写, 限这个桶), 复制访问密钥 ID 和机密。账号 ID 在同一页。' : 'R2 → Manage API tokens → Create token (Object Read & Write, this bucket), copy the key ID and secret. The account ID is on the same page.'}</li>
        </ol>
      </section>

      <section className="sh3-card sh3-form ws-config share-form">
        <h4>{isZh ? 'R2 设置' : 'R2 settings'}</h4>
        {fields.map((f) => (
          <label key={f.k} className={`share-field${f.k === 'publicBaseUrl' ? ' is-wide' : ''}`}>
            <span>{f.label}</span>
            <div className="ws-config__input">
              <NeoxInput
                type={f.secret && !showSecret ? 'password' : 'text'}
                value={cfg[f.k]}
                onChange={set(f.k)}
                placeholder={f.ph}
                spellCheck={false}
              />
              {f.secret && (
                <button type="button" className="ws-config__eye" onClick={() => setShowSecret((v) => !v)}
                  aria-label={showSecret ? (isZh ? '隐藏' : 'Hide') : (isZh ? '显示' : 'Show')}>
                  {showSecret ? <Icons.Lock /> : <Icons.Eye />}
                </button>
              )}
            </div>
          </label>
        ))}
        <div className="share-actions">
          <NeoxButton variant="secondary" size="sm" onClick={() => void save()} disabled={busy !== null}>
            {busy === 'save' ? (isZh ? '保存中…' : 'Saving…') : saved ? (isZh ? '已保存' : 'Saved') : (isZh ? '保存' : 'Save')}
          </NeoxButton>
          <NeoxButton variant="secondary" size="sm" onClick={() => void runTest()} disabled={busy !== null}>
            {busy === 'test' ? (isZh ? '测试中…' : 'Testing…') : (isZh ? '保存并测试' : 'Save & test')}
          </NeoxButton>
        </div>
        {err && <p className="share-test is-bad">{err}</p>}
        {testLine}
      </section>
    </div>
  );
}

/**
 * PetTab — 桌宠设置 (商用面板)
 *
 * 设计原则:
 *   · 消费者口吻: 不出现 .glb / Three.js / lazy / CC0 / hueShift / bundle 等技术词
 *   · 一致样式: 复用 .btn-primary / .btn-secondary / .toggle-switch / .seg-control /
 *     .setting-row / .section-title / .panel-header — 跟其它 Settings tab 视觉对齐
 *   · 渐进暴露: 3D / 2D 模式各自的内容只在该模式选中时展开, 不堆在一起
 *   · 真预览: 选定形象后下方实时显示 3D Canvas (3D 模式) / 实时 sprite (2D 模式)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useIsAdvancedLevel } from '../../../state/settingsLevel';
import { confirmAsync } from '../../../components/confirmEvents';
import { dispatchOpFailed } from '../../../components/notifyEvents';
import { petConfig, usePetConfig, type PetCorner, type PetSize } from '../../../modules/pet';
import { PET_CANDIDATES } from '../../../modules/pet/petCandidates';
import { randomPet2DSpec } from '../../../modules/pet/pet2d';
import Pet2DSprite from '../../../modules/pet/Pet2DSprite';
import { SPRITE_CANDIDATES } from '../../../modules/pet/spriteCandidates';
import { PetSpriteSheet } from '../../../modules/pet/PetSpriteSheet';
import NeoxPetSvg, { NEO_VARIANTS } from '../../../modules/pet/svg/NeoxPetSvg';
import { PET_RENDERERS, PET_RENDERER_PLUGINS, isRendererAvailable, isPetRendererPluginAvailable } from '../../../modules/pet/renderers/petRenderers';
import { useMascotPrefs, type MascotSpecies } from '../../../modules/mascot/useMascotPrefs';
import { MascotEyes } from '../../../modules/mascot/MascotEyes';
import catBase from '../../../assets/mascots/cat-base-v2.webp';
import corgiBase from '../../../assets/mascots/corgi-base-v2.webp';
import '../../../modules/mascot/mascot.css';
import { isLiteEdition } from '../../../utils/edition';
import './PetTab.css';
import './PetTab.clay.css';
import { PageTitle, Switch } from '../../../components/settings-base';
import { NeoxIllus } from '../../../media/illus';

/** Which one pet is on: one of ours beside the composer, the open-source desktop pet, or none. */
type PetChoice = MascotSpecies | 'open' | 'off';

interface CustomSkinMeta {
  id: string;
  name: string;
  fileName: string;
  sizeBytes: number;
  importedAt: number;
}

interface CustomSpriteMeta {
  id: string;
  name: string;
  fileName: string;
  sizeBytes: number;
  importedAt: number;
  cellWidth?: number;
  cellHeight?: number;
  description?: string;
}

interface PetIpcApi {
  listCustomSkins: () => Promise<{ ok: true; skins: CustomSkinMeta[] } | { ok: false; error: string }>;
  importGlb: () => Promise<{ ok: true; skin: CustomSkinMeta } | { ok: false; error: string }>;
  deleteCustomSkin: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  listCustomSprites: () => Promise<{ ok: true; sprites: CustomSpriteMeta[] } | { ok: false; error: string }>;
  importSprite: () => Promise<{ ok: true; sprite: CustomSpriteMeta } | { ok: false; error: string }>;
  importPetBundle: () => Promise<{ ok: true; sprite: CustomSpriteMeta } | { ok: false; error: string }>;
  discoverPacks: () => Promise<{ ok: true; packs: DiscoveredPack[] } | { ok: false; error: string }>;
  importDiscovered: (dir: string) => Promise<{ ok: true; sprite: CustomSpriteMeta } | { ok: false; error: string }>;
  ensureRenderer: (mode: string) => Promise<{ ok: true; source: string } | { ok: false; error: string }>;
  removeRenderer: (mode: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  deleteCustomSprite: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

interface DiscoveredPack {
  dir: string;
  id: string;
  displayName: string;
  description?: string;
  previewDataUrl?: string;
}

function getPetIpc(): PetIpcApi | null {
  const neox = (window as unknown as { neox?: { pet?: PetIpcApi } }).neox;
  return neox?.pet ?? null;
}

const PetTab: React.FC<{ embedded?: boolean }> = ({ embedded }) => {
  const isAdvancedLevel = useIsAdvancedLevel();
  const { language } = useSettingsContext();
  const zh = language === 'zh';
  const cfg = usePetConfig();
  const mascot = useMascotPrefs();
  /* 极简版不带开源桌宠 (悬浮窗 handler 没注册), 只剩我们自己的两只。 */
  const openPetAvailable = !isLiteEdition();
  const choice: PetChoice = cfg.enabled && openPetAvailable ? 'open' : mascot.hidden ? 'off' : mascot.species;
  /* 同一时间只陪一只: 选自研的就关掉桌面悬浮窗, 选开源的就把输入框旁那只收起来。 */
  const choose = useCallback((next: PetChoice) => {
    if (next === 'cat' || next === 'corgi') {
      mascot.setSpecies(next);
      mascot.setHidden(false);
      if (petConfig.get().enabled) petConfig.set('enabled', false);
    } else if (next === 'open') {
      mascot.setHidden(true);
      petConfig.set('enabled', true);
    } else {
      mascot.setHidden(true);
      if (petConfig.get().enabled) petConfig.set('enabled', false);
    }
  }, [mascot]);

  /* 内置 / 自定义 sub-tab */
  const [skinTab, setSkinTab] = useState<'builtin' | 'custom'>('builtin');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  /* 首次 mount 时拉自定义列表 (用户可能跨设备同步或手动改过 userData/pets/) */
  useEffect(() => {
    const api = getPetIpc();
    if (!api) return;
    api.listCustomSkins().then((res) => {
      if (res.ok) petConfig.set('customSkins', res.skins);
    }).catch(() => { /* ignore */ });
    api.listCustomSprites().then((res) => {
      if (res.ok) petConfig.set('customSprites', res.sprites);
    }).catch(() => { /* ignore */ });
  }, []);

  /* ---------- Sprite 模式操作 ---------- */
  const [spriteImporting, setSpriteImporting] = useState(false);
  const [spriteImportError, setSpriteImportError] = useState<string | null>(null);

  const handleImportSprite = useCallback(async () => {
    const api = getPetIpc();
    if (!api) return;
    setSpriteImporting(true);
    setSpriteImportError(null);
    try {
      const res = await api.importSprite();
      if (res.ok) {
        const list = await api.listCustomSprites();
        if (list.ok) petConfig.set('customSprites', list.sprites);
        petConfig.set('activeSpriteId', res.sprite.id);
        petConfig.set('mode', 'sprite');
      } else if (res.error !== 'cancelled') {
        setSpriteImportError(res.error);
      }
    } catch (err: any) {
      setSpriteImportError(err?.message ?? String(err));
    } finally {
      setSpriteImporting(false);
    }
  }, []);

  /* Codex Pets / OpenPets bundle 导入 (.zip 或文件夹, 含 pet.json + spritesheet) */
  const handleImportPetBundle = useCallback(async () => {
    const api = getPetIpc();
    if (!api) return;
    setSpriteImporting(true);
    setSpriteImportError(null);
    try {
      const res = await api.importPetBundle();
      if (res.ok) {
        const list = await api.listCustomSprites();
        if (list.ok) petConfig.set('customSprites', list.sprites);
        petConfig.set('activeSpriteId', res.sprite.id);
        petConfig.set('mode', 'sprite');
      } else if (res.error !== 'cancelled') {
        setSpriteImportError(res.error);
      }
    } catch (err: any) {
      setSpriteImportError(err?.message ?? String(err));
    } finally {
      setSpriteImporting(false);
    }
  }, []);

  /* 发现已安装的社区桌宠 (PetDex CLI: `npx petdex install <name>`) */
  const [discovered, setDiscovered] = useState<DiscoveredPack[]>([]);
  const refreshDiscovered = useCallback(async () => {
    const api = getPetIpc();
    if (!api?.discoverPacks) return;
    try {
      const res = await api.discoverPacks();
      if (res.ok) setDiscovered(res.packs);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void refreshDiscovered(); }, [refreshDiscovered]);

  const handleAddDiscovered = useCallback(async (dir: string) => {
    const api = getPetIpc();
    if (!api?.importDiscovered) return;
    setSpriteImporting(true);
    setSpriteImportError(null);
    try {
      const res = await api.importDiscovered(dir);
      if (res.ok) {
        const list = await api.listCustomSprites();
        if (list.ok) petConfig.set('customSprites', list.sprites);
        petConfig.set('activeSpriteId', res.sprite.id);
        petConfig.set('mode', 'sprite');
      } else if (res.error !== 'cancelled') {
        setSpriteImportError(res.error);
      }
    } catch (err: any) {
      setSpriteImportError(err?.message ?? String(err));
    } finally {
      setSpriteImporting(false);
    }
  }, []);

  const handleUseSprite = useCallback((id: string) => {
    petConfig.set('activeSpriteId', id);
    petConfig.set('mode', 'sprite');
  }, []);

  /* 启用/停用"渲染器插件" (如 3D). 启用时从统一商店按需下载 (有内置兜底则秒成);
   * 停用时若当前正用它, 回落到灵动, 并回收下载副本. */
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const handleTogglePlugin = useCallback(async (id: string, enabled: boolean) => {
    const api = getPetIpc();
    setPluginError(null);
    /* 包没发布就别去下了 —— 开关已置灰, 这里再兜一道 (见 petRenderers.unavailable) */
    if (enabled && !isPetRendererPluginAvailable(id)) return;
    if (enabled) {
      /* 先确保渲染器就绪 (下载) 再启用 */
      setPluginBusy(id);
      try {
        const res = await api?.ensureRenderer?.(id);
        if (res && !res.ok) {
          setPluginError(res.error);
          return;
        }
      } catch (err: any) {
        setPluginError(err?.message ?? String(err));
        return;
      } finally {
        setPluginBusy(null);
      }
      const cur = petConfig.get();
      petConfig.set('enabledPlugins', Array.from(new Set([...cur.enabledPlugins, id])));
    } else {
      const cur = petConfig.get();
      petConfig.set('enabledPlugins', cur.enabledPlugins.filter((p) => p !== id));
      if (cur.mode === id) petConfig.set('mode', 'svg');
      void api?.removeRenderer?.(id);
    }
  }, []);

  const handleDeleteSprite = useCallback(async (id: string) => {
    const api = getPetIpc();
    if (!api) return;
    if (!(await confirmAsync({ title: zh ? '删除这个 sprite?' : 'Delete this sprite?', message: zh ? '此操作不可撤销。' : 'This cannot be undone.', variant: 'danger', confirmLabel: zh ? '删除' : 'Delete' }))) return;
    const res = await api.deleteCustomSprite(id);
    if (res.ok) {
      const list = await api.listCustomSprites();
      if (list.ok) petConfig.set('customSprites', list.sprites);
      if (cfg.activeSpriteId === id) {
        petConfig.set('activeSpriteId', SPRITE_CANDIDATES[0]?.id ?? null);
      }
    } else {
      dispatchOpFailed({ op: zh ? '删除 sprite' : 'Delete sprite', message: res.error || '' });
    }
  }, [cfg.activeSpriteId, zh]);

  /* ---------- 3D 形象操作 ---------- */
  const handleImport = useCallback(async () => {
    const api = getPetIpc();
    if (!api) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await api.importGlb();
      if (res.ok) {
        const list = await api.listCustomSkins();
        if (list.ok) petConfig.set('customSkins', list.skins);
        petConfig.set('skin', res.skin.id);
      } else if (res.error !== 'cancelled') {
        setImportError(res.error);
      }
    } catch (err: any) {
      setImportError(err?.message ?? String(err));
    } finally {
      setImporting(false);
    }
  }, []);

  const handleDeleteCustom = useCallback(async (skinId: string) => {
    const api = getPetIpc();
    if (!api) return;
    if (!(await confirmAsync({ title: zh ? '删除这只宠物?' : 'Delete this pet?', message: zh ? '此操作不可撤销。' : 'This cannot be undone.', variant: 'danger', confirmLabel: zh ? '删除' : 'Delete' }))) return;
    const res = await api.deleteCustomSkin(skinId);
    if (res.ok) {
      const list = await api.listCustomSkins();
      if (list.ok) petConfig.set('customSkins', list.skins);
      if (cfg.skin === skinId) petConfig.set('skin', 'robo-orange');
    } else {
      dispatchOpFailed({ op: zh ? '删除宠物' : 'Delete pet', message: res.error || '' });
    }
  }, [cfg.skin, zh]);

  /* ---------- 2D 操作 ---------- */
  const handleRoll2D = useCallback(() => {
    const spec = randomPet2DSpec();
    petConfig.set('savedPet2Ds', [...cfg.savedPet2Ds, spec]);
    petConfig.set('active2DId', spec.id);
  }, [cfg.savedPet2Ds]);

  const handleUse2D = useCallback((id: string) => {
    petConfig.set('active2DId', id);
  }, []);

  const handleDelete2D = useCallback(async (id: string) => {
    if (!(await confirmAsync({ title: zh ? '删除这只宠物?' : 'Delete this pet?', message: zh ? '此操作不可撤销。' : 'This cannot be undone.', variant: 'danger', confirmLabel: zh ? '删除' : 'Delete' }))) return;
    const remaining = cfg.savedPet2Ds.filter((s) => s.id !== id);
    petConfig.set('savedPet2Ds', remaining);
    if (cfg.active2DId === id) {
      petConfig.set('active2DId', remaining[0]?.id ?? null);
    }
  }, [cfg.savedPet2Ds, cfg.active2DId, zh]);

  /* ---------- 当前选中形象 (用于预览) ---------- */
  const activeBuiltin = PET_CANDIDATES.find((c) => c.id === cfg.skin) ?? PET_CANDIDATES[0];
  const activeCustom = cfg.customSkins.find((s) => s.id === cfg.skin);
  const activePreviewUrl = activeCustom
    ? `neox-pet://local/${activeCustom.fileName}`
    : activeBuiltin.url;
  const activePreviewHue = activeCustom ? 0 : (activeBuiltin.hueShift ?? 0);

  return (
    <div className={embedded ? 'pet-settings-panel pet3' : 'settings-panel-content pet-settings-panel pet3'}>
      {/* ==================== 页头 ==================== */}
      {!embedded && (
        <>
          <PageTitle
            title={zh ? '宠物' : 'Pet'}
            subtitle={zh ? '陪你干活的小家伙' : 'A little helper that keeps you company while you work'}
          />
          <section className={`mfs-hero pet2-hero is-${choice}`}>
            <div className="pet2-hero__stage" aria-hidden="true">
              {choice === 'cat' || choice === 'corgi' ? (
                <div className="pet-mascot-preview pet2-hero__pet">
                  <img src={choice === 'cat' ? catBase : corgiBase} alt="" draggable={false} />
                  <MascotEyes species={choice} />
                </div>
              ) : choice === 'open' ? (
                <div className="pet2-hero__pet"><NeoxPetSvg mood="idle" size={112} variant={cfg.svgVariant} gaze={false} /></div>
              ) : (
                <span className="pet-card__placeholder-mark" />
              )}
            </div>
            <div className="mfs-hero__text">
              <h3>{choice === 'off'
                ? (zh ? '现在没有宠物' : 'No pet right now')
                : choice === 'open'
                  ? (zh ? '开源桌宠陪着你' : 'The open-source pet is on duty')
                  : (zh ? `${choice === 'cat' ? '猫' : '柯基'}陪着你写` : `The ${choice} keeps you company`)}</h3>
              <p>{choice === 'off'
                ? (zh ? '从下面选一只。' : 'Pick one below.')
                : choice === 'open'
                  ? (zh ? '住在桌面角落的悬浮窗里。' : 'Lives in a floating window in the screen corner.')
                  : (zh ? '住在输入框旁。' : 'Lives beside the composer.')}</p>
              {(choice === 'cat' || choice === 'corgi') && (
                <div className="pet2-chips">
                  {(zh
                    ? ['打字时凑过来看', '任务完成会庆祝', '点它挥手', '按住拖动', '右键换一只']
                    : ['Watches you type', 'Celebrates when done', 'Click to wave', 'Drag to move', 'Right-click to switch']
                  ).map((s) => <span key={s}>{s}</span>)}
                </div>
              )}
            </div>
            {(choice === 'cat' || choice === 'corgi') && (
              <label className="sa2-sub pet2-hero__move">
                <Switch checked={!mascot.stayPut} aria-label={zh ? '允许动作' : 'Allow moving'} onChange={() => mascot.setStayPut(!mascot.stayPut)} />
                <span>{zh ? '允许动作' : 'Allow moving'}</span>
              </label>
            )}
          </section>
        </>
      )}

      {/* ==================== 选择宠物 ====================
          自研的猫 / 柯基住在输入框旁; 开源桌宠是第三方形象, 住在桌面角落的悬浮窗里。
          同一时间只开一只 (choose() 负责互斥)。 */}
      <div className="settings-section pet2-choose" id="setting-mascot">
        <div className="section-title">{zh ? '选择宠物' : 'Choose a pet'}</div>
        <div className="pet-card-grid" role="radiogroup" aria-label={zh ? '选择宠物' : 'Choose a pet'}>
          {([
            ['cat', zh ? '猫' : 'Cat', catBase],
            ['corgi', zh ? '柯基' : 'Corgi', corgiBase],
          ] as Array<[MascotSpecies, string, string]>).map(([k, label, art]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={choice === k}
              className={`pet-card ${choice === k ? 'is-active' : ''}`}
              onClick={() => choose(k)}
            >
              {choice === k && <span className="pet-card__active-badge">{zh ? '当前' : 'Active'}</span>}
              <div className="pet-card__visual pet-card__visual--mascot" aria-hidden="true">
                <div className="pet-mascot-preview">
                  <img src={art} alt="" draggable={false} />
                  <MascotEyes species={k} />
                </div>
              </div>
              <div className="pet-card__title">{label}</div>
              <div className="pet-card__sub">{zh ? 'Neox 自研 · 输入框旁' : 'By Neox · beside the composer'}</div>
            </button>
          ))}
          {openPetAvailable && (
            <button
              type="button"
              role="radio"
              aria-checked={choice === 'open'}
              className={`pet-card ${choice === 'open' ? 'is-active' : ''}`}
              onClick={() => choose('open')}
            >
              {choice === 'open' && <span className="pet-card__active-badge">{zh ? '当前' : 'Active'}</span>}
              <div className="pet-card__visual pet-card__visual--neo" aria-hidden="true">
                <NeoxPetSvg mood="idle" size={72} variant={cfg.svgVariant} gaze={false} />
              </div>
              <div className="pet-card__title">{zh ? '开源桌宠' : 'Open-source pet'}</div>
              <div className="pet-card__sub">{zh ? '第三方形象 · 桌面角落' : 'Third-party · screen corner'}</div>
            </button>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={choice === 'off'}
            className={`pet-card ${choice === 'off' ? 'is-active' : ''}`}
            onClick={() => choose('off')}
          >
            {choice === 'off' && <span className="pet-card__active-badge">{zh ? '当前' : 'Active'}</span>}
            <div className="pet-card__visual" aria-hidden="true">
              <span className="pet-card__placeholder-mark" />
            </div>
            <div className="pet-card__title">{zh ? '不显示' : 'Off'}</div>
            <div className="pet-card__sub">{zh ? '不占用任何资源' : 'Uses no resources'}</div>
          </button>
        </div>
        {embedded && (choice === 'cat' || choice === 'corgi') && (<>
          <p className="setting-desc pet-section-desc">
            {zh
              ? '打字时它会凑过来看你写什么，发送后回到角落等回复，任务做完会庆祝一下。点它会挥手，按住可以沿输入框拖到别的位置；右键可以换一只或隐藏。'
              : 'It scoots over to watch you type, settles in its corner while the reply comes in, and celebrates when a task is done. Click to say hi, drag it along the composer to move its spot; right-click to switch or hide.'}
          </p>
          <div className="settings-list">
            <ToggleRow
              label={zh ? '允许动作' : 'Allow moving'}
              desc={zh ? '关掉后它一直趴在角落，不跟着光标走，也不跑来跑去。' : 'When off, it stays in its corner: no following the caret, no running about.'}
              checked={!mascot.stayPut}
              onChange={() => mascot.setStayPut(!mascot.stayPut)}
            />
          </div>
        </>)}
      </div>

      {choice === 'open' && (<>
      {/* ==================== 基础 ==================== */}
      <div className="settings-section">
        <div className="section-title">{zh ? '基础' : 'General'}</div>
        <div className="settings-list">
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{zh ? '风格' : 'Style'}</span>
              <span className="setting-desc">
                {zh
                  ? '灵动矢量：零素材。角色：导入形象。'
                  : 'Vector spirit (zero assets) · Character (import polished art, community packs).'}
              </span>
            </div>
            <div className="seg-control" role="radiogroup">
              {PET_RENDERERS.filter((r) => isRendererAvailable(r.id, cfg.enabledPlugins)).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={cfg.mode === r.id}
                  className={`seg-control__btn ${cfg.mode === r.id ? 'is-active' : ''}`}
                  onClick={() => petConfig.set('mode', r.id)}
                >
                  {zh ? r.label.zh : r.label.en}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{zh ? '大小' : 'Size'}</span>
              <span className="setting-desc">
                {zh ? '在桌面上的显示尺寸.' : 'Display size on your desktop.'}
              </span>
            </div>
            <div className="seg-control" role="radiogroup">
              {(['sm', 'md', 'lg'] as PetSize[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={cfg.size === s}
                  className={`seg-control__btn ${cfg.size === s ? 'is-active' : ''}`}
                  onClick={() => petConfig.set('size', s)}
                >
                  {s === 'sm' ? (zh ? '小' : 'S') : s === 'md' ? (zh ? '中' : 'M') : (zh ? '大' : 'L')}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{zh ? '初始位置' : 'Initial Corner'}</span>
              <span className="setting-desc">
                {zh ? '首次开启时桌宠出现的位置. 之后随便拖到哪都行, 不会自动回弹.' : 'Where the pet appears on first launch. After that, drag anywhere — it stays where you drop it.'}
              </span>
            </div>
            <div className="seg-control" role="radiogroup">
              {(['tl', 'tr', 'bl', 'br'] as PetCorner[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={cfg.corner === c}
                  className={`seg-control__btn ${cfg.corner === c ? 'is-active' : ''}`}
                  onClick={() => petConfig.set('corner', c)}
                  title={zh
                    ? (c === 'tl' ? '左上' : c === 'tr' ? '右上' : c === 'bl' ? '左下' : '右下')
                    : (c === 'tl' ? 'Top left' : c === 'tr' ? 'Top right' : c === 'bl' ? 'Bottom left' : 'Bottom right')}
                >
                  {c === 'tl' ? '↖' : c === 'tr' ? '↗' : c === 'bl' ? '↙' : '↘'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ==================== 形象 — 灵动 (SVG) ==================== */}
      {cfg.mode === 'svg' && (
        <div className="settings-section">
          <div className="section-title">{zh ? '形象' : 'Character'}</div>
          <p className="setting-desc pet-section-desc">
            {zh
              ? 'Neo — 会眨眼、呼吸, 眼睛跟着鼠标走. 选配色:'
              : 'Neo — blinks, breathes, eyes follow the cursor. Pick a color:'}
          </p>
          <div className="pet-card-grid">
            {NEO_VARIANTS.map((nv) => {
              const isActive = cfg.svgVariant === nv.id;
              return (
                <button
                  key={nv.id}
                  type="button"
                  className={`pet-card ${isActive ? 'is-active' : ''}`}
                  onClick={() => petConfig.set('svgVariant', nv.id)}
                >
                  {isActive && <span className="pet-card__active-badge">{zh ? '当前' : 'Active'}</span>}
                  <div className="pet-card__visual pet-card__visual--neo">
                    <NeoxPetSvg mood="idle" size={84} variant={nv.id} gaze={false} />
                  </div>
                  <div className="pet-card__title">{zh ? nv.name : nv.nameEn}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ==================== 形象 — 3D ==================== */}
      {cfg.mode === '3d' && (
        <div className="settings-section">
          <div className="section-title">{zh ? '形象' : 'Character'}</div>

          <div className="pet-skin-tabs">
            <button
              type="button"
              className={`pet-skin-tabs__btn ${skinTab === 'builtin' ? 'is-active' : ''}`}
              onClick={() => setSkinTab('builtin')}
            >
              {zh ? '内置' : 'Built-in'}
            </button>
            <button
              type="button"
              className={`pet-skin-tabs__btn ${skinTab === 'custom' ? 'is-active' : ''}`}
              onClick={() => setSkinTab('custom')}
            >
              {zh ? '我的' : 'My Pets'}
              {cfg.customSkins.length > 0 && (
                <span className="pet-skin-tabs__count">({cfg.customSkins.length})</span>
              )}
            </button>
          </div>

          {skinTab === 'builtin' && (
            <div className="pet-card-grid">
              {PET_CANDIDATES.map((c) => {
                const isActive = cfg.skin === c.id;
                /* 用 hueShift 派生卡片色块的色调 (跟实际宠物色一致, 用户一眼对得上) */
                const baseHue = (30 + (c.hueShift ?? 0) * 360) % 360;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`pet-card ${isActive ? 'is-active' : ''}`}
                    onClick={() => petConfig.set('skin', c.id)}
                  >
                    {isActive && <span className="pet-card__active-badge">{zh ? '当前' : 'Active'}</span>}
                    <div className="pet-card__visual">
                      <div
                        className="pet-card__swatch"
                        style={{
                          ['--swatch-light' as any]: `hsl(${baseHue}, 95%, 70%)`,
                          ['--swatch-base' as any]: `hsl(${baseHue}, 80%, 50%)`,
                          ['--swatch-dark' as any]: `hsl(${baseHue}, 70%, 30%)`,
                        }}
                      />
                    </div>
                    <div className="pet-card__title">{zh ? c.name : c.nameEn}</div>
                    <div className="pet-card__sub">{c.personality}</div>
                  </button>
                );
              })}
            </div>
          )}

          {skinTab === 'custom' && (
            <>
              <div className="pet-action-bar">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleImport}
                  disabled={importing}
                >
                  {importing
                    ? (zh ? '导入中…' : 'Importing…')
                    : (zh ? '+ 导入模型' : '+ Import Model')}
                </button>
                <span className="pet-action-bar__hint">
                  {zh ? '支持 .glb 文件, 上限 20MB.' : 'Supports .glb files, max 20MB.'}
                </span>
              </div>

              {importError && (
                <div className="pet-error-banner">
                  {zh ? '导入失败: ' : 'Import failed: '}{importError}
                </div>
              )}

              {cfg.customSkins.length === 0 ? (
                <div className="pet-empty">
                  {zh
                    ? '还没有自定义宠物。从 quaternius.com 或 poly.pizza 等免费资源站下载 .glb 模型, 上面导入即可使用。'
                    : 'No custom pets yet. Download a free .glb model from quaternius.com / poly.pizza and import above.'}
                </div>
              ) : (
                <div className="pet-card-grid">
                  {cfg.customSkins.map((skin) => {
                    const isActive = cfg.skin === skin.id;
                    return (
                      <div
                        key={skin.id}
                        className={`pet-card pet-card--static ${isActive ? 'is-active' : ''}`}
                      >
                        {isActive && <span className="pet-card__active-badge">{zh ? '当前' : 'Active'}</span>}
                        <div className="pet-card__visual">
                          <div className="pet-card__swatch" style={{
                            ['--swatch-light' as any]: '#cbd5e1',
                            ['--swatch-base' as any]: '#64748b',
                            ['--swatch-dark' as any]: '#334155',
                          }} />
                        </div>
                        <div className="pet-card__title" title={skin.name}>{skin.name}</div>
                        <div className="pet-card__actions">
                          {!isActive && (
                            <button
                              type="button"
                              className="pet-card__action"
                              onClick={() => petConfig.set('skin', skin.id)}
                            >
                              {zh ? '选用' : 'Use'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="pet-card__action pet-card__action--danger"
                            onClick={() => handleDeleteCustom(skin.id)}
                          >
                            {zh ? '删除' : 'Delete'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* 3D 形象在桌宠窗口里实时渲染; 设置页不再内嵌实时 3D 预览, 避免把 three 打进主程序.
           * (3D 是按需下载的插件, 渲染发生在 pet3d 窗口) */}
          {cfg.enabled && (
            <div className="pet-preview-stage">
              <div className="pet-preview-stage__content">
                <div className="pet-preview-stage__cube" aria-hidden="true" />
                <div>{zh ? '3D 形象会在桌面上的桌宠窗口实时显示' : 'The 3D character renders live in the desktop pet window'}</div>
                <div className="pet-preview-stage__note">
                  {zh ? '选好形象, 看右下角桌宠即可' : 'Pick a character and check the pet on your desktop'}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================== 随机伙伴 — 2D ==================== */}
      {cfg.mode === '2d' && (
        <div className="settings-section">
          <div className="section-title">{zh ? '随机伙伴' : 'Random Friends'}</div>

          <div className="pet-action-bar">
            <button
              type="button"
              className="btn-primary"
              onClick={handleRoll2D}
            >
              <span className="pet-roll-mark" aria-hidden="true" />
              {zh ? '抽一只新的' : 'Roll New'}
            </button>
            <span className="pet-action-bar__hint">
              {zh
                ? '每只都独一无二, 想抽多少抽多少.'
                : 'Each one is unique — roll as many as you like.'}
            </span>
          </div>

          {cfg.savedPet2Ds.length === 0 ? (
            <div className="pet-empty">
              {/* 插画是**一个空的展示台**, 不是一只宠物 —— 画只生物就得引入一套
                  全新的造型语言 (眼睛/毛发/表情), 跟这套等距几何是两回事。
                  "台子上还空着"本身就是这个空态要说的话。 */}
              <img className="nx-illus" src={NeoxIllus.pet} alt="" aria-hidden draggable={false} />
              <div>{zh
                ? '还没有伙伴。点上面的「抽一只新的」开始收集你的桌宠。'
                : 'No friends yet. Click "Roll New" above to start your collection.'}</div>
            </div>
          ) : (
            <div className="pet-card-grid">
              {cfg.savedPet2Ds.map((spec) => {
                const isActive = cfg.active2DId === spec.id;
                return (
                  <div
                    key={spec.id}
                    className={`pet-card pet-card--static ${isActive ? 'is-active' : ''}`}
                  >
                    {isActive && <span className="pet-card__active-badge">{zh ? '当前' : 'Active'}</span>}
                    <div className="pet-card__visual">
                      <Pet2DSprite spec={spec} mood="idle" size={80} />
                    </div>
                    <div className="pet-card__title" title={spec.name}>{spec.name}</div>
                    <div className="pet-card__actions">
                      {!isActive && (
                        <button
                          type="button"
                          className="pet-card__action"
                          onClick={() => handleUse2D(spec.id)}
                        >
                          {zh ? '选用' : 'Use'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="pet-card__action pet-card__action--danger"
                        onClick={() => handleDelete2D(spec.id)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ==================== Sprite 模式: 像素形象 ==================== */}
      {cfg.mode === 'sprite' && (
        <div className="settings-section">
          <div className="section-title">{zh ? '角色形象' : 'Character'}</div>
          <p className="setting-desc pet-section-desc">
            {zh
              ? '换成一张角色图，站立/走/跳/招手/出错共 9 种动作。'
              : 'Swap in a character sprite with 9 states (idle / walk / jump / wave / error).'}
          </p>

          <div className="pet-card-grid">
            {SPRITE_CANDIDATES.map((c) => {
              const isActive = cfg.activeSpriteId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`pet-card ${isActive ? 'is-active' : ''}`}
                  onClick={() => handleUseSprite(c.id)}
                >
                  {isActive && <span className="pet-card__active-badge">{zh ? '当前' : 'Active'}</span>}
                  <div className="pet-card__visual">
                    <PetSpriteSheet url={c.url} state="idle" size={80} />
                  </div>
                  <div className="pet-card__title">{zh ? c.name : c.nameEn}</div>
                  <div className="pet-card__sub">{c.description}</div>
                </button>
              );
            })}
          </div>

          <div className="pet-action-bar pet-action-bar--spaced">
            <button
              type="button"
              className="btn-primary"
              onClick={handleImportSprite}
              disabled={spriteImporting}
            >
              {spriteImporting
                ? (zh ? '导入中…' : 'Importing…')
                : (zh ? '+ 导入 sprite (.webp / .png)' : '+ Import sprite (.webp/.png)')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleImportPetBundle}
              disabled={spriteImporting}
              title={zh
                ? '导入一个宠物包 (.zip 或文件夹, 含一张 sprite 图 + 一个说明文件). 兼容社区常见的桌宠包格式.'
                : 'Import a pet pack (.zip or folder with a sprite sheet + a manifest). Compatible with common community pet pack formats.'}
            >
              {zh ? '+ 导入宠物包 (.zip)' : '+ Import pet pack (.zip)'}
            </button>
            <span className="pet-action-bar__hint">
              {zh
                ? '8×9 网格 sprite sheet (宽能被 8 整除、高能被 9 整除, 任意分辨率), 上限 20MB.'
                : '8×9 grid sprite sheet (width ÷8, height ÷9, any resolution), max 20MB.'}
            </span>
          </div>

          {spriteImportError && (
            <div className="pet-error-banner pet-error-banner--spaced">
              {zh ? '导入失败: ' : 'Import failed: '}{spriteImportError}
            </div>
          )}

          {discovered.length > 0 && (
            <>
              <div className="section-title pet-subsection-title">
                {zh ? '检测到已装好的' : 'Found on this machine'}
              </div>
              <p className="setting-desc pet-section-desc">
                {zh
                  ? '装在本机的桌宠，点「添加」收进来。'
                  : 'Pets installed on this machine — click Add to bring them in.'}
              </p>
              <div className="pet-card-grid">
                {discovered.map((pk) => {
                  const already = cfg.customSprites.some((s) => s.name === pk.displayName);
                  return (
                    <div key={pk.id} className="pet-card pet-card--static">
                      <div className="pet-card__visual">
                        {pk.previewDataUrl
                          ? <img src={pk.previewDataUrl} alt={pk.displayName} className="pet-card__visual-img" />
                          : <span className="pet-card__placeholder-mark" aria-hidden="true" />}
                      </div>
                      <div className="pet-card__title" title={pk.id}>{pk.displayName}</div>
                      {pk.description && <div className="pet-card__sub">{pk.description}</div>}
                      <div className="pet-card__actions">
                        <button
                          type="button"
                          className="pet-card__action"
                          onClick={() => handleAddDiscovered(pk.dir)}
                          disabled={spriteImporting}
                        >
                          {already ? (zh ? '再次添加' : 'Add again') : (zh ? '添加' : 'Add')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {cfg.customSprites.length > 0 && (
            <>
              <div className="section-title pet-subsection-title">
                {zh ? '我导入的形象' : 'My characters'}
              </div>
              <div className="pet-card-grid">
                {cfg.customSprites.map((sp) => {
                  const isActive = cfg.activeSpriteId === sp.id;
                  return (
                    <div
                      key={sp.id}
                      className={`pet-card pet-card--static ${isActive ? 'is-active' : ''}`}
                    >
                      {isActive && <span className="pet-card__active-badge">{zh ? '当前' : 'Active'}</span>}
                      <div className="pet-card__visual">
                        <PetSpriteSheet
                          url={`neox-pet://local/sprite/${sp.fileName}`}
                          state="idle"
                          size={80}
                          atlas={
                            sp.cellWidth && sp.cellHeight
                              ? { cols: 8, rows: 9, cellWidth: sp.cellWidth, cellHeight: sp.cellHeight }
                              : undefined
                          }
                        />
                      </div>
                      <div className="pet-card__title" title={sp.name}>{sp.name}</div>
                      <div className="pet-card__actions">
                        {!isActive && (
                          <button
                            type="button"
                            className="pet-card__action"
                            onClick={() => handleUseSprite(sp.id)}
                          >
                            {zh ? '选用' : 'Use'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="pet-card__action pet-card__action--danger"
                          onClick={() => handleDeleteSprite(sp.id)}
                        >
                          {zh ? '删除' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ==================== 渲染器扩展 (插件) ==================== */}
      {isAdvancedLevel && <div className="settings-section">
        <div className="section-title">{zh ? '渲染器扩展' : 'Renderer Plugins'}</div>
        <p className="setting-desc pet-section-desc">
          {zh
            ? '3D 这类更重的形象要先启用，不启用不占内存。'
            : 'Only Neo and Character are built in. Heavier ones like 3D must be enabled here first; they use no memory until you do.'}
        </p>
        <div className="settings-list">
          {PET_RENDERER_PLUGINS.map((r) => {
            const on = cfg.enabledPlugins.includes(r.id);
            const busy = pluginBusy === r.id;
            /* 插件包没发布 → 置灰 + 说清楚, 别让用户点了才看到「下载失败 404」 */
            const avail = isPetRendererPluginAvailable(r.id);
            const gateReason = avail ? undefined : (zh ? r.unavailable!.zh : r.unavailable!.en);
            return (
              <div className={`setting-row${avail ? '' : ' is-unavailable'}`} key={r.id} title={gateReason}>
                <div className="setting-info">
                  <span className="setting-label">
                    {zh ? r.label.zh : r.label.en}
                    {r.sizeHint && <span className="pet-plugin-meta">  ·  {r.sizeHint}</span>}
                    {busy && <span className="pet-plugin-status">  ·  {zh ? '下载中…' : 'Downloading…'}</span>}
                    {!avail && <span className="pet-plugin-gate">{zh ? '暂不支持' : 'N/A'}</span>}
                  </span>
                  <span className="setting-desc">{gateReason ?? (zh ? r.desc.zh : r.desc.en)}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={on && avail}
                    onChange={(e) => handleTogglePlugin(r.id, e.target.checked)}
                    disabled={busy || !avail}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            );
          })}
        </div>
        {pluginError && (
          <div className="pet-error-banner pet-error-banner--spaced">
            {zh ? '插件启用失败: ' : 'Plugin enable failed: '}{pluginError}
          </div>
        )}
      </div>}

      {/* ==================== 反应行为 ==================== */}
      {isAdvancedLevel && <div className="settings-section">
        <div className="section-title">{zh ? '反应行为' : 'Reactions'}</div>
        <div className="settings-list">
          <ToggleRow
            label={zh ? '说话气泡' : 'Speech Bubble'}
            desc={zh ? '助手在说话时, 桌宠头顶浮一个简短气泡.' : 'Show a short bubble above the pet when the assistant speaks.'}
            checked={cfg.speechBubble}
            onChange={() => petConfig.toggle('speechBubble')}
          />
          <ToggleRow
            label={zh ? '任务进度' : 'Task Progress'}
            desc={zh ? '助手列出步骤时, 桌宠身边显示完成进度.' : 'Show step progress beside the pet during multi-step tasks.'}
            checked={cfg.showPlanProgress}
            onChange={() => petConfig.toggle('showPlanProgress')}
          />
          <ToggleRow
            label={zh ? '完成时庆祝' : 'Celebrate on Done'}
            desc={zh ? '任务跑完, 桌宠做开心动作 + 提示气泡.' : 'Pet does a happy animation when a task finishes.'}
            checked={cfg.reactOnTaskComplete}
            onChange={() => petConfig.toggle('reactOnTaskComplete')}
          />
          <ToggleRow
            label={zh ? '出错时提醒' : 'Alert on Error'}
            desc={zh ? '出错时桌宠抖动一下并显示提示, 不打扰主流程.' : 'Pet wiggles to catch your eye when something fails — without breaking your flow.'}
            checked={cfg.reactOnError}
            onChange={() => petConfig.toggle('reactOnError')}
          />
          <ToggleRow
            label={zh ? '闲时小动作' : 'Idle Animations'}
            desc={zh ? '没事的时候, 桌宠自己眨眼/伸懒腰. 关掉可省电.' : 'Pet blinks and stretches when idle. Turn off to save power.'}
            checked={cfg.idleAnimations}
            onChange={() => petConfig.toggle('idleAnimations')}
          />
        </div>
      </div>}

      <div className="settings-section">
        <div className="section-title">{zh ? '重置' : 'Reset'}</div>
        <div className="settings-list">
          {/* "永远置顶" 开关已移除: 旧开关 hardcoded disabled + petWindowFactory 写死
              alwaysOnTop:true 从不读 cfg.alwaysOnTop, 是个点不动也无效的死开关。
              桌宠实际行为本就是恒置顶, 行为不变, 只去掉误导控件。 */}
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-label">{zh ? '恢复默认' : 'Reset to Defaults'}</span>
              <span className="setting-desc">
                {zh ? '清空所有桌宠选择并关闭桌宠.' : 'Clear all pet choices and turn pet off.'}
              </span>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => { void (async () => {
                if (await confirmAsync({ title: zh ? '重置所有桌宠设置?' : 'Reset all pet settings?', message: zh ? '清空所有桌宠选择并关闭桌宠。' : 'Clears all pet choices and turns pet off.', variant: 'danger', confirmLabel: zh ? '重置' : 'Reset' })) {
                  petConfig.reset();
                }
              })(); }}
            >
              {zh ? '重置' : 'Reset'}
            </button>
          </div>
        </div>
      </div>
      </>)}
    </div>
  );
};

/* ---------- 共用 toggle 行 ---------- */
const ToggleRow: React.FC<{
  label: string;
  desc: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}> = ({ label, desc, checked, onChange, disabled }) => (
  <div className="setting-row">
    <div className="setting-info">
      <span className="setting-label">{label}</span>
      <span className="setting-desc">{desc}</span>
    </div>
    <label className="toggle-switch">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="toggle-slider"></span>
    </label>
  </div>
);

export default PetTab;

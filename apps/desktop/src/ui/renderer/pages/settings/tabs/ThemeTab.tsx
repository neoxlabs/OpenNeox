import React, { useMemo, useState } from 'react';
import { useAppStore } from '../../../../state/appStore';
import {
  THEME_PACKS,
  CATEGORY_INFO,
  packsByCategory,
  type ThemePack,
  type ThemePackCategory,
} from '../../../../state/themePacks';
import { useMotionPreference, isMotionAutoDowngraded, detectWeakMachine, type MotionMode } from '../../../state/motionPreferences';
import { useI18n, setGlobalLanguage } from '../../../hooks/useI18n';
import { useIsAdvancedLevel } from '../../../state/settingsLevel';
import Icons from '../../../components/Icons';
import { PageTitle } from '../../../components/settings-base';
import { ThemePackThumb } from './ThemePackThumb';
import './ThemeTab.css';
import './ThemeTab.clay.css';

const ORDERED_CATEGORIES: ThemePackCategory[] = ['basic', 'classic', 'ink', 'aurora', 'cyber'];


/* 一张主题包卡片 */
const ThemePackCard: React.FC<{
  pack: ThemePack;
  isActive: boolean;
  isHovered: boolean;
  onClick: () => void;
  onHover: (pack: ThemePack | null) => void;
  language: 'zh' | 'en';
}> = ({ pack, isActive, onClick, onHover, language }) => {
  const labelColor = pack.mode === 'dark' || pack.swatch[2].toLowerCase() === pack.swatch[0].toLowerCase()
    ? '#ffffff'
    : '#1f2a37';
  return (
    <button
      type="button"
      className={`theme-pack-card ${isActive ? 'is-active' : ''}`}
      onClick={onClick}
      onMouseEnter={() => onHover(pack)}
      onMouseLeave={() => onHover(null)}
      aria-pressed={isActive}
    >
      <div
        className="theme-pack-card__art"
        style={{
          '--pack-bg': pack.swatch[0],
          '--pack-mid': pack.swatch[1],
          '--pack-accent': pack.swatch[2],
          '--pack-label': labelColor,
        } as React.CSSProperties}
      >
        {/* 卡内: 底色渐变 + 主题 motif (SVG 简笔画) + 选中角标. 主题名走卡下方. */}
        <div className="theme-pack-card__gradient" />
        <ThemePackThumb packId={pack.id} />
        {isActive && (
          <div className="theme-pack-card__badge">{language === 'zh' ? '当前' : 'Current'}</div>
        )}
      </div>
      <div className="theme-pack-card__name">{language === 'zh' ? pack.name.zh : pack.name.en}</div>
      <div className="theme-pack-card__tagline">{language === 'zh' ? pack.tagline.zh : pack.tagline.en}</div>
    </button>
  );
};

const ThemeTab: React.FC = () => {
  const { language } = useI18n();
  const {
    themePackId,
    setThemePack,
    themeAppearanceMode,
    setThemeAppearanceMode,
  } = useAppStore();

  /* 动效档位 —— 设备级偏好, 不跟账号走 (见 motionPreferences.ts) */
  const isAdvancedLevel = useIsAdvancedLevel();
  const [motion, setMotion] = useMotionPreference();
  /* 低配机首启会被自动降一档 (standard)。降了要说出来, 不能静默 ——
     用户得知道"现在不是最丝滑档", 并且能自己切回去。 */
  const autoDowngraded = isMotionAutoDowngraded();
  const weakMachine = detectWeakMachine();

  /* hover 用于将来 mini 缩略图预览, 暂时只保留状态 (不影响渲染) */
  const [hoverPack, setHoverPack] = useState<ThemePack | null>(null);

  const grouped = useMemo(() => packsByCategory(THEME_PACKS), []);
  const zh = language === 'zh';

  /* 默认露出的组: 基础 + 当前主题所在组 (当前在基础里就露排第二的那组); 其余点「更多主题」 */
  const [showAllThemes, setShowAllThemes] = useState(false);
  const currentCategory = THEME_PACKS.find((p) => p.id === themePackId)?.category;
  const defaultCategories: ThemePackCategory[] = ['basic', currentCategory && currentCategory !== 'basic' ? currentCategory : ORDERED_CATEGORIES[1]];
  const visibleCategories = showAllThemes ? ORDERED_CATEGORIES : ORDERED_CATEGORIES.filter((c) => defaultCategories.includes(c));
  const hiddenCount = ORDERED_CATEGORIES.filter((c) => !defaultCategories.includes(c)).reduce((n, c) => n + grouped[c].length, 0);

  return (
    <div className="settings-panel-content th3">
      <PageTitle
        title={zh ? '界面' : 'Appearance'}
        subtitle={zh ? '语言、主题和动效' : 'Language, theme and motion'}
      />

      <div className="settings-list">
        {/* 全局一组: 语言 / 界面结构 / 外观模式 (UI 3.0 set-appearance3) */}
        <div className="theme-surface-group th3-group">
        <div className="theme-surface-card" id="setting-language">
          <span className="th3-ico" aria-hidden="true"><Icons.Globe /></span>
          <div className="theme-surface-card__copy">
            <div className="theme-surface-card__title">{zh ? '语言' : 'Language'}</div>
            <div className="theme-surface-card__desc">
              {zh ? '界面和 AI 回复一起切。' : 'Switches the interface and the AI replies together.'}
            </div>
          </div>
          <div className="theme-surface-toggle" role="radiogroup" aria-label={zh ? '语言' : 'Language'}>
            {([['zh', '中文'], ['en', 'EN']] as Array<['zh' | 'en', string]>).map(([v, label]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={language === v}
                className={`theme-surface-toggle__btn${language === v ? ' is-active' : ''}`}
                onClick={() => setGlobalLanguage(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 「桌面伙伴」(猫 / 柯基) 已并进「宠物」页, 跟开源桌宠放在同一个选择里。 */}


        <div className="theme-surface-card">
          <span className="th3-ico" aria-hidden="true"><Icons.Sun /></span>
          <div className="theme-surface-card__copy">
            <div className="theme-surface-card__title">{zh ? '外观模式' : 'Appearance'}</div>
            <div className="theme-surface-card__desc">
              {themeAppearanceMode === 'auto'
                ? (zh ? '按本地时间自动切明暗，6:00–18:00 用浅色。' : 'Follows local time — light from 6:00 to 18:00.')
                : (zh ? '固定用下面选中的主题。' : 'Always uses the theme picked below.')}
            </div>
          </div>
          <div className="theme-surface-toggle" role="radiogroup" aria-label={zh ? '外观模式' : 'Appearance'}>
            <button
              type="button"
              role="radio"
              aria-checked={themeAppearanceMode === 'auto'}
              className={`theme-surface-toggle__btn${themeAppearanceMode === 'auto' ? ' is-active' : ''}`}
              onClick={() => setThemeAppearanceMode('auto')}
            >
              {zh ? '自动' : 'Auto'}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={themeAppearanceMode === 'manual'}
              className={`theme-surface-toggle__btn${themeAppearanceMode === 'manual' ? ' is-active' : ''}`}
              onClick={() => setThemeAppearanceMode('manual')}
            >
              {zh ? '手动' : 'Manual'}
            </button>
          </div>
        </div>
        </div>

        <div className="theme-appearance-head th3-head">
          <div className="theme-appearance-head__copy">
            <h3>{zh ? '主题' : 'Theme'}</h3>
          </div>
        </div>

        {visibleCategories.map((cat) => {
          const packs = grouped[cat];
          if (!packs.length) return null;
          const meta = CATEGORY_INFO[cat];
          return (
            <div key={cat} className={`theme-pack-category${themeAppearanceMode === 'auto' ? ' is-auto-dimmed' : ''}`}>
              <div className="theme-pack-category__head">
                <span className="theme-pack-category__title">{zh ? meta.zh : meta.en}</span>
                <span className="theme-pack-category__subtitle">
                  {themeAppearanceMode === 'auto'
                    ? (zh ? '点选任意主题会切到「手动」' : 'Picking a theme switches to Manual')
                    : (zh ? meta.subtitle.zh : meta.subtitle.en)}
                </span>
              </div>
              <div className="theme-pack-grid">
                {packs.map((pack) => (
                  <ThemePackCard
                    key={pack.id}
                    pack={pack}
                    isActive={themePackId === pack.id}
                    isHovered={hoverPack?.id === pack.id}
                    onClick={() => setThemePack(pack.id)}
                    onHover={setHoverPack}
                    language={language}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <button type="button" className="theme-more-toggle" onClick={() => setShowAllThemes((v) => !v)}>
            {showAllThemes
              ? (zh ? '收起' : 'Show fewer')
              : (zh ? `更多主题 (${hiddenCount})` : `More themes (${hiddenCount})`)}
          </button>
        )}

        <div className="th3-section-title">{zh ? '性能' : 'Performance'}</div>
        <div className="theme-surface-group th3-group">
          <div className="theme-surface-card">
            <span className="th3-ico" aria-hidden="true"><Icons.Zap /></span>
            <div className="theme-surface-card__copy">
              <div className="theme-surface-card__title">{zh ? '界面动效' : 'Motion'}</div>
              <div className="theme-surface-card__desc">
                {autoDowngraded
                  ? (zh
                    ? `已按这台机器的性能自动选了「标准」（${weakMachine.reason}）。切到「丝滑」可以恢复全部动效。`
                    : `Set to Standard for this machine's hardware (${weakMachine.reason}). Pick Silk to restore all motion.`)
                  : (zh
                    ? '机器卡就关掉。系统开了「减弱动态效果」时以系统为准。'
                    : 'Turn it off if the app feels slow. The system “Reduce motion” setting wins.')}
              </div>
            </div>
            <div className="theme-surface-toggle" role="radiogroup" aria-label={zh ? '界面动效' : 'Motion'}>
              {([
                ['off', zh ? '关闭' : 'Off'],
                ['standard', zh ? '标准' : 'Standard'],
                ['silk', zh ? '丝滑' : 'Silk'],
              ] as Array<[MotionMode, string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={motion === mode}
                  className={`theme-surface-toggle__btn${motion === mode ? ' is-active' : ''}`}
                  onClick={() => setMotion(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ThemeTab;

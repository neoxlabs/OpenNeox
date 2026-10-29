import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { getGlobalLanguage } from '../hooks/useI18n';
import { useEscClose } from '../hooks/useEscClose';
import { bodyOf, winOf } from '../utils/ownerDoc';
import '../styles/CustomSelect.css';

interface Option {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  /** 置灰且不可展开 — 对齐原生 select 的 disabled 语义 (探测中/保存中等场景) */
  disabled?: boolean;
  /** 关联 <label htmlFor>, 点标签能聚焦到触发器 */
  id?: string;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  onChange,
  options,
  placeholder,
  className = '',
  disabled = false,
  id,
}) => {
  const isZh = getGlobalLanguage() === 'zh';
  const effectivePlaceholder = placeholder ?? (isZh ? '请选择' : 'Select…');
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0, left: 0, minWidth: 0, maxWidth: 0, maxHeight: 340, dropUp: false,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(opt => opt.value === value);
  const displayValue = selectedOption?.label || effectivePlaceholder;

  // Filter options based on search term
  const filteredOptions = options.filter(opt =>
    opt.label.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Close dropdown when clicking outside.
  // 所以 outside 检测要同时排除 dropdownRef 子树, 否则点 dropdown 内部 (选项/搜索框)
  // 会被判成 outside → 立即关掉, 表现为 "点了下拉立即收回, 选不上".
  useEffect(() => {
    const handlePointerOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const inContainer = target ? containerRef.current?.contains(target) : false;
      const inDropdown = target ? dropdownRef.current?.contains(target) : false;
      if (!inContainer && !inDropdown) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    /* 控件在哪个窗口就听哪个窗口 (Surface 独立窗口里的服务配置表单也用它) */
    const doc = containerRef.current?.ownerDocument ?? document;
    if (isOpen) {
      doc.addEventListener('pointerdown', handlePointerOutside, true);
      // Focus the input when dropdown opens
      setTimeout(() => inputRef.current?.focus(), 0);
    }

    return () => {
      doc.removeEventListener('pointerdown', handlePointerOutside, true);
    };
  }, [isOpen]);

  /* Esc 关下拉 — 走 useEscClose 的 LIFO 栈: 在 modal 里展开时, 第一次 Esc 只收下拉,
   * 第二次 Esc 才轮到 modal; 也不会穿透到 SettingsPage 的整页 Esc 把设置一起关掉. */
  useEscClose(isOpen, () => {
    setIsOpen(false);
    setSearchTerm('');
  });

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
    setSearchTerm('');
  };

  const calculatePosition = () => {
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const window = winOf(containerRef.current);
    const DROPDOWN_MAX = 340;
    const gap = 6;
    const viewportPadding = 12;

    const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
    const spaceAbove = rect.top - gap - viewportPadding;

    const dropUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const avail = dropUp ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(120, Math.min(DROPDOWN_MAX, avail));

    const maxWidth = window.innerWidth - viewportPadding * 2;
    const minWidth = Math.min(Math.max(rect.width, 140), maxWidth);

    /* 靠右时按右边界收 —— 内容宽度未知, 用 minWidth 估一个不越界的左值 */
    const left = Math.min(Math.max(rect.left, viewportPadding), window.innerWidth - minWidth - viewportPadding);

    setDropdownPosition({
      top: dropUp ? rect.top - gap : rect.bottom + gap,
      left,
      minWidth,
      maxWidth,
      maxHeight,
      dropUp,
    });
  };

  const handleToggle = () => {
    if (disabled) return;
    if (!isOpen) {
      calculatePosition();
    }
    setIsOpen(!isOpen);
    if (!isOpen) {
      setSearchTerm('');
    }
  };

  /* disabled 在展开期间被切成 true (例如点了「重新测速」) 时必须主动收起,
   * 否则下拉浮层留在屏幕上而触发器已经不可交互。 */
  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
      setSearchTerm('');
    }
  }, [disabled, isOpen]);

  // Update dropdown position on scroll or resize
  useEffect(() => {
    if (!isOpen) return;
    const win = winOf(containerRef.current);

    win.addEventListener('scroll', calculatePosition, true);
    win.addEventListener('resize', calculatePosition);

    return () => {
      win.removeEventListener('scroll', calculatePosition, true);
      win.removeEventListener('resize', calculatePosition);
    };
  }, [isOpen]);

  return (
    <div
      className={`custom-select ${className} ${isOpen ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''}`}
      ref={containerRef}
    >
      <div
        id={id}
        className="custom-select-trigger"
        onClick={handleToggle}
        role="combobox"
        aria-expanded={isOpen}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        <span className={`custom-select-value ${!value ? 'placeholder' : ''}`}>
          {displayValue}
        </span>
        <svg
          className="custom-select-arrow"
          width="12"
          height="8"
          viewBox="0 0 12 8"
          fill="none"
        >
          <path
            d="M1 1.5L6 6.5L11 1.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          className={`custom-select-dropdown ${dropdownPosition.dropUp ? 'drop-up' : 'drop-down'}`}
          style={{
            top: dropdownPosition.dropUp ? undefined : `${dropdownPosition.top}px`,
            /* 往上翻时用 bottom 定位, 菜单才会随内容向上长而不是把顶边钉死 */
            bottom: dropdownPosition.dropUp
              ? `${winOf(containerRef.current).innerHeight - dropdownPosition.top}px`
              : undefined,
            left: `${dropdownPosition.left}px`,
            minWidth: `${dropdownPosition.minWidth}px`,
            maxWidth: `${dropdownPosition.maxWidth}px`,
            maxHeight: `${dropdownPosition.maxHeight}px`,
          }}
        >
          <div className="custom-select-search">
            <input
              ref={inputRef}
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={isZh ? '搜索...' : 'Search...'}
              className="custom-select-search-input"
              onClick={e => e.stopPropagation()}
            />
          </div>
          <div className="custom-select-options">
            {filteredOptions.length === 0 ? (
              <div className="custom-select-option disabled">{isZh ? '无匹配选项' : 'No matches'}</div>
            ) : (
              filteredOptions.map(option => (
                <div
                  key={option.value}
                  className={`custom-select-option ${value === option.value ? 'selected' : ''}`}
                  onClick={() => handleSelect(option.value)}
                >
                  {value === option.value && (
                    <svg
                      className="custom-select-check"
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                    >
                      <path
                        d="M3 8L6.5 11.5L13 5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                  <span>{option.label}</span>
                </div>
              ))
            )}
          </div>
        </div>,
        bodyOf(containerRef.current),
      )}
    </div>
  );
};

/**
 * 第一次看到网页成品时的「怎么带走」卡片。
 *
 * 用户多是老师 / 上班族: 做出来的网页要拷到教室电脑、会议室电脑上用。
 * 一段小动画讲三步: 存成一个文件 → 拷进 U 盘 → 那台电脑上双击用浏览器打开; 投屏点「演示」。
 * 只出一次 (localStorage 记住), 之后工具条上的「带走」「演示」一直在。
 */
import React from 'react';
import './html-takeaway.css';

export const TAKEAWAY_TIP_KEY = 'neox.htmlTakeawayTip.v1';

const Icon: React.FC<{ d: React.ReactNode }> = ({ d }) => (
  <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

export const TakeawayTip: React.FC<{ isZh: boolean; onSave: () => void; onClose: () => void }> = ({ isZh, onSave, onClose }) => (
  <div className="sfc-takeaway" role="dialog" aria-label={isZh ? '怎么把网页带走' : 'Take this page anywhere'}>
    <div className="sfc-takeaway__card">
      <div className="sfc-takeaway__title">{isZh ? '这个网页可以带走用' : 'Take this page anywhere'}</div>
      <div className="sfc-takeaway__flow" aria-hidden="true">
        <div className="sfc-takeaway__step s1">
          <Icon d={<><path d="M9 4h10l6 6v18H9z" /><path d="M19 4v6h6" /><path d="M13 17h8M13 21h6" /></>} />
          <span>{isZh ? '存成一个文件' : 'Save one file'}</span>
        </div>
        <div className="sfc-takeaway__arrow a1" />
        <div className="sfc-takeaway__step s2">
          <Icon d={<><rect x="10" y="10" width="12" height="18" rx="2" /><path d="M12 10V4h8v6" /><path d="M14 6.5h1.5M16.5 6.5H18" /></>} />
          <span>{isZh ? '拷进 U 盘' : 'Copy to USB'}</span>
        </div>
        <div className="sfc-takeaway__arrow a2" />
        <div className="sfc-takeaway__step s3">
          <Icon d={<><rect x="4" y="6" width="24" height="16" rx="1.5" /><path d="M12 27h8M16 22v5" /><path d="M13 12l6 2.5-6 2.5z" /></>} />
          <span>{isZh ? '那台电脑双击打开' : 'Double-click there'}</span>
        </div>
      </div>
      <p className="sfc-takeaway__text">
        {isZh
          ? '不用装软件、不用联网，任何电脑的浏览器都能打开。投屏时点右上角「演示」全屏，Esc 退出。'
          : 'No install, no internet — any browser opens it. Use "Present" for fullscreen, Esc to exit.'}
      </p>
      <div className="sfc-takeaway__actions">
        <button type="button" className="sfc-takeaway__ghost" onClick={onClose}>{isZh ? '知道了' : 'Got it'}</button>
        <button type="button" className="sfc-takeaway__primary" onClick={onSave}>{isZh ? '现在保存' : 'Save now'}</button>
      </div>
    </div>
  </div>
);

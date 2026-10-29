import React from 'react';
import { productLinks } from '../../utils/productLinks';
import { dispatchHint } from '../../components/notifyEvents';

export const FeedbackNavRow: React.FC<{ zh: boolean }> = ({ zh }) => (
  <button
    type="button"
    className="settings-level-row"
    onClick={() => {
      /* 打不开要给回音 —— 点了没反应用户会以为按钮坏了 */
      try {
        const opening = window.neox?.openExternal?.(productLinks.feedback);
        void opening?.catch(() =>
          dispatchHint(zh ? '打不开反馈页面' : 'Couldn’t open the feedback page', 'warning'));
      } catch { /* 没有 bridge 的宿主直接忽略 */ }
    }}
  >
    <span className="settings-level-row__label">{zh ? '反馈问题' : 'Send feedback'}</span>
  </button>
);

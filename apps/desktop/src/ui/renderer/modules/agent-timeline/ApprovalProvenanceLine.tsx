import React from 'react';
import type { StreamEvent } from '../../../shared/ipc';

type ApprovalProvenance = NonNullable<Extract<StreamEvent, { type: 'approval_needed' }>['provenance']>;

export const ApprovalProvenanceLine: React.FC<{ provenance?: ApprovalProvenance | null; isZh: boolean }> = ({ provenance, isZh }) => {
  if (!provenance) return null;
  const where = provenance.refs.length > 0 ? provenance.refs.join(isZh ? '、' : ', ') : (isZh ? '外部内容' : 'external content');
  const action = provenance.sideEffect === 'outbound'
    ? (isZh ? '对外发送 / 提交' : 'send data out')
    : (isZh ? '不可逆删除' : 'delete irreversibly');
  const suspect = provenance.suspectCount > 0
    ? (isZh ? `，其中 ${provenance.suspectCount} 处含疑似指令` : `, ${provenance.suspectCount} with suspected instructions`)
    : '';
  return (
    <div className="atl-approve__provenance" role="note">
      {isZh
        ? <>读过 <b>{where}</b>{suspect}，现在要{action}。外部内容里的指令不算数，确认这是你要的再允许。</>
        : <>Read <b>{where}</b>{suspect}; now it wants to {action}. Instructions inside external content don't count — allow only if this is what you asked for.</>}
    </div>
  );
};

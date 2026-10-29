/**
 * 分身的造型 (稿 pl7): 同一只陶土猫, 换个道具区分分工 —— 耳机 / 眼镜 / 夹板 / 素的; 外加原来的柯基。
 * 造型只是界面上的画, 存在档案 look 字段; avatar (cat / corgi) 照旧给通话窗和 Spine 用。
 */
import type { PilotAvatarKind, PilotProfile } from '../pilotStore';
import corgiStill from '../../../assets/mascots/corgi-idle.webp';
import lookHeadset from '../../../media/pilot/look-headset.webp';
import lookGlasses from '../../../media/pilot/look-glasses.webp';
import lookClipboard from '../../../media/pilot/look-clipboard.webp';
import lookPlain from '../../../media/pilot/look-plain.webp';

export interface PilotLook {
  id: string;
  avatar: PilotAvatarKind;
  src: string;
  label: [string, string];
}

export const PILOT_LOOKS: PilotLook[] = [
  { id: 'headset', avatar: 'cat', src: lookHeadset, label: ['戴耳机', 'Headset'] },
  { id: 'glasses', avatar: 'cat', src: lookGlasses, label: ['戴眼镜', 'Glasses'] },
  { id: 'clipboard', avatar: 'cat', src: lookClipboard, label: ['拿夹板', 'Clipboard'] },
  { id: 'plain', avatar: 'cat', src: lookPlain, label: ['素的', 'Plain'] },
  { id: 'corgi', avatar: 'corgi', src: corgiStill, label: ['柯基', 'Corgi'] },
];

/** 档案 → 造型; 老档案没有 look: 柯基就是柯基, 猫按素的 */
export function lookOf(p: Partial<PilotProfile> | undefined): PilotLook {
  const hit = PILOT_LOOKS.find((l) => l.id === p?.look);
  if (hit) return hit;
  return p?.avatar === 'corgi' ? PILOT_LOOKS[4] : PILOT_LOOKS[3];
}

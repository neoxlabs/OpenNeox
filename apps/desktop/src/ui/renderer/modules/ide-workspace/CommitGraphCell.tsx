import React from 'react';
import { laneColor, type GraphRow } from './commitGraph';

/** 一道多宽 (px) —— 跟 CSS 里 .gc__hitem 的 padding-left 算式共用这个数 */
export const LANE_W = 14;
/** 标题行多高 —— 必须跟 .gc__hitem-row 的实际高度一致, 否则节点不在文字中线上 */
export const ROW_H = 40;

const NODE_R = 3.5;
/* merge 的点画大一圈: 只做成空心的话跟普通提交一样大, 在 40px 行距下扫过去分不出来 ——
 * 而"哪些是合并"正是看历史时最先要认的东西。 */
const MERGE_R = 4.6;
const STROKE = 1.5;

export const CommitGraphCell: React.FC<{ row: GraphRow; width: number }> = ({ row, width }) => {
  const w = Math.max(1, width) * LANE_W;
  const cx = (lane: number) => lane * LANE_W + LANE_W / 2;
  const my = ROW_H / 2;
  const x = cx(row.lane);

  const lines: React.ReactNode[] = [];
  const key = (s: string) => `${s}-${lines.length}`;

  /* 穿过本行的道 —— 一条从顶通到底的竖线 */
  for (const t of row.through) {
    lines.push(
      <line key={key('t')} x1={cx(t)} y1={0} x2={cx(t)} y2="100%"
            stroke={laneColor(t)} strokeWidth={STROKE} />,
    );
  }

  /* 自己这道的上半段: 一律画。最上面那条多出来的一小截被列表顶部裁掉, 视觉上无害,
   * 比"该有线的地方断一截"好。 */
  lines.push(
    <line key={key('up')} x1={x} y1={0} x2={x} y2={my}
          stroke={laneColor(row.lane)} strokeWidth={STROKE} />,
  );

  /* 下半段: 有父才继续, 一直到本条的底 (展开时也通着) */
  if (row.hasParentLine) {
    lines.push(
      <line key={key('dn')} x1={x} y1={my} x2={x} y2="100%"
            stroke={laneColor(row.lane)} strokeWidth={STROKE} />,
    );
  }

  /* 汇合: 别的道从上面下来, 在本行的点并进来 */
  for (const m of row.merges) {
    const fx = cx(m.from);
    lines.push(
      <path key={key('m')} d={`M ${fx} 0 Q ${fx} ${my} ${x} ${my}`}
            fill="none" stroke={laneColor(m.from)} strokeWidth={STROKE} />,
    );
  }

  /* 分叉: 从本行的点斜下去到另一道 (merge 的第二个父), 落到 ROW_H 后继续通到底 */
  for (const f of row.forks) {
    const tx = cx(f.to);
    lines.push(
      <path key={key('f')} d={`M ${x} ${my} Q ${tx} ${my} ${tx} ${ROW_H}`}
            fill="none" stroke={laneColor(f.to)} strokeWidth={STROKE} />,
    );
    lines.push(
      <line key={key('fd')} x1={tx} y1={ROW_H} x2={tx} y2="100%"
            stroke={laneColor(f.to)} strokeWidth={STROKE} />,
    );
  }

  return (
    <svg className="gc__graph" width={w} height="100%" aria-hidden>
      {lines}
      {/* merge 画空心 —— 一眼区分"这是合进来的"和"这是一次普通提交" */}
      <circle
        cx={x} cy={my} r={row.isMerge ? MERGE_R : NODE_R}
        fill={row.isMerge ? 'var(--neox-bg-canvas, #1e1e1e)' : laneColor(row.lane)}
        stroke={laneColor(row.lane)}
        strokeWidth={row.isMerge ? 2 : 0}
      />
    </svg>
  );
};

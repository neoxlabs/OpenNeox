/**
 * 会话在哪儿跑 —— 侧栏会话行、时间线头部都要按它区分展示。
 *
 *   local         本机 (默认, 不画任何标记)
 *   cloud         云端运行中
 *   migrating     正在推到云端
 *   syncing-back  正在拉回本机
 *
 * 没有云端运行能力的构建里它恒为 local / undefined。
 */
export type CloudLocation = 'local' | 'cloud' | 'migrating' | 'syncing-back';

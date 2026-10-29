
import type { StepIconKind } from './types';

/* ---------- iconKind 映射 ---------- */
export const TOOL_TO_ICON: Record<string, StepIconKind> = {
  readfile: 'read',
  read_file: 'read',
  read: 'read',
  list_directory: 'folder',
  list_dir: 'folder',
  ls: 'folder',
  write_file: 'edit',
  write: 'edit',
  edit_file: 'edit',
  edit: 'edit',
  search: 'search',
  search_files: 'search',
  grep: 'search',
  glob: 'search',
  show_tree: 'project',
  tree: 'project',
  execute_bash: 'terminal',
  execute_shell: 'terminal',
  bash: 'terminal',
  shell: 'terminal',
  /* 不给的话 computer_run 会被下面 /run/ 那条正则捞进 terminal, 显示成 >_ */
  computer_run: 'computer', computer_snapshot: 'computer', computer_check_access: 'computer',
  web_search: 'web',
  deep_research: 'web',
  web_fetch: 'web',
  websearch: 'web',
  webfetch: 'web',
  git_status: 'project',
  git_diff: 'project',
  git_log: 'project',
  git_show: 'project',
  git_branch: 'project',
  git_branch_list: 'project',
  finalize_task: 'summary',
  schedule_reminder: 'retry',
  list_pending_tasks: 'task',
  generate_image: 'generate',
  edit_image: 'generate',
  use_skill: 'skill',
  /* load_instructions — 运行时合成的"加载项目指令"卡 (非 LLM 工具调用, 见
   * runtime/instructionsTimelineCard.ts). 跟 use_skill 同 iconKind: 用户视角
   * 两者是同一类动作 —— agent 主动加载了一份 MD 让它生效. */
  load_instructions: 'skill',
};

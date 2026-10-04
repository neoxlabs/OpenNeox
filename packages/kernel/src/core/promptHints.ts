/**
 * Pure prompt-hint builders with no host-service or persistence dependencies.
 *
 * 从 runtime/systemPrompt.ts 抽出: systemPrompt.ts 会 import getToolServices()
 * → nodeServices → processManager → serviceInstanceStore → sqlite, 把整条 sqlite
 * 链拖进 StreamedRunner 的依赖闭包。这些提示构建器本身是纯字符串模板, 不需要
 * 任何 Neox 服务, 抽到本模块后 runner 不再经 systemPrompt 触达 sqlite。
 *
 */

/**
 * 构建文件编辑失败提示 (引导模型刷新行号/hash 重试或改写整文件)。
 */
export function buildEditFailureHint(
  filePath: string,
  errorMessage: string,
  language: 'zh' | 'en' = 'zh'
): string {
  if (language === 'zh') {
    return `文件编辑失败: ${filePath}

错误信息: ${errorMessage}

建议：
1. 用 readfile(path) 看清要改的那段当前原文
2. 把要替换的原文逐字符照抄进 old_string（含缩进），new_string 是替换后的内容
3. old_string 必须在文件里唯一命中一处（多带上下文让它唯一，或传 replace_all=true）；不要传 patch
4. 如果连续失败，考虑使用 write_file 重写整个文件`;
  } else {
    return `File edit failed: ${filePath}

Error: ${errorMessage}

Suggestions:
1. readfile(path) to see the exact current text you want to change
2. Copy that text verbatim (with indentation) into old_string; new_string is the replacement
3. old_string must uniquely match one spot (add context, or replace_all=true); do not send patch
4. If failing repeatedly, consider rewriting with write_file`;
  }
}

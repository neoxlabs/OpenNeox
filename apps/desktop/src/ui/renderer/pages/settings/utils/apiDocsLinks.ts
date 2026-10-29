
export interface ApiDocsLink {
  /** 厂商展示名 */
  vendor: string;
  /** 官方文档地址 */
  url: string;
}

interface Rule extends ApiDocsLink {
  /** host 里出现任一关键字即命中 */
  match: string[];
}

const RULES: Rule[] = [
  /* ── 国内 ───────────────────────────────────────────── */
  { vendor: 'DeepSeek', match: ['api.deepseek.com', 'deepseek.com'], url: 'https://api-docs.deepseek.com/zh-cn/' },
  { vendor: '通义千问 / 百炼', match: ['dashscope', 'bailian.console.aliyun'], url: 'https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope' },
  { vendor: '豆包 / 火山方舟', match: ['ark.cn-beijing.volces', 'volces.com'], url: 'https://www.volcengine.com/docs/82379/1298454' },
  { vendor: '月之暗面 Kimi', match: ['moonshot.cn', 'moonshot.ai'], url: 'https://platform.moonshot.cn/docs/api/chat' },
  { vendor: '智谱 GLM', match: ['open.bigmodel.cn', 'bigmodel.cn'], url: 'https://docs.bigmodel.cn/cn/guide/start/model-overview' },
  { vendor: 'MiniMax', match: ['minimax.chat', 'minimaxi.com'], url: 'https://platform.minimaxi.com/document/guides' },
  { vendor: '硅基流动 SiliconFlow', match: ['siliconflow'], url: 'https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions' },
  { vendor: '魔搭 ModelScope', match: ['modelscope'], url: 'https://modelscope.cn/docs/model-service/API-Inference/intro' },
  { vendor: '百度千帆', match: ['qianfan.baidubce', 'baidubce.com'], url: 'https://cloud.baidu.com/doc/qianfan-api/index.html' },
  { vendor: '腾讯混元', match: ['hunyuan.cloud.tencent', 'hunyuan'], url: 'https://cloud.tencent.com/document/product/1729/111007' },
  { vendor: '阶跃星辰 StepFun', match: ['stepfun'], url: 'https://platform.stepfun.com/docs/overview/concept' },
  { vendor: '零一万物 Yi', match: ['lingyiwanwu'], url: 'https://platform.lingyiwanwu.com/docs' },
  { vendor: '讯飞星火', match: ['spark-api', 'xf-yun', 'xfyun'], url: 'https://www.xfyun.cn/doc/spark/Web.html' },
  { vendor: '302.AI', match: ['302.ai'], url: 'https://doc.302.ai/' },

  /* ── 海外官方 ───────────────────────────────────────── */
  { vendor: 'Anthropic', match: ['api.anthropic.com', 'anthropic.com'], url: 'https://docs.anthropic.com/en/api/overview' },
  { vendor: 'OpenAI', match: ['api.openai.com'], url: 'https://platform.openai.com/docs/api-reference/chat' },
  { vendor: 'Azure OpenAI', match: ['openai.azure.com', 'azure.com'], url: 'https://learn.microsoft.com/azure/ai-services/openai/reference' },
  { vendor: 'Google Gemini', match: ['generativelanguage.googleapis', 'aiplatform.googleapis'], url: 'https://ai.google.dev/gemini-api/docs' },
  { vendor: 'xAI (Grok)', match: ['api.x.ai', 'x.ai'], url: 'https://docs.x.ai/docs/overview' },
  { vendor: 'Mistral', match: ['mistral.ai'], url: 'https://docs.mistral.ai/api/' },
  { vendor: 'Cohere', match: ['cohere.ai', 'cohere.com'], url: 'https://docs.cohere.com/reference/chat' },
  { vendor: 'AWS Bedrock', match: ['bedrock', 'amazonaws.com'], url: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/' },

  /* ── 海外聚合 / 推理平台 ────────────────────────────── */
  { vendor: 'OpenRouter', match: ['openrouter.ai'], url: 'https://openrouter.ai/docs/api-reference/overview' },
  { vendor: 'Groq', match: ['api.groq.com', 'groq.com'], url: 'https://console.groq.com/docs/api-reference' },
  { vendor: 'Together.ai', match: ['together.xyz', 'together.ai'], url: 'https://docs.together.ai/reference/chat-completions-1' },
  { vendor: 'Fireworks', match: ['fireworks.ai'], url: 'https://docs.fireworks.ai/api-reference/post-chatcompletions' },
  { vendor: 'DeepInfra', match: ['deepinfra'], url: 'https://deepinfra.com/docs/openai_api' },
  { vendor: 'Perplexity', match: ['perplexity.ai'], url: 'https://docs.perplexity.ai/api-reference/chat-completions-post' },
  { vendor: 'Hugging Face', match: ['huggingface.co', 'hf.space'], url: 'https://huggingface.co/docs/inference-providers/index' },
  { vendor: 'Replicate', match: ['replicate.com'], url: 'https://replicate.com/docs/reference/http' },
  { vendor: 'Novita AI', match: ['novita.ai'], url: 'https://novita.ai/docs/api-reference/model-apis-llm-chat-completions-api' },
  { vendor: 'Cloudflare Workers AI', match: ['cloudflare.com', 'workers.dev'], url: 'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/' },

  /* ── 本地运行时 ─────────────────────────────────────── */
  { vendor: 'Ollama', match: ['11434'], url: 'https://docs.ollama.com/api' },
  { vendor: 'LM Studio', match: ['1234'], url: 'https://lmstudio.ai/docs/app/api/endpoints/openai' },
  { vendor: 'vLLM', match: ['8000'], url: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html' },
];

/**
 * 从 Base URL 找对应厂商的官方文档。认不出返回 null (自建/中转代理常见, 不猜)。
 */
export function findApiDocs(baseUrl: string): ApiDocsLink | null {
  const raw = (baseUrl || '').trim().toLowerCase();
  if (!raw) return null;

  /* 只拿 host(:port) 比 —— 路径里出现 "openai" 之类的词不该算命中。
   * URL 解析失败 (用户还没打完协议头) 就退回整串前半段。 */
  let hostPort = raw;
  try {
    hostPort = new URL(raw).host;
  } catch {
    hostPort = raw.replace(/^[a-z]+:\/\//, '').split('/')[0];
  }
  if (!hostPort) return null;

  for (const rule of RULES) {
    if (rule.match.some(k => hostPort.includes(k))) {
      return { vendor: rule.vendor, url: rule.url };
    }
  }
  return null;
}


const IMAGE_MODEL_NAME_RE =
  /gpt-image|gpt-[\d.]+-image|dall-e|imagen|flux|stable-diffusion|sdxl|recraft|riverflow|mai-image|seedream|cogview|wanx|grok.*image|gemini.*image|nano.?banana/i;

const SPEECH_MODEL_NAME_RE =
  /cosyvoice|fun-asr|paraformer|sensevoice|whisper|transcribe|(^|[-_/\s])(asr|tts)([-_\s]|$)|speech|embedding|rerank/i;

/** 只会出图、不会对话/调工具的模型 */
export function isImageModelInfo(m: { id?: string; name?: string } | null | undefined): boolean {
  if (!m) return false;
  return IMAGE_MODEL_NAME_RE.test(`${m.id ?? ''} ${m.name ?? ''}`.toLowerCase());
}

/** 语音 / 向量这类不会对话的模型 */
export function isSpeechModelInfo(m: { id?: string; name?: string } | null | undefined): boolean {
  if (!m) return false;
  return SPEECH_MODEL_NAME_RE.test(`${m.id ?? ''} ${m.name ?? ''}`.toLowerCase());
}

/** 能当对话 / Agent 用的模型 —— 任何「选一个模型来干活」的下拉都该用它过一遍 */
export function isChatModelInfo(m: { id?: string; name?: string } | null | undefined): boolean {
  return !!m && !isImageModelInfo(m) && !isSpeechModelInfo(m);
}

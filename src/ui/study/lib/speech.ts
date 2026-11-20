/**
 * 浏览器语音合成发音（无第三方依赖）。
 * 不可用（无 speechSynthesis / 用户拒绝）时静默失败，不影响交互。
 */
let cachedVoices: SpeechSynthesisVoice[] = []

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null
  if (cachedVoices.length === 0) {
    cachedVoices = window.speechSynthesis.getVoices()
  }
  const en = cachedVoices.filter((v) => v.lang.toLowerCase().startsWith('en'))
  if (en.length === 0) return null
  return en.find((v) => v.lang.toLowerCase() === 'en-us') ?? en[0] ?? null
}

/** 朗读英文单词；返回是否成功发起 */
export function speakWord(text: string, opts?: { rate?: number }): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
  const word = text.trim()
  if (!word) return false
  try {
    const synth = window.speechSynthesis
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(word)
    utterance.lang = 'en-US'
    utterance.rate = opts?.rate ?? 0.95
    const voice = pickVoice()
    if (voice) utterance.voice = voice
    synth.speak(utterance)
    return true
  } catch {
    return false
  }
}

/** 预热 voices（部分浏览器首帧为空，需要触发一次加载） */
export function warmUpVoices(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  cachedVoices = window.speechSynthesis.getVoices()
  if (typeof window.speechSynthesis.addEventListener === 'function') {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      cachedVoices = window.speechSynthesis.getVoices()
    })
  }
}

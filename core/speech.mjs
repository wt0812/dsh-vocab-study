// vocab-study / core / speech.mjs
// 系统 TTS（点单词即发音，零网络零成本 —— 规格 §5.2）。

let cachedVoice = null;
let voicesReady = false;

/** 找一个英文音色：优先 en-US，其次任意 en-*。 */
function pickVoice(synth) {
  if (cachedVoice) return cachedVoice;
  const voices = (synth && synth.getVoices && synth.getVoices()) || [];
  if (!voices.length) return null;
  const en = voices.filter((v) => /^en(-|_)?/i.test(v.lang || ''));
  cachedVoice =
    en.find((v) => /en[-_]US/i.test(v.lang) && /female|samantha|zira|aria/i.test(v.name)) ||
    en.find((v) => /en[-_]US/i.test(v.lang)) ||
    en[0] ||
    null;
  return cachedVoice;
}

export function speechAvailable() {
  return typeof window !== 'undefined' && !!window.speechSynthesis;
}

/** 朗读一个单词。失败安静返回 false —— 绝不弹错、绝不阻塞卡片。 */
export function speak(word, { rate = 0.9, lang = 'en-US' } = {}) {
  if (!speechAvailable()) return false;
  try {
    const synth = window.speechSynthesis;
    if (!voicesReady) {
      voicesReady = true;
      // 有些浏览器首次 getVoices() 为空，等一次 voiceschanged 再取
      try {
        synth.addEventListener?.('voiceschanged', () => {
          cachedVoice = null;
          pickVoice(synth);
        });
      } catch {
        /* 忽略 */
      }
      pickVoice(synth);
    }
    synth.cancel(); // 连点单词时不排队，直接打断上一条
    const u = new SpeechSynthesisUtterance(String(word));
    const v = pickVoice(synth);
    if (v) u.voice = v;
    u.lang = (v && v.lang) || lang;
    u.rate = rate;
    u.pitch = 1;
    u.volume = 1;
    synth.speak(u);
    return true;
  } catch {
    return false;
  }
}

export function stopSpeaking() {
  if (!speechAvailable()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* 忽略 */
  }
}

/** 朗读练习：自动停下的时长估算，用于面板内「🔊 再听一遍」。 */
export function speechSupportedLanguages() {
  if (!speechAvailable()) return [];
  try {
    return (window.speechSynthesis.getVoices() || []).map((v) => v.lang);
  } catch {
    return [];
  }
}

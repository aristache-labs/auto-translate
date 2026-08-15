<p align="center">
  <img src="banner.png?v=2" alt="My Translator — Real-time Speech Translation">
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/phuc-nt/my-translator?color=green&label=release" alt="Latest Release">
  <img src="https://img.shields.io/badge/built_with-Tauri-orange?logo=tauri" alt="Built with Tauri">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-10%2F11-blue?logo=windows" alt="Windows">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/github/stars/phuc-nt/my-translator?style=flat&color=yellow" alt="Stars">
</p>

**My Translator** is a real-time speech translation desktop app built with Tauri. It captures audio directly from your system or microphone, transcribes it, and displays translations in a minimal overlay — with no intermediary server involved.

> 📖 Installation guides: [macOS (EN)](docs/installation_guide.md) · [macOS (VI)](docs/installation_guide_vi.md) · [Windows (EN)](docs/installation_guide_win.md) · [Windows (VI)](docs/installation_guide_win_vi.md)

### ⬇️ Which build do I download?

Grab the matching file from the [latest release](https://github.com/phuc-nt/my-translator/releases/latest):

| Your machine | File |
|---|---|
| **Mac Apple Silicon** (M1/M2/M3/M4) | `MyTranslator_<ver>_aarch64.dmg` |
| **Mac Intel** (pre-2020) | `MyTranslator_<ver>_x64.dmg` |
| **Windows** | `MyTranslator_<ver>_x64-setup.exe` |

> On a Mac, check  → **About This Mac** → *Chip*: **Apple M-series** → `aarch64`, **Intel** → `x64`. Macs from late 2020 on are almost all Apple Silicon.
> The `.app.tar.gz`, `.sig`, and `latest.json` files are for the built-in auto-updater — you don't download those.

---

## How It Works

```
                                    ┌── ⚡ Groq (Primary, fastest)      ──┐
System Audio / Mic → 16kHz PCM ─────┤── ☁️  Cloudflare (Fallback)       ├─→ Overlay UI
                                    └── 🖥️  Local MLX (offline)         ─┘
                                                                            ↓ (optional, text engines)
                                                  TTS (Edge / Google / ElevenLabs) → 🔊
```

Three translation engines with automatic fallback:

| Feature | Detail |
|---------|--------|
| **Engines** | ⚡ Groq (Primary) · ☁️ Cloudflare (Fallback) · 🖥️ Local MLX |
| **Latency** | ~1–2 s (Groq) · ~2–3 s (Cloudflare) · ~10 s (Local) |
| **Languages** | 99+ (Groq/Cloudflare Whisper v3) · JA/EN/ZH/KO → VI/EN (Local) |
| **Cost** | ~$0.02/hr (Groq) · ~$0.03/hr (Cloudflare) · Free (Local) |
| **Model** | Whisper large-v3-turbo (Groq/Cloudflare) · MLX (Local) |
| **TTS** | 3 providers (Edge free, Google, ElevenLabs) for all engines |
| **Platform** | macOS (ARM + Intel) · Windows · Local mode = Apple Silicon only |
| **Signed** | ✅ macOS signed & notarized |
| **Auto-Update** | ✅ Built-in, check & install from Settings |

> **Fallback Flow**: If Groq times out or fails, the app automatically switches to Cloudflare mid-session with zero data loss.

---

## Features

### 📖 Dual Panel View

Two display modes:
- **Single** (default) — Translation text only, clean and focused
- **Dual** — Source | Translation side-by-side, each panel scrolls independently

Toggle with the panel button (bottom-right on hover).

### 🔄 Smart Scroll

Auto-scroll only when you're at the bottom. Scroll up to read old content without being yanked back down.

### 🔤 Quick Font Size

A- / A+ floating controls (bottom-right on hover). Font size adjustable up to 140px — great for presentations.

### 🔄 Two-Way Translation

Translate conversations between two languages simultaneously — ideal for bilingual meetings.

- **One-way**: Source language → Target language (e.g., Japanese → Vietnamese)
- **Two-way**: Language A ↔ Language B (e.g., Vietnamese ↔ Japanese) — the app detects who is speaking and translates to the other language automatically

**Setup for video calls** (Zoom, Google Meet, MS Teams):
1. Audio Source: **Both** (System + Mic)
2. Translation Type: **Two-way**
3. Set Language A and Language B

> **Note**: TTS narration is automatically disabled in two-way mode to prevent audio feedback loops (TTS output → mic recapture → re-translation).

### 🎙️ TTS Narration

Read translations aloud in one-way mode — 3 providers:

| | Edge TTS ⭐ | Google Chirp 3 HD | ElevenLabs |
|-|-------------|-------------------|------------|
| **Cost** | Free | Free 1M chars/mo | ~$5/mo+ |
| **Quality** | ★★★★☆ Neural | ★★★★★ Near-human | ★★★★★ Premium |
| **Vietnamese** | ✅ 2 voices | ✅ 6 voices | ✅ Yes |
| **Setup** | None | Google Cloud API key | API key |
| **Speed control** | ✅ | ✅ 0.5x–2.0x | ❌ |

TTS is **OFF by default** — toggle with the TTS button or `⌘ T`.

> 📖 TTS guide: [English](docs/tts_guide.md) · [Tiếng Việt](docs/tts_guide_vi.md)

### 📖 Custom Translation Terms

Define how domain-specific words should be translated:

```
Original sin = Tội nguyên tổ
Christ = Kitô
Pneumonia = Viêm phổi
```

Add terms in Settings → Translation → Translation terms. Great for religious, medical, or technical content.

### ⚡ Groq Mode (Primary)

Fastest transcription using Groq's Whisper large-v3-turbo API. Streams audio and returns transcriptions with automatic fallback to Cloudflare if Groq times out or fails. Supports 99+ languages and automatic language detection.

### ☁️ Cloudflare Workers AI (Fallback)

Reliable fallback transcription engine using Cloudflare's Whisper v3 model. Automatically engaged if Groq becomes unavailable, ensuring zero transcription loss mid-session.

### 🖥️ Local Mode (Apple Silicon only)

Experimental offline mode using MLX + Whisper + Gemma — runs 100% on-device. JA/EN/ZH/KO → VI/EN.

---

## Privacy

**Your audio never touches our servers — because there are none.**

- App connects **directly** to APIs you configure — no relay, no middleman
- **You own your API keys** — stored locally, never transmitted elsewhere
- **No account, no telemetry, no analytics** — zero tracking
- Transcripts saved as `.md` files locally, per session

---

## Tech Stack

- **[Tauri 2](https://tauri.app/)** — Rust backend + WebView frontend
- **[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)** — macOS system audio
- **[WASAPI](https://learn.microsoft.com/en-us/windows/win32/coreaudio/wasapi)** — Windows system audio
- **[cpal](https://github.com/RustAudio/cpal)** — Cross-platform microphone
- **[Groq Whisper API](https://groq.com)** — Real-time STT (primary engine)
- **[Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)** — Whisper v3 (fallback engine)
- **[MLX](https://github.com/ml-explore/mlx)** — On-device Whisper + Gemma for offline mode
- **[Piper](https://github.com/rhasspy/piper) via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** — Local offline neural TTS (on-device, no network)
- **[Edge TTS](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/index-text-to-speech)** — Free neural TTS (default)
- **[Google Cloud TTS](https://cloud.google.com/text-to-speech)** — Chirp 3 HD (near-human quality)
- **[ElevenLabs](https://elevenlabs.io)** — Premium TTS

---

## Build from Source

```bash
git clone https://github.com/phuc-nt/my-translator.git
cd my-translator
npm install
npm run tauri build
```

Requires: Rust (stable), Node.js 18+, macOS 13+ or Windows 10+.

---

## Star History

<a href="https://www.star-history.com/?repos=phuc-nt%2Fmy-translator&type=date&legend=top-left">
 <picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=phuc-nt/my-translator&type=date&theme=dark&legend=top-left" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=phuc-nt/my-translator&type=date&legend=top-left" />
  <img alt="Star History Chart" src="https://api.star-history.com/image?repos=phuc-nt/my-translator&type=date&legend=top-left" />
 </picture>
</a>

---

## License

MIT

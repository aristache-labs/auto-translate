# Benchmarks

Standalone latency benchmarks for the current translation providers. They are
development tools and are not included in the application build.

## `benchmark-soniox-endpoint-delay.cjs`

The filename is retained for compatibility with existing commands and notes,
but the benchmark no longer calls Soniox.

Groq and Cloudflare use request/response APIs, and the desktop clients begin
processing after a PCM buffer fills. The benchmark therefore sweeps PCM buffer
windows instead of Soniox `max_endpoint_delay_ms`.

Supported pipelines:

- Groq STT → Groq LLM (`groq+engine`)
- Groq STT → OpenRouter (`groq+openrouter`)
- Cloudflare STT → Cloudflare Workers AI (`cloudflare+engine`)
- Cloudflare STT → OpenRouter (`cloudflare+openrouter`)

The defaults benchmark both STT providers with their own translation engine
using buffer windows of 300, 1000, and 3000 ms.

### Metrics

Each run records:

- `sttMs`: provider transcription request time
- `translationMs`: text-translation request time
- `requestPipelineMs`: combined STT and translation request time
- `estimatedFirstResultMs`: buffered audio duration plus request pipeline time
- `sourceChars` and `targetChars`: output sizes without storing transcript text
- normalized errors, HTTP status, and `Retry-After` when available

Results never contain API keys, authorization headers, provider response
bodies, or raw transcripts.

### Requirements

- Node.js 18 or newer (`fetch`, `FormData`, and `Blob` are required)
- a raw 16 kHz, mono, signed 16-bit little-endian PCM sample
- credentials for every provider included in the selected pipelines

No npm dependency or `ws` installation is required.

The default sample path is:

```text
../live-test/hope-v2-trim-16k.pcm
```

Override it with `BENCH_PCM_16K` when the sample is stored elsewhere.

### Credentials

Credentials can be supplied through process environment variables or a
gitignored `benchmarks/.env.local` file:

```dotenv
GROQ_API_KEY=replace-with-your-key
CLOUDFLARE_ACCOUNT_ID=replace-with-your-account-id
CLOUDFLARE_API_TOKEN=replace-with-your-token
OPENROUTER_API_KEY=replace-with-your-key
```

`CF_ACCOUNT_ID` and `CF_API_TOKEN` are accepted as Cloudflare aliases.
OpenRouter credentials are only required when `openrouter` is selected as a
translator.

Never commit `.env.local`, credentials, PCM recordings, or generated results.

### Run

Live provider calls are disabled unless `BENCH_LIVE=1` is set explicitly. This
guard prevents accidental consumption of free-tier quotas.

PowerShell:

```powershell
cd C:\Personal\auto-translate\benchmarks
$env:BENCH_LIVE = '1'
node .\benchmark-soniox-endpoint-delay.cjs
```

Benchmark both engine translation and OpenRouter:

```powershell
$env:BENCH_LIVE = '1'
$env:BENCH_TRANSLATORS = 'engine,openrouter'
node .\benchmark-soniox-endpoint-delay.cjs
```

Benchmark only Groq with custom buffer windows and two repetitions:

```powershell
$env:BENCH_LIVE = '1'
$env:BENCH_STT_PROVIDERS = 'groq'
$env:BENCH_BUFFER_MS = '500,1000,2000'
$env:BENCH_RUNS = '2'
$env:BENCH_PCM_16K = 'C:\path\sample-16k.pcm'
node .\benchmark-soniox-endpoint-delay.cjs
```

### Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BENCH_LIVE` | disabled | Must be `1`, `true`, `yes`, or `on` to allow live calls |
| `BENCH_PCM_16K` | default sample path | Input PCM file |
| `BENCH_AUDIO_OFFSET_MS` | `0` | Start offset within the sample |
| `BENCH_BUFFER_MS` | `300,1000,3000` | PCM windows to benchmark; valid range 100–30000 ms |
| `BENCH_RUNS` | `1` | Runs per configuration; capped at 10 |
| `BENCH_PAUSE_MS` | `2000` | Pause between live calls |
| `BENCH_TIMEOUT_MS` | `45000` | Per-request timeout |
| `BENCH_SOURCE_LANG` | `ja` | Source language or `auto` |
| `BENCH_TARGET_LANG` | `vi` | Target language |
| `BENCH_STT_PROVIDERS` | `groq,cloudflare` | STT providers to include |
| `BENCH_TRANSLATORS` | `engine` | `engine`, `openrouter`, or both |
| `BENCH_GROQ_STT_MODEL` | `whisper-large-v3-turbo` | Groq STT model |
| `BENCH_GROQ_LLM_MODEL` | `openai/gpt-oss-20b` | Groq translation model |
| `BENCH_CLOUDFLARE_STT_MODEL` | `@cf/openai/whisper-large-v3-turbo` | Cloudflare STT model |
| `BENCH_CLOUDFLARE_LLM_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fast` | Cloudflare translation model |
| `BENCH_OPENROUTER_MODEL` | `openai/gpt-4o-mini` | OpenRouter translation model |

Unknown providers, invalid ranges, missing samples, and missing credentials
fail before live requests begin. Pipelines without credentials are reported as
skipped.

### Output

The benchmark prints a compact summary and writes:

```text
results/benchmark-provider-buffer-latency-YYYYMMDD-HHMMSS-mmm.json
```

Each run creates a new timestamped file, so an earlier benchmark is never
overwritten. If two runs produce the same millisecond timestamp, the newer file
gets a numeric suffix such as `-1` or `-2`. The `results/` directory remains
gitignored. Compare
`estimatedFirstResultMs` across buffer windows to balance responsiveness
against transcript completeness. Very short windows may be fast but can cut a
spoken phrase before enough context reaches STT.

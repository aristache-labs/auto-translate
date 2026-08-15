#!/usr/bin/env node
"use strict";

/**
 * Current provider latency benchmark.
 *
 * Historical note: this file used to benchmark Soniox max_endpoint_delay_ms.
 * Groq and Cloudflare now use request/response APIs and the desktop clients
 * trigger processing after a fixed PCM buffer fills. The meaningful tuning
 * variable is therefore the PCM buffer window, not a Soniox endpoint delay.
 *
 * Mirrors the production pipeline:
 *   PCM s16le 16 kHz mono
 *     -> Groq or Cloudflare STT
 *     -> the same engine LLM or OpenRouter
 *
 * Safety:
 *   - Live calls require BENCH_LIVE=1.
 *   - API keys are read from process.env or benchmarks/.env.local.
 *   - Keys, provider response bodies, and transcripts are never written.
 *   - BENCH_RUNS defaults to 1 and is capped at 10.
 *
 * Usage:
 *   BENCH_LIVE=1 node benchmark-soniox-endpoint-delay.cjs
 *
 * Useful overrides:
 *   BENCH_STT_PROVIDERS=groq,cloudflare
 *   BENCH_TRANSLATORS=engine,openrouter
 *   BENCH_BUFFER_MS=300,1000,3000
 *   BENCH_RUNS=1
 *   BENCH_SOURCE_LANG=ja
 *   BENCH_TARGET_LANG=vi
 *   BENCH_PCM_16K=C:\path\sample-16k.pcm
 *
 * Output:
 *   results/benchmark-provider-buffer-latency-YYYYMMDD-HHMMSS-mmm.json
 */

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const DEFAULT_TIMEOUT_MS = 45000;

function parseEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

const FILE_ENV = parseEnv(path.join(__dirname, ".env.local"));

function env(...names) {
  for (const name of names) {
    const value = process.env[name] ?? FILE_ENV[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function enabled(name) {
  return /^(1|true|yes|on)$/i.test(env(name));
}

function parseCsv(name, fallback) {
  const raw = env(name) || fallback;
  return [...new Set(raw.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

function parseInteger(name, fallback, min, max) {
  const value = Number.parseInt(env(name), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseIntegerCsv(name, fallback, min, max) {
  const values = parseCsv(name, fallback)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value >= min && value <= max);
  if (!values.length) {
    throw new Error(name + " must contain at least one integer from " + min + " to " + max);
  }
  return [...new Set(values)];
}

const CONFIG = {
  live: enabled("BENCH_LIVE"),
  pcmFile:
    env("BENCH_PCM_16K") ||
    path.join(__dirname, "..", "live-test", "hope-v2-trim-16k.pcm"),
  audioOffsetMs: parseInteger("BENCH_AUDIO_OFFSET_MS", 0, 0, 60 * 60 * 1000),
  bufferWindowsMs: parseIntegerCsv("BENCH_BUFFER_MS", "300,1000,3000", 100, 30000),
  runs: parseInteger("BENCH_RUNS", 1, 1, 10),
  pauseMs: parseInteger("BENCH_PAUSE_MS", 2000, 0, 60000),
  timeoutMs: parseInteger("BENCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1000, 120000),
  sourceLanguage: env("BENCH_SOURCE_LANG") || "ja",
  targetLanguage: env("BENCH_TARGET_LANG") || "vi",
  sttProviders: parseCsv("BENCH_STT_PROVIDERS", "groq,cloudflare"),
  translators: parseCsv("BENCH_TRANSLATORS", "engine"),
  groqSttModel: env("BENCH_GROQ_STT_MODEL") || "whisper-large-v3-turbo",
  groqLlmModel: env("BENCH_GROQ_LLM_MODEL") || "openai/gpt-oss-20b",
  cloudflareSttModel:
    env("BENCH_CLOUDFLARE_STT_MODEL") || "@cf/openai/whisper-large-v3-turbo",
  cloudflareLlmModel:
    env("BENCH_CLOUDFLARE_LLM_MODEL") || "@cf/meta/llama-3.1-8b-instruct-fast",
  openRouterModel: env("BENCH_OPENROUTER_MODEL") || "openai/gpt-4o-mini",
};

const SECRETS = {
  groqApiKey: env("GROQ_API_KEY"),
  cloudflareAccountId: env("CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"),
  cloudflareApiToken: env("CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"),
  openRouterApiKey: env("OPENROUTER_API_KEY"),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function resultTimestamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(".", "-")
    .replace("Z", "");
}

function writeUniqueResult(outDir, payload, date) {
  const prefix =
    "benchmark-provider-buffer-latency-" + resultTimestamp(date);
  const contents = JSON.stringify(payload, null, 2) + "\n";

  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix = attempt === 0 ? "" : "-" + attempt;
    const outFile = path.join(outDir, prefix + suffix + ".json");

    try {
      fs.writeFileSync(outFile, contents, { flag: "wx" });
      return outFile;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  throw new Error("Unable to create a unique benchmark result file.");
}

function pcmDurationMs(buffer) {
  return (buffer.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000;
}

function pcmWindow(buffer, offsetMs, windowMs) {
  const bytesPerMs = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1000;
  const start = Math.floor(offsetMs * bytesPerMs);
  const end = Math.min(buffer.length, start + Math.floor(windowMs * bytesPerMs));
  if (start >= buffer.length || end <= start) {
    throw new Error("Requested audio window is outside the PCM sample");
  }
  return buffer.subarray(start, end);
}

function pcmToWav(pcm) {
  const headerBytes = 44;
  const wav = Buffer.alloc(headerBytes + pcm.length);
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNELS, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(BITS_PER_SAMPLE, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, headerBytes);
  return wav;
}

function translationPrompt(sourceLanguage, targetLanguage, text) {
  return (
    "Translate the following text to " +
    targetLanguage +
    ". If the source language is specified as " +
    sourceLanguage +
    ", use that. Return only the translation, with no quotes or explanation.\n\n" +
    text
  );
}

class ProviderHttpError extends Error {
  constructor(label, status, headers) {
    super(label + " HTTP " + status);
    this.name = "ProviderHttpError";
    this.provider = label;
    this.status = status;
    this.retryAfter = headers?.get?.("retry-after") || "";
  }
}

async function fetchJson(label, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderHttpError(label, response.status, response.headers);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(label + " returned invalid JSON");
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(label + " timed out after " + CONFIG.timeoutMs + "ms");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function groqTranscribe(wav) {
  const form = new FormData();
  form.append("model", CONFIG.groqSttModel);
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  if (CONFIG.sourceLanguage && CONFIG.sourceLanguage !== "auto") {
    form.append("language", CONFIG.sourceLanguage);
  }
  const data = await fetchJson(
    "Groq STT",
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + SECRETS.groqApiKey },
      body: form,
    }
  );
  return String(data?.text || "").trim();
}

async function groqTranslate(text) {
  if (!text || CONFIG.sourceLanguage === CONFIG.targetLanguage) return text;
  const data = await fetchJson(
    "Groq LLM",
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SECRETS.groqApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CONFIG.groqLlmModel,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are a precise translator. Output only the translated text.",
          },
          {
            role: "user",
            content: translationPrompt(
              CONFIG.sourceLanguage,
              CONFIG.targetLanguage,
              text
            ),
          },
        ],
      }),
    }
  );
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function cloudflareRunUrl(model) {
  return (
    "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(SECRETS.cloudflareAccountId) +
    "/ai/run/" +
    model
  );
}

async function cloudflareTranscribe(wav) {
  const payload = { audio: wav.toString("base64") };
  if (CONFIG.sourceLanguage && CONFIG.sourceLanguage !== "auto") {
    payload.language = CONFIG.sourceLanguage;
  }
  const data = await fetchJson(
    "Cloudflare STT",
    cloudflareRunUrl(CONFIG.cloudflareSttModel),
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SECRETS.cloudflareApiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );
  return String(data?.result?.text || data?.text || "").trim();
}

async function cloudflareTranslate(text) {
  if (!text || CONFIG.sourceLanguage === CONFIG.targetLanguage) return text;
  const data = await fetchJson(
    "Cloudflare LLM",
    cloudflareRunUrl(CONFIG.cloudflareLlmModel),
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SECRETS.cloudflareApiToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: "You are a precise translator. Output only the translated text.",
          },
          {
            role: "user",
            content: translationPrompt(
              CONFIG.sourceLanguage,
              CONFIG.targetLanguage,
              text
            ),
          },
        ],
      }),
    }
  );
  return String(data?.result?.response || data?.result?.output || "").trim();
}

async function openRouterTranslate(text) {
  if (!text || CONFIG.sourceLanguage === CONFIG.targetLanguage) return text;
  const data = await fetchJson(
    "OpenRouter",
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SECRETS.openRouterApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CONFIG.openRouterModel,
        temperature: 0.2,
        stream: false,
        messages: [
          {
            role: "system",
            content: "You are a precise translator. Output only the translated text.",
          },
          {
            role: "user",
            content: translationPrompt(
              CONFIG.sourceLanguage,
              CONFIG.targetLanguage,
              text
            ),
          },
        ],
      }),
    }
  );
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function validateRuntime() {
  if (typeof fetch !== "function" || typeof FormData !== "function" || typeof Blob !== "function") {
    throw new Error("Node.js 18 or newer is required (fetch, FormData and Blob)");
  }
  if (!CONFIG.live) {
    throw new Error(
      "Live provider calls are disabled. Set BENCH_LIVE=1 after reviewing the configured providers and quotas."
    );
  }
  if (!fs.existsSync(CONFIG.pcmFile)) {
    throw new Error(
      "PCM sample not found: " +
        CONFIG.pcmFile +
        ". Set BENCH_PCM_16K to a 16 kHz mono PCM s16le file."
    );
  }

  const allowedStt = new Set(["groq", "cloudflare"]);
  const allowedTranslators = new Set(["engine", "openrouter"]);
  for (const provider of CONFIG.sttProviders) {
    if (!allowedStt.has(provider)) {
      throw new Error("Unsupported BENCH_STT_PROVIDERS entry: " + provider);
    }
  }
  for (const translator of CONFIG.translators) {
    if (!allowedTranslators.has(translator)) {
      throw new Error("Unsupported BENCH_TRANSLATORS entry: " + translator);
    }
  }
}

function configuredPipelines() {
  const pipelines = [];
  const skipped = [];

  for (const sttProvider of CONFIG.sttProviders) {
    const hasSttCredentials =
      sttProvider === "groq"
        ? Boolean(SECRETS.groqApiKey)
        : Boolean(SECRETS.cloudflareAccountId && SECRETS.cloudflareApiToken);

    if (!hasSttCredentials) {
      skipped.push(sttProvider + ": missing STT credentials");
      continue;
    }

    for (const translator of CONFIG.translators) {
      if (translator === "openrouter" && !SECRETS.openRouterApiKey) {
        skipped.push(sttProvider + "+openrouter: missing OPENROUTER_API_KEY");
        continue;
      }

      const name = sttProvider + "+" + translator;
      pipelines.push({
        name,
        sttProvider,
        translator,
        sttModel:
          sttProvider === "groq"
            ? CONFIG.groqSttModel
            : CONFIG.cloudflareSttModel,
        translationModel:
          translator === "openrouter"
            ? CONFIG.openRouterModel
            : sttProvider === "groq"
              ? CONFIG.groqLlmModel
              : CONFIG.cloudflareLlmModel,
        transcribe: sttProvider === "groq" ? groqTranscribe : cloudflareTranscribe,
        translate:
          translator === "openrouter"
            ? openRouterTranslate
            : sttProvider === "groq"
              ? groqTranslate
              : cloudflareTranslate,
      });
    }
  }

  return { pipelines, skipped: [...new Set(skipped)] };
}

async function runCase(pipeline, fullPcm, requestedBufferMs, runNumber) {
  const pcm = pcmWindow(fullPcm, CONFIG.audioOffsetMs, requestedBufferMs);
  const actualAudioMs = pcmDurationMs(pcm);
  const wav = pcmToWav(pcm);

  const started = performance.now();
  const sttStarted = performance.now();
  const sourceText = await pipeline.transcribe(wav);
  const sttMs = performance.now() - sttStarted;

  if (!sourceText) {
    throw new Error(pipeline.name + " returned an empty transcript");
  }

  const translationStarted = performance.now();
  const translatedText = await pipeline.translate(sourceText);
  const translationMs = performance.now() - translationStarted;
  const requestPipelineMs = performance.now() - started;

  if (!translatedText) {
    throw new Error(pipeline.name + " returned an empty translation");
  }

  return {
    pipeline: pipeline.name,
    sttProvider: pipeline.sttProvider,
    translator: pipeline.translator,
    sttModel: pipeline.sttModel,
    translationModel: pipeline.translationModel,
    requestedBufferMs,
    actualAudioMs: roundMs(actualAudioMs),
    run: runNumber,
    sttMs: roundMs(sttMs),
    translationMs: roundMs(translationMs),
    requestPipelineMs: roundMs(requestPipelineMs),
    estimatedFirstResultMs: roundMs(actualAudioMs + requestPipelineMs),
    sourceChars: sourceText.length,
    targetChars: translatedText.length,
  };
}

function safeError(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || error || "Unknown error").slice(0, 240),
    status: Number.isFinite(error?.status) ? error.status : undefined,
    retryAfter: error?.retryAfter || undefined,
  };
}

function printSummary(results) {
  console.log("\n=== Summary ===");
  console.log(
    "pipeline".padEnd(24) +
      "buffer".padStart(8) +
      "stt".padStart(10) +
      "translate".padStart(12) +
      "estimated".padStart(12) +
      "status".padStart(10)
  );
  for (const result of results) {
    const failed = Boolean(result.error);
    console.log(
      String(result.pipeline).padEnd(24) +
        String(result.requestedBufferMs + "ms").padStart(8) +
        String(failed ? "-" : result.sttMs + "ms").padStart(10) +
        String(failed ? "-" : result.translationMs + "ms").padStart(12) +
        String(failed ? "-" : result.estimatedFirstResultMs + "ms").padStart(12) +
        String(failed ? "ERROR" : "OK").padStart(10)
    );
  }
}

async function main() {
  validateRuntime();

  const fullPcm = fs.readFileSync(CONFIG.pcmFile);
  const { pipelines, skipped } = configuredPipelines();
  if (!pipelines.length) {
    throw new Error("No configured benchmark pipelines. Add provider keys or adjust BENCH_STT_PROVIDERS.");
  }

  console.log("=== Provider PCM buffer-window benchmark ===");
  console.log("Audio:", path.basename(CONFIG.pcmFile));
  console.log("Audio duration:", roundMs(pcmDurationMs(fullPcm)) + "ms");
  console.log("Language:", CONFIG.sourceLanguage + " -> " + CONFIG.targetLanguage);
  console.log("Buffer windows:", CONFIG.bufferWindowsMs.join(", ") + "ms");
  console.log("Pipelines:", pipelines.map((pipeline) => pipeline.name).join(", "));
  console.log("Runs per configuration:", CONFIG.runs);
  if (skipped.length) console.log("Skipped:", skipped.join("; "));
  console.log("");

  const results = [];
  for (const pipeline of pipelines) {
    for (const bufferMs of CONFIG.bufferWindowsMs) {
      for (let run = 1; run <= CONFIG.runs; run++) {
        process.stdout.write(
          "-- " + pipeline.name + " buffer=" + bufferMs + "ms run=" + run + " ... "
        );
        try {
          const result = await runCase(pipeline, fullPcm, bufferMs, run);
          results.push(result);
          console.log(
            "STT=" +
              result.sttMs +
              "ms translate=" +
              result.translationMs +
              "ms estimated-first=" +
              result.estimatedFirstResultMs +
              "ms"
          );
        } catch (error) {
          const normalized = safeError(error);
          results.push({
            pipeline: pipeline.name,
            sttProvider: pipeline.sttProvider,
            translator: pipeline.translator,
            sttModel: pipeline.sttModel,
            translationModel: pipeline.translationModel,
            requestedBufferMs: bufferMs,
            run,
            error: normalized,
          });
          console.log("ERROR:", normalized.message);
        }
        if (CONFIG.pauseMs) await sleep(CONFIG.pauseMs);
      }
    }
  }

  printSummary(results);

  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const runTimestamp = new Date();
  const payload = {
    schemaVersion: 2,
    timestamp: runTimestamp.toISOString(),
    benchmark: "provider-pcm-buffer-latency",
    note:
      "The old Soniox endpoint-delay sweep was replaced because current Groq/Cloudflare clients use a PCM buffer threshold.",
    config: {
      audioFile: path.basename(CONFIG.pcmFile),
      audioOffsetMs: CONFIG.audioOffsetMs,
      bufferWindowsMs: CONFIG.bufferWindowsMs,
      runs: CONFIG.runs,
      sourceLanguage: CONFIG.sourceLanguage,
      targetLanguage: CONFIG.targetLanguage,
      timeoutMs: CONFIG.timeoutMs,
      pauseMs: CONFIG.pauseMs,
      pipelines: pipelines.map((pipeline) => ({
        name: pipeline.name,
        sttModel: pipeline.sttModel,
        translationModel: pipeline.translationModel,
      })),
      skipped,
    },
    results,
  };
  const outFile = writeUniqueResult(outDir, payload, runTimestamp);
  console.log("\nWrote", outFile);
}

main().catch((error) => {
  console.error("Benchmark failed:", safeError(error).message);
  process.exitCode = 1;
});

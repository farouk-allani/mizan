import type { Config } from '../../config.js';
import type { LlmClient, Notifier } from '../../ports/index.js';

/**
 * OpenAI-compatible chat completions adapter.
 * Works with OpenRouter, MiMo, or any /v1/chat/completions endpoint —
 * the Strategist is provider-agnostic by design.
 */
export class OpenAICompatLlm implements LlmClient {
  constructor(private readonly cfg: Config) {}

  async complete(system: string, user: string): Promise<string> {
    const apiKey = process.env[this.cfg.llm.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing LLM API key in env ${this.cfg.llm.apiKeyEnv}`);

    const res = await fetch(`${this.cfg.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: this.cfg.llm.model,
        temperature: this.cfg.llm.temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty completion');
    return content;
  }
}

/** Telegram notifier — same gateway pattern as the Hermes agent. */
export class TelegramNotifier implements Notifier {
  constructor(private readonly cfg: Config) {}

  async send(text: string): Promise<void> {
    if (!this.cfg.notify.telegram.enabled) return;
    const token = process.env[this.cfg.notify.telegram.botTokenEnv];
    const chatId = process.env[this.cfg.notify.telegram.chatIdEnv];
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    }).catch(() => undefined); // notifications must never crash the loop
  }
}

export class ConsoleNotifier implements Notifier {
  async send(text: string): Promise<void> {
    console.log(`[notify] ${text}`);
  }
}

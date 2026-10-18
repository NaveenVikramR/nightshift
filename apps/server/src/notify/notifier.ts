import type { FetchLike } from '../clients/errors.js';

/** Pushes a short text to the on-call human (MCP can't make Alexa speak first). */
export interface Notifier {
  readonly name: string;
  send(text: string): Promise<void>;
}

export const noopNotifier: Notifier = { name: 'none', send: async () => {} };

/**
 * Telegram Bot API sendMessage. The bot token is part of the URL path, so it is
 * never put in an error message or log line.
 */
export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';

  constructor(
    private readonly opts: { apiUrl: string; botToken: string; chatId: string; timeoutMs: number },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(text: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.apiUrl}/bot${this.opts.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.opts.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      throw new Error(`telegram unreachable (${name})`);
    }
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw new Error(`telegram answered HTTP ${res.status}`);
  }
}

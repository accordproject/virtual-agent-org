// Minimal Telegram Bot API client. Plain text only (no parse_mode) so agent
// output never breaks on Markdown escaping.

export interface InlineButton {
  text: string;
  callback_data: string; // <= 64 bytes
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: TgMessage;
    data?: string;
  };
}

export interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; is_bot?: boolean };
  chat: { id: number; type: string };
  text?: string;
  reply_to_message?: TgMessage;
}

const LIMIT = 4000; // Telegram caps at 4096 characters

export class Telegram {
  constructor(private token: string, private fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  }

  /** Sends text, splitting long messages. Returns the id of the last message sent. */
  async send(
    chatId: number,
    text: string,
    opts: { buttons?: InlineButton[][]; forceReply?: boolean; replyTo?: number } = {},
  ): Promise<number> {
    const chunks = splitText(text || "(empty)");
    let last = 0;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const msg = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: chunks[i],
        disable_web_page_preview: true,
        ...(opts.replyTo && i === 0 ? { reply_to_message_id: opts.replyTo } : {}),
        ...(isLast && opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
        ...(isLast && opts.forceReply ? { reply_markup: { force_reply: true, selective: true } } : {}),
      });
      last = msg.message_id;
    }
    return last;
  }

  async edit(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]) {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text.length > LIMIT ? `${text.slice(0, LIMIT - 20)}\n… (cut short)` : text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: buttons ?? [] },
    });
  }

  async answerCallback(id: string, text?: string) {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  }
}

export function splitText(text: string, limit = LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

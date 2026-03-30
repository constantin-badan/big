export interface AlertChannel {
  send(message: string): Promise<void>;
}

export class TelegramChannel implements AlertChannel {
  private readonly url: string;
  private readonly chatId: string;

  constructor(botToken: string, chatId: string) {
    this.url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    this.chatId = chatId;
  }

  async send(message: string): Promise<void> {
    await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: message, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}

export class DiscordChannel implements AlertChannel {
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async send(message: string): Promise<void> {
    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
      signal: AbortSignal.timeout(10_000),
    });
  }
}

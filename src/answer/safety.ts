// output filter: masks personal data in answers before they reach the user.
// the knowledge base contains none of these, so anything matching came from
// the customer's own message (or an injection) and should not be echoed back.
// defence in depth: the prompt never asks for them, and this guarantees it.

import { settings } from "../config.js";

const CARD = /(?:\d[ -]?){12,18}\d/g; // 13 to 19 digits, optional spaces or dashes
const PHONE = /(?:\+\d{1,3}[ -]?)?(?:\(?0\d{2,4}\)?[ -]?)\d{3,4}[ -]?\d{3,4}\b/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function redactAnswer(text: string): string {
  return text
    .replace(CARD, "[card number removed]")
    .replace(PHONE, "[phone number removed]")
    .replace(EMAIL, (m) => (m.toLowerCase() === settings.supportEmail ? m : "[email removed]"));
}

// streaming version: holds back a trailing run of digits (and spaces, dashes,
// brackets or a leading +) until it is complete, so a card or phone number
// is never shown even partially before being masked
export class StreamRedactor {
  private pending = "";

  push(delta: string): string {
    const s = this.pending + delta;
    const tail = s.match(/\+?\d[\d \-()]*$/);
    if (tail) {
      this.pending = tail[0];
      return redactAnswer(s.slice(0, s.length - tail[0].length));
    }
    this.pending = "";
    return redactAnswer(s);
  }

  flush(): string {
    const s = redactAnswer(this.pending);
    this.pending = "";
    return s;
  }
}

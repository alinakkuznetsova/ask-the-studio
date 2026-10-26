// masks personal data before anything is logged or stored.
// customers often paste emails, phone numbers and order numbers into chat.

const RULES: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  // card-like digit runs (13 to 19 digits, optional spaces or dashes)
  [/\b(?:\d[ -]?){13,19}\b/g, "[card]"],
  // uk and international phone numbers
  [/(?:\+|\b00)\d[\d\s-]{7,}\d\b/g, "[phone]"],
  [/\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, "[phone]"],
  // order numbers such as #10234 or "order 10234"
  [/#\d{4,}\b/g, "[order]"],
  [/\b(order(?:\s+(?:no\.?|number))?\s*:?\s*)\d{4,}\b/gi, "$1[order]"],
  // uk postcodes
  [/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi, "[postcode]"],
];

export function redact(s: string): string {
  return RULES.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}

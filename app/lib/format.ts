/**
 * Shared money formatting — shows amounts in the ad account's own currency
 * instead of a hardcoded "$". Client-safe (no node imports).
 */

const SYMBOLS: Record<string, string> = {
  USD: "$",
  BDT: "৳",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  PKR: "₨",
  CAD: "CA$",
  AUD: "A$",
  NZD: "NZ$",
  SGD: "S$",
  MYR: "RM",
  IDR: "Rp",
  PHP: "₱",
  THB: "฿",
  VND: "₫",
  JPY: "¥",
  CNY: "¥",
  KRW: "₩",
  AED: "د.إ",
  SAR: "﷼",
  QAR: "QR",
  KWD: "KD",
  TRY: "₺",
  BRL: "R$",
  MXN: "MX$",
  ZAR: "R",
  NGN: "₦",
  KES: "KSh",
  EGP: "E£",
};

export function currencySymbol(code: string | null | undefined): string {
  const c = (code ?? "USD").toUpperCase();
  return SYMBOLS[c] ?? `${c} `;
}

/** "৳1,250.00" / "$10.00" — 2 decimals, thousands separators. */
export function formatMoney(amount: number | null | undefined, currency?: string | null): string {
  if (amount == null || Number.isNaN(amount)) return "—";
  const formatted = Number(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currencySymbol(currency)}${formatted}`;
}

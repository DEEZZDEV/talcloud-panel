/** Texte d'affichage sur une ligne : caractères de contrôle et de direction retirés, espaces regroupés, longueur bornée. */
export function oneLine(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const plain = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Montant au format français : « 12,00 € » (espace insécable U+00A0 comme séparateur de milliers et avant la devise). */
export function formatAmount(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  let text: string | null = null;
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      text = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: code }).format(amount);
    } catch {
      text = null;
    }
  }
  text ??= `${plain.format(amount)} ${oneLine(code, 8)}`;
  return text.replace(/[\u202f\u00a0 ]/g, '\u00a0');
}

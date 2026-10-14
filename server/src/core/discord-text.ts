/**
 * Partagé par les notifications et les alertes de sécurité.
 *
 * Rend un texte NON FIABLE (nom de client, de produit…) inoffensif dans un message Discord :
 *  - caractères de contrôle, de direction d'écriture et sauts de ligne retirés ;
 *  - toute la ponctuation Markdown échappée (pas de gras, de lien masqué, de bloc de code, de titre, de citation) ;
 *  - « @ » et « :// » coupés par un espace de largeur nulle (ni mention, ni lien cliquable) ;
 *  - longueur bornée APRÈS échappement, sans laisser d'antislash orphelin.
 * Les mentions sont de toute façon neutralisées par `allowed_mentions: { parse: [] }`.
 */
export function discordText(value: unknown, max: number): string {
  let text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  // Borne d'entrée : évite tout travail inutile sur une chaîne démesurée.
  text = text.slice(0, max);
  text = text
    .replace(/[\\*_~`|>#\-[\]()<:@]/g, (char) => `\\${char}`)
    .replace(/\\@/g, '\\@\u200b')
    .replace(/\\:\/\//g, '\\:\u200b//');
  if (text.length > max) {
    text = text.slice(0, max - 1);
    const trailing = /\\+$/.exec(text)?.[0].length ?? 0;
    if (trailing % 2 === 1) text = text.slice(0, -1);
    text = `${text}…`;
  }
  return text;
}

import Bowser from 'bowser';

/** Libellé lisible d'un navigateur, ex. « Chrome 129 · Windows ». Ne sert qu'à l'affichage. */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Appareil inconnu';
  try {
    const parser = Bowser.getParser(userAgent.slice(0, 512));
    const browser = parser.getBrowserName();
    const major = parser.getBrowserVersion()?.split('.')[0];
    const os = parser.getOSName();
    const left = browser ? (major ? `${browser} ${major}` : browser) : '';
    const label = [left, os].filter(Boolean).join(' · ');
    return (label || 'Appareil inconnu').slice(0, 80);
  } catch {
    return 'Appareil inconnu';
  }
}

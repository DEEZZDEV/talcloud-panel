import DOMPurify from 'dompurify';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/**
 * Affichage du HTML d'un mail. Le serveur l'a déjà assaini ; on applique malgré tout :
 *  1. un second passage DOMPurify (instance dédiée, liste restrictive) ;
 *  2. une iframe `sandbox` SANS `allow-scripts` ni `allow-same-origin` : aucun script, origine opaque,
 *     aucun accès aux cookies ni au DOM du panel (`allow-popups` sert uniquement à ouvrir les liens dans un nouvel onglet) ;
 *  3. une CSP dans le document : aucune ressource réseau, images `data:` seulement, styles en ligne.
 */

const purifier = DOMPurify(window);

purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof Element && node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

function sanitize(html: string): string {
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'video', 'audio', 'source', 'track', 'noscript', 'template', 'dialog'],
    FORBID_ATTR: ['srcset', 'action', 'formaction', 'ping', 'background', 'poster', 'autofocus', 'contenteditable'],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // Liens : http(s), mailto, tel et ancres. Les images `data:` restent permises par la règle interne de DOMPurify (balise <img> seulement).
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
  });
}

const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const FRAME_STYLE = `
  html { color-scheme: light; }
  body { margin: 0; padding: 20px; background: #ffffff; color: #18181b; font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  img:not([src]) { display: inline-block; min-width: 28px; min-height: 28px; border: 1px dashed #c4c4cc; border-radius: 6px; background: #f4f4f5; vertical-align: middle; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  blockquote { margin: 0 0 0 4px; padding-left: 12px; border-left: 3px solid #d4d4d8; color: #52525b; }
  a { color: #1d4ed8; }
`;

function buildDocument(html: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${FRAME_STYLE}</style></head><body>${sanitize(html)}</body></html>`;
}

export function MessageFrame({ html, title, className }: { html: string; title: string; className?: string }) {
  const srcDoc = useMemo(() => buildDocument(html), [html]);
  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      loading="lazy"
      className={cn('block w-full rounded-lg border bg-white', className)}
    />
  );
}

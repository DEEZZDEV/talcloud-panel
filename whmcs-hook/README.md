# Hook WHMCS — notifications TalCloud Panel

`talcloud_notify.php` prévient le panel à chaque **nouvelle commande** (`AfterShoppingCartCheckout`) et à chaque
**facture payée** (`InvoicePaid`). Compatible WHMCS 8.x, PHP 7.4+ (extension cURL requise).

## Installation

1. **Côté panel** — dans le `.env`, définir un secret d'au moins 32 caractères, puis redémarrer le panel :

   ```
   WHMCS_HOOK_SECRET=<résultat de : openssl rand -hex 32>
   # Recommandé : IP (ou CIDR) du serveur WHMCS, séparées par des virgules.
   WHMCS_HOOK_IPS=203.0.113.10
   ```

   Sans `WHMCS_HOOK_SECRET`, la route `/api/webhooks/whmcs` répond 404 (fonction désactivée).

2. **Côté WHMCS** — copier `talcloud_notify.php` dans `<racine WHMCS>/includes/hooks/`.

3. **Configuration du hook** — de préférence dans un fichier séparé, **hors de la racine web**, lisible seulement
   par l'utilisateur PHP (`chmod 600`), par exemple `/home/whmcs/talcloud_notify.config.php` :

   ```php
   <?php
   return array(
       'url'    => 'https://panel.exemple.com',   // PUBLIC_URL du panel, en https, sans chemin
       'secret' => 'la-même-valeur-que-WHMCS_HOOK_SECRET',
   );
   ```

   puis indiquer son chemin dans `'config_file'` en tête de `talcloud_notify.php` (ou dans la variable
   d'environnement `TALCLOUD_HOOK_CONFIG`). À défaut, `'url'` et `'secret'` peuvent être renseignés directement en
   tête du fichier, ou fournis par les variables `TALCLOUD_PANEL_URL` / `TALCLOUD_HOOK_SECRET`.

4. **Dans le panel** — Réglages → Notifications : activer les types voulus, le webhook Discord, et associer à chaque
   identifiant de passerelle WHMCS (`stripe`, `paypal`, `banktransfer`…) le libellé du compte qui encaisse.

5. **Vérification** — passer une commande de test : la notification apparaît dans le panel. En cas de problème,
   consulter le journal d'activité de WHMCS (lignes « TalCloud Panel (hook) »).

## Diagnostic

| Ligne du journal WHMCS | Cause probable |
|---|---|
| `le panel a répondu HTTP 401` | Secret différent, IP du serveur WHMCS absente de `WHMCS_HOOK_IPS`, ou horloge décalée de plus de 5 minutes (NTP). |
| `le panel a répondu HTTP 404` | `WHMCS_HOOK_SECRET` non défini côté panel (ou panel non redémarré). |
| `le panel a répondu HTTP 403` | Le panel est appelé par une autre URL que son `PUBLIC_URL`. |
| `le panel a répondu HTTP 400` | Versions du hook et du panel incompatibles. |
| `panel injoignable (cURL 60)` | Certificat TLS du panel non reconnu par le serveur WHMCS. |
| `panel injoignable (cURL 28 / 7)` | Délai dépassé ou connexion refusée (pare-feu, panel arrêté). |

## Sécurité et comportement

- Chaque message est signé : `X-TalCloud-Signature: sha256=HMAC-SHA256(secret, "<horodatage>.<corps>")` avec
  `X-TalCloud-Timestamp`. Le panel refuse toute signature invalide, tout horodatage écarté de plus de 5 minutes et
  tout évènement déjà reçu (`eventId` : `order_created:<n° de commande>`, `invoice_paid:<n° de facture>`).
- HTTPS obligatoire, certificat et nom d'hôte vérifiés, aucune redirection suivie.
- Le hook ne fait jamais échouer une commande ou un paiement : toute erreur est capturée et journalisée. L'appel au
  panel est borné à 4 secondes (2 secondes pour la connexion). Si le panel est injoignable, la notification est
  perdue (pas de nouvelle tentative) ; la commande, elle, reste visible dans WHMCS et dans la page Commandes du panel.
- Le secret n'est jamais écrit dans le journal.

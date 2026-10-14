<?php
/**
 * TalCloud Panel — notifications de commandes et de paiements.
 *
 * Installation : copier ce fichier dans <racine WHMCS>/includes/hooks/ puis renseigner la configuration
 * ci-dessous (ou, mieux, dans un fichier séparé placé HORS de la racine web — voir README.md).
 *
 * À chaque nouvelle commande (AfterShoppingCartCheckout) et à chaque facture payée (InvoicePaid), le hook
 * envoie au panel un message JSON signé (HMAC-SHA256) sur POST <URL du panel>/api/webhooks/whmcs.
 *
 * Garanties : ce hook ne fait jamais échouer une commande ou un paiement (toute erreur est capturée et
 * inscrite au journal d'activité de WHMCS) et n'attend jamais le panel plus de quelques secondes.
 *
 * Compatible WHMCS 8.x, PHP 7.4 et suivants.
 */

use WHMCS\Database\Capsule;

if (!defined('WHMCS')) {
    die('Accès direct interdit.');
}

if (!function_exists('talcloud_notify_config')) {

    /**
     * ─────────────────────────────── CONFIGURATION ───────────────────────────────
     */
    function talcloud_notify_config()
    {
        static $config = null;
        if ($config !== null) {
            return $config;
        }

        $config = array(
            // URL publique du panel (valeur de PUBLIC_URL), en https, sans chemin. Ex. : https://panel.exemple.com
            'url' => '',
            // Secret partagé : valeur EXACTE de WHMCS_HOOK_SECRET dans le .env du panel (32 caractères minimum).
            'secret' => '',
            // Délai maximal total de l'appel au panel, en secondes (3 à 5 conseillé).
            'timeout' => 4,
            // Fichier de configuration séparé, hors de la racine web (recommandé pour ne pas laisser le secret ici).
            // Il doit contenir : <?php return array('url' => 'https://…', 'secret' => '…');
            // Laisser vide pour ne pas l'utiliser. S'il existe, ses valeurs remplacent celles ci-dessus.
            'config_file' => '',
        );

        // Variables d'environnement (facultatif) : TALCLOUD_PANEL_URL, TALCLOUD_HOOK_SECRET, TALCLOUD_HOOK_CONFIG.
        foreach (array('url' => 'TALCLOUD_PANEL_URL', 'secret' => 'TALCLOUD_HOOK_SECRET', 'config_file' => 'TALCLOUD_HOOK_CONFIG') as $key => $env) {
            $value = getenv($env);
            if (is_string($value) && $value !== '') {
                $config[$key] = $value;
            }
        }

        $file = (string) $config['config_file'];
        if ($file !== '' && is_file($file) && is_readable($file)) {
            $loaded = include $file;
            if (is_array($loaded)) {
                foreach (array('url', 'secret', 'timeout') as $key) {
                    if (isset($loaded[$key]) && $loaded[$key] !== '') {
                        $config[$key] = $loaded[$key];
                    }
                }
            }
        }

        return $config;
    }

    /** Inscrit une ligne au journal d'activité de WHMCS. Ne contient jamais le secret ni le corps du message. */
    function talcloud_notify_log($message)
    {
        try {
            if (function_exists('logActivity')) {
                logActivity('TalCloud Panel (hook) : ' . talcloud_notify_text($message, 300));
            }
        } catch (\Throwable $e) {
            // Rien : la journalisation ne doit jamais interrompre WHMCS.
        }
    }

    /** Texte sur une ligne, sans caractères de contrôle, tronqué à $max caractères. */
    function talcloud_notify_text($value, $max)
    {
        $text = is_scalar($value) ? (string) $value : '';
        $first = preg_split('/\R/u', trim($text));
        if (is_array($first) && isset($first[0])) {
            $text = $first[0];
        }
        $clean = preg_replace('/[\x00-\x1F\x7F]+/', ' ', $text);
        $text = trim(is_string($clean) ? $clean : $text);
        if (function_exists('mb_substr')) {
            return (string) mb_substr($text, 0, $max, 'UTF-8');
        }
        return (string) substr($text, 0, $max);
    }

    /** Client : identifiant, nom affichable, e-mail, code devise. */
    function talcloud_notify_client($clientId)
    {
        $result = array('id' => (int) $clientId, 'name' => 'Client n° ' . (int) $clientId, 'email' => '', 'currency' => '');
        if ($clientId <= 0) {
            $result['name'] = 'Client inconnu';
            return $result;
        }
        $client = Capsule::table('tblclients')->where('id', (int) $clientId)->first();
        if (!$client) {
            return $result;
        }
        $name = trim((string) $client->firstname . ' ' . (string) $client->lastname);
        $company = trim((string) $client->companyname);
        if ($name === '' && $company !== '') {
            $name = $company;
        } elseif ($name !== '' && $company !== '') {
            $name .= ' (' . $company . ')';
        }
        if ($name !== '') {
            $result['name'] = $name;
        }
        $result['email'] = (string) $client->email;

        $currency = null;
        if (!empty($client->currency)) {
            $currency = Capsule::table('tblcurrencies')->where('id', (int) $client->currency)->first();
        }
        if (!$currency) {
            $currency = Capsule::table('tblcurrencies')->where('default', 1)->first();
        }
        if ($currency && isset($currency->code)) {
            $result['currency'] = (string) $currency->code;
        }
        return $result;
    }

    /** Nom lisible d'une passerelle de paiement (réglage « name » du module), ou chaîne vide. */
    function talcloud_notify_gateway_name($gateway)
    {
        if ($gateway === '') {
            return '';
        }
        $row = Capsule::table('tblpaymentgateways')->where('gateway', $gateway)->where('setting', 'name')->first();
        return $row && isset($row->value) ? (string) $row->value : '';
    }

    /** Libellés des lignes d'une facture. */
    function talcloud_notify_invoice_products($invoiceId)
    {
        $products = array();
        if ($invoiceId <= 0) {
            return $products;
        }
        $items = Capsule::table('tblinvoiceitems')->where('invoiceid', (int) $invoiceId)->orderBy('id', 'asc')->limit(20)->get();
        foreach ($items as $item) {
            $label = talcloud_notify_text($item->description, 150);
            if ($label !== '') {
                $products[] = $label;
            }
        }
        return $products;
    }

    /** Produits, options et domaines d'une commande. */
    function talcloud_notify_order_products($orderId, $invoiceId)
    {
        $products = array();

        $services = Capsule::table('tblhosting')
            ->leftJoin('tblproducts', 'tblproducts.id', '=', 'tblhosting.packageid')
            ->where('tblhosting.orderid', (int) $orderId)
            ->limit(20)
            ->get(array('tblproducts.name as name', 'tblhosting.domain as domain'));
        foreach ($services as $service) {
            $label = talcloud_notify_text($service->name, 120);
            if ($label !== '') {
                $products[] = $label;
            }
        }

        $addons = Capsule::table('tblhostingaddons')
            ->leftJoin('tbladdons', 'tbladdons.id', '=', 'tblhostingaddons.addonid')
            ->where('tblhostingaddons.orderid', (int) $orderId)
            ->limit(20)
            ->get(array('tbladdons.name as addon_name', 'tblhostingaddons.name as custom_name'));
        foreach ($addons as $addon) {
            $label = talcloud_notify_text($addon->custom_name !== null && $addon->custom_name !== '' ? $addon->custom_name : $addon->addon_name, 120);
            if ($label !== '') {
                $products[] = $label;
            }
        }

        $domains = Capsule::table('tbldomains')->where('orderid', (int) $orderId)->limit(20)->get(array('domain'));
        foreach ($domains as $domain) {
            $label = talcloud_notify_text($domain->domain, 120);
            if ($label !== '') {
                $products[] = 'Domaine ' . $label;
            }
        }

        // Commande sans service direct (changement d'offre, renouvellement…) : lignes de la facture.
        if (count($products) === 0) {
            $products = talcloud_notify_invoice_products($invoiceId);
        }
        return array_slice($products, 0, 20);
    }

    /** Signe et envoie un évènement au panel. Ne lève jamais d'exception. */
    function talcloud_notify_send(array $payload)
    {
        try {
            $config = talcloud_notify_config();
            $url = rtrim(trim((string) $config['url']), '/');
            $secret = (string) $config['secret'];
            if ($url === '' || $secret === '') {
                return; // Hook non configuré : silencieux.
            }
            if (stripos($url, 'https://') !== 0) {
                talcloud_notify_log('URL du panel refusée : https:// obligatoire.');
                return;
            }
            if (!function_exists('curl_init')) {
                talcloud_notify_log('extension PHP cURL absente, évènement non envoyé.');
                return;
            }

            // Les champs vides sont omis (le panel refuse toute chaîne vide et tout champ inconnu).
            foreach ($payload as $key => $value) {
                if ($value === null || $value === '' || (is_int($value) && $value <= 0 && $key !== 'amount')) {
                    unset($payload[$key]);
                }
            }

            if (!isset($payload['clientName'])) {
                $payload['clientName'] = 'Client inconnu';
            }
            if (!isset($payload['products']) || !is_array($payload['products'])) {
                $payload['products'] = array();
            }
            $payload['amount'] = isset($payload['amount']) ? max(0.0, (float) $payload['amount']) : 0.0;

            $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
            if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
                $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
            }
            $body = json_encode($payload, $flags);
            if (!is_string($body)) {
                talcloud_notify_log('évènement ' . $payload['eventId'] . ' non encodable en JSON.');
                return;
            }

            // Signature : HMAC-SHA256(secret, "<horodatage>.<corps brut>"), sur les octets exacts envoyés.
            $timestamp = (string) time();
            $signature = hash_hmac('sha256', $timestamp . '.' . $body, $secret);

            $timeout = (int) $config['timeout'];
            if ($timeout < 1 || $timeout > 10) {
                $timeout = 4;
            }

            $ch = curl_init($url . '/api/webhooks/whmcs');
            if ($ch === false) {
                talcloud_notify_log('initialisation cURL impossible.');
                return;
            }
            $options = array(
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_HTTPHEADER => array(
                    'Content-Type: application/json',
                    'X-TalCloud-Timestamp: ' . $timestamp,
                    'X-TalCloud-Signature: sha256=' . $signature,
                    'Expect:',
                ),
                CURLOPT_USERAGENT => 'TalCloud-WHMCS-Hook/1.0',
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HEADER => false,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_CONNECTTIMEOUT => min(2, $timeout),
                CURLOPT_TIMEOUT => $timeout,
                CURLOPT_NOSIGNAL => true,
                // Vérification TLS complète : certificat et nom d'hôte.
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
            );
            if (defined('CURLOPT_PROTOCOLS') && defined('CURLPROTO_HTTPS')) {
                $options[CURLOPT_PROTOCOLS] = CURLPROTO_HTTPS;
            }
            curl_setopt_array($ch, $options);

            $response = curl_exec($ch);
            $errno = curl_errno($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);

            if ($response === false || $errno !== 0) {
                talcloud_notify_log('panel injoignable pour ' . $payload['eventId'] . ' (cURL ' . $errno . ').');
                return;
            }
            if ($status < 200 || $status >= 300) {
                talcloud_notify_log('le panel a répondu HTTP ' . $status . ' pour ' . $payload['eventId'] . '.');
            }
        } catch (\Throwable $e) {
            talcloud_notify_log('erreur d’envoi (' . get_class($e) . ').');
        }
    }

    /** Nouvelle commande passée depuis le panier. */
    function talcloud_notify_order_created($vars)
    {
        $orderId = isset($vars['OrderID']) ? (int) $vars['OrderID'] : 0;
        if ($orderId <= 0) {
            return;
        }
        $order = Capsule::table('tblorders')->where('id', $orderId)->first();
        if (!$order) {
            return;
        }
        $invoiceId = (int) $order->invoiceid;
        if ($invoiceId <= 0 && isset($vars['InvoiceID'])) {
            $invoiceId = (int) $vars['InvoiceID'];
        }
        $client = talcloud_notify_client((int) $order->userid);
        $gateway = (string) $order->paymentmethod;
        if ($gateway === '' && isset($vars['PaymentMethod'])) {
            $gateway = (string) $vars['PaymentMethod'];
        }

        talcloud_notify_send(array(
            'eventId' => 'order_created:' . $orderId,
            'event' => 'order_created',
            'orderId' => $orderId,
            'invoiceId' => $invoiceId,
            'clientId' => (int) $client['id'],
            'clientName' => talcloud_notify_text($client['name'], 150),
            'clientEmail' => talcloud_notify_text($client['email'], 200),
            'products' => talcloud_notify_order_products($orderId, $invoiceId),
            'amount' => round((float) $order->amount, 2),
            'currency' => talcloud_notify_text($client['currency'] !== '' ? $client['currency'] : 'EUR', 8),
            'gateway' => talcloud_notify_text($gateway, 60),
            'gatewayName' => talcloud_notify_text(talcloud_notify_gateway_name($gateway), 100),
        ));
    }

    /** Facture payée. */
    function talcloud_notify_invoice_paid($vars)
    {
        $invoiceId = isset($vars['invoiceid']) ? (int) $vars['invoiceid'] : 0;
        if ($invoiceId <= 0) {
            return;
        }
        $invoice = Capsule::table('tblinvoices')->where('id', $invoiceId)->first();
        if (!$invoice) {
            return;
        }
        $client = talcloud_notify_client((int) $invoice->userid);

        // Dernière transaction de la facture : c'est elle qui indique la passerelle ayant réellement encaissé.
        $transaction = Capsule::table('tblaccounts')->where('invoiceid', $invoiceId)->orderBy('id', 'desc')->first();
        $gateway = $transaction && (string) $transaction->gateway !== '' ? (string) $transaction->gateway : (string) $invoice->paymentmethod;
        $transactionId = $transaction ? (string) $transaction->transid : '';

        $order = Capsule::table('tblorders')->where('invoiceid', $invoiceId)->orderBy('id', 'asc')->first();

        talcloud_notify_send(array(
            'eventId' => 'invoice_paid:' . $invoiceId,
            'event' => 'invoice_paid',
            'orderId' => $order ? (int) $order->id : 0,
            'invoiceId' => $invoiceId,
            'clientId' => (int) $client['id'],
            'clientName' => talcloud_notify_text($client['name'], 150),
            'clientEmail' => talcloud_notify_text($client['email'], 200),
            'products' => talcloud_notify_invoice_products($invoiceId),
            'amount' => round((float) $invoice->total, 2),
            'currency' => talcloud_notify_text($client['currency'] !== '' ? $client['currency'] : 'EUR', 8),
            'gateway' => talcloud_notify_text($gateway, 60),
            'gatewayName' => talcloud_notify_text(talcloud_notify_gateway_name($gateway), 100),
            'transactionId' => talcloud_notify_text($transactionId, 120),
        ));
    }
}

// Priorité élevée (exécution tardive) : les autres hooks passent d'abord. Tout est capturé : jamais d'erreur
// propagée à WHMCS, donc jamais de commande ni de paiement interrompu par ce fichier.
add_hook('AfterShoppingCartCheckout', 99, function ($vars) {
    try {
        talcloud_notify_order_created(is_array($vars) ? $vars : array());
    } catch (\Throwable $e) {
        talcloud_notify_log('erreur sur AfterShoppingCartCheckout (' . get_class($e) . ').');
    }
});

add_hook('InvoicePaid', 99, function ($vars) {
    try {
        talcloud_notify_invoice_paid(is_array($vars) ? $vars : array());
    } catch (\Throwable $e) {
        talcloud_notify_log('erreur sur InvoicePaid (' . get_class($e) . ').');
    }
});

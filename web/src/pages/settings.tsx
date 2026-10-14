import { Bell, Boxes, Building2, Gamepad2, Mail, Receipt, UserRound, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Page, PageHeader } from '@/components/shared/page';
import { MySpaceSection } from '@/features/preferences/my-space';
import { IntegrationSection, type SettingsField } from '@/features/settings/integration-section';
import { MailAccountsSection } from '@/features/settings/mail-accounts';
import { GatewayAccountsEditor, PushSettings } from '@/features/settings/notification-extras';
import { cn } from '@/lib/utils';

// Définitions de champs stables (constantes de module) : chaque intégration a ses valeurs et ses secrets.

const WHMCS_FIELDS: SettingsField[] = [
  { name: 'url', label: 'URL de WHMCS', kind: 'url', placeholder: 'https://client.exemple.com', help: "Adresse de l'espace client, sans /includes/api.php." },
  { name: 'identifier', label: 'Identifiant API', kind: 'secret', help: 'Champ « Identifier » des identifiants API.' },
  { name: 'secret', label: 'Secret API', kind: 'secret', help: "Affiché une seule fois par WHMCS à la création." },
  { name: 'accessKey', label: "Clé d'accès", kind: 'secret', optional: true, help: "Seulement si $api_access_key est défini dans configuration.php." },
];

const PTERODACTYL_FIELDS: SettingsField[] = [
  { name: 'url', label: 'URL du panel Pterodactyl', kind: 'url', placeholder: 'https://panel.exemple.com' },
  { name: 'applicationKey', label: 'Clé Application', kind: 'secret', placeholder: 'ptla_…', help: 'Commence par ptla_ : liste des serveurs, suspension.' },
  { name: 'clientKey', label: 'Clé Client (compte administrateur)', kind: 'secret', placeholder: 'ptlc_…', help: 'Commence par ptlc_ : état, ressources et alimentation.' },
];

const PROXMOX_FIELDS: SettingsField[] = [
  { name: 'url', label: "URL de l'API Proxmox", kind: 'url', placeholder: 'https://pve.exemple.com:8006' },
  { name: 'tokenId', label: 'Identifiant du jeton', kind: 'text', placeholder: 'panel@pve!talcloud', help: 'Format utilisateur@royaume!nom.' },
  { name: 'tokenSecret', label: 'Secret du jeton', kind: 'secret', help: 'UUID affiché une seule fois à la création du jeton.' },
  { name: 'verifyTls', label: 'Vérifier le certificat TLS', kind: 'switch', defaultValue: true, help: "À laisser activé. Avec un certificat auto-signé, collez plutôt l'autorité de certification ci-dessous." },
  { name: 'caCert', label: 'Certificat CA (PEM)', kind: 'textarea', optional: true, placeholder: '-----BEGIN CERTIFICATE-----', help: 'Pour un certificat auto-signé : contenu de /etc/pve/pve-root-ca.pem.' },
];

const NOTIFICATION_FIELDS: SettingsField[] = [
  { name: 'discordEnabled', label: 'Envoyer les notifications sur Discord', kind: 'switch', defaultValue: false, help: 'Chaque commande et paiement est aussi publié dans le salon du webhook.' },
  { name: 'discordWebhookUrl', label: 'URL du webhook Discord', kind: 'secret', placeholder: 'https://discord.com/api/webhooks/…', help: 'Salon › Modifier › Intégrations › Webhooks.' },
  { name: 'notifyOrders', label: 'Notifier les nouvelles commandes', kind: 'switch', defaultValue: true },
  { name: 'notifyPayments', label: 'Notifier les paiements reçus', kind: 'switch', defaultValue: true },
];

const URL_ONLY = ['url'] as const;
const PROXMOX_REKEY = ['url', 'verifyTls', 'caCert'] as const;

const NAV_GROUPS: { label: string; sections: { id: string; label: string; icon: LucideIcon }[] }[] = [
  { label: 'Mon compte', sections: [{ id: 'mon-espace', label: 'Mon espace', icon: UserRound }] },
  {
    label: 'Intégrations communes',
    sections: [
      { id: 'whmcs', label: 'WHMCS', icon: Receipt },
      { id: 'pterodactyl', label: 'Pterodactyl', icon: Gamepad2 },
      { id: 'proxmox', label: 'Proxmox', icon: Boxes },
      { id: 'notifications', label: 'Notifications', icon: Bell },
      { id: 'mail', label: 'Comptes mail', icon: Mail },
    ],
  },
];

export default function SettingsPage() {
  const location = useLocation();
  const active = location.hash.replace('#', '');

  // Arrivée par un lien « Configurer » (#whmcs, #mail…) : défilement jusqu'à la section.
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => document.getElementById(active)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    return () => window.clearTimeout(timer);
  }, [active]);

  return (
    <Page>
      <PageHeader title="Réglages" description="Vos préférences personnelles, puis les connexions communes aux services de l'hébergeur (secrets chiffrés, jamais renvoyés au navigateur)." />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Sections des réglages" className="-mx-4 overflow-x-auto px-4 xl:sticky xl:top-20 xl:mx-0 xl:px-0">
          <ul className="flex gap-1 xl:flex-col">
            {NAV_GROUPS.map((group, groupIndex) => [
              <li key={group.label} className={cn('hidden px-3 pb-1 text-2xs font-medium uppercase tracking-[0.1em] text-subtle xl:block', groupIndex > 0 && 'pt-4')} aria-hidden>
                {group.label}
              </li>,
              ...group.sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={cn(
                    'flex h-10 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors xl:h-9',
                    active === section.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <section.icon className="size-4" aria-hidden />
                  {section.label}
                </a>
              </li>
              )),
            ])}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-5">
          <MySpaceSection />

          <div className="flex flex-col gap-1 border-t pt-6">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              <Building2 className="size-4 text-subtle" aria-hidden />
              Intégrations communes
            </h2>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Partagées par les deux administrateurs : toute modification s'applique aux deux comptes, demande votre code 2FA et déclenche une alerte de sécurité.
            </p>
          </div>

          <IntegrationSection
            namespace="whmcs"
            icon={Receipt}
            title="WHMCS"
            description="Clients, commandes, factures et statistiques de chiffre d'affaires."
            fields={WHMCS_FIELDS}
            rekeyOn={URL_ONLY}
            help={
              <>
                <ol>
                  <li>
                    Dans l'admin WHMCS : <strong>Configuration (clé) › System Settings › Manage API Credentials</strong>.
                  </li>
                  <li>
                    Onglet <strong>API Roles</strong> : créez un rôle autorisant au minimum <code>GetClients</code>, <code>GetClientsDetails</code>, <code>GetClientsProducts</code>, <code>GetOrders</code>,{' '}
                    <code>GetInvoices</code>, <code>GetTransactions</code> et <code>GetCurrencies</code>.
                  </li>
                  <li>
                    Onglet <strong>API Credentials</strong> : générez des identifiants pour un administrateur avec ce rôle, puis copiez <code>Identifier</code> et <code>Secret</code>.
                  </li>
                  <li>
                    Autorisez l'adresse IP du panel dans <strong>General Settings › Security › API IP Access Restriction</strong> (ou utilisez une clé d'accès).
                  </li>
                </ol>
              </>
            }
          />

          <IntegrationSection
            namespace="pterodactyl"
            icon={Gamepad2}
            title="Pterodactyl"
            description="Serveurs de jeu : état, ressources et actions d'alimentation."
            fields={PTERODACTYL_FIELDS}
            rekeyOn={URL_ONLY}
            help={
              <>
                <p>Deux clés sont nécessaires, car Pterodactyl sépare l'administration et le pilotage des serveurs :</p>
                <ol>
                  <li>
                    <strong>Clé Application</strong> (<code>ptla_…</code>) : zone d'administration › <strong>Application API</strong> › <em>Create New</em>, avec lecture sur Servers, Users et Nodes, et écriture sur
                    Servers (suspension).
                  </li>
                  <li>
                    <strong>Clé Client</strong> (<code>ptlc_…</code>) : connecté avec un compte <strong>administrateur</strong>, avatar en haut à droite › <strong>API Credentials</strong> › <em>Create</em>.
                  </li>
                </ol>
              </>
            }
          />

          <IntegrationSection
            namespace="proxmox"
            icon={Boxes}
            title="Proxmox"
            description="Nodes du cluster, machines virtuelles et conteneurs."
            fields={PROXMOX_FIELDS}
            rekeyOn={PROXMOX_REKEY}
            help={
              <>
                <ol>
                  <li>
                    Dans Proxmox : <strong>Datacenter › Permissions › API Tokens › Add</strong>. Choisissez un utilisateur dédié (ex. <code>panel@pve</code>) et décochez <em>Privilege Separation</em>, ou donnez les
                    droits au jeton lui-même.
                  </li>
                  <li>
                    Copiez le <strong>Token ID</strong> (<code>panel@pve!talcloud</code>) et le <strong>Secret</strong>, affiché une seule fois.
                  </li>
                  <li>
                    Dans <strong>Datacenter › Permissions › Add</strong>, donnez sur <code>/</code> les rôles <code>PVEAuditor</code> (lecture : <code>Sys.Audit</code>, <code>VM.Audit</code>) et <code>PVEVMUser</code> (<code>VM.PowerMgmt</code> : démarrage / arrêt des invités).
                  </li>
                </ol>
              </>
            }
          />

          <IntegrationSection
            namespace="notifications"
            icon={Bell}
            title="Notifications"
            description="Commandes et paiements WHMCS : Discord, compte qui encaisse et notifications push."
            fields={NOTIFICATION_FIELDS}
            testLabel="Envoyer un message d'essai sur Discord"
            extra={({ view, setExtra }) => (
              <GatewayAccountsEditor key={view.updatedAt ?? 'initial'} stored={view.values.gatewayAccounts} onChange={(value) => setExtra('gatewayAccounts', value)} />
            )}
            footer={<PushSettings />}
            help={
              <>
                <p>
                  Les commandes et paiements arrivent par le hook WHMCS fourni avec le panel (<code>whmcs-hook/talcloud_notify.php</code>, à déposer dans <code>includes/hooks/</code> de WHMCS, avec le secret{' '}
                  <code>WHMCS_HOOK_SECRET</code> du fichier <code>.env</code>).
                </p>
                <ol>
                  <li>
                    <strong>Webhook Discord</strong> : dans le salon voulu, <strong>Modifier le salon › Intégrations › Webhooks › Nouveau webhook</strong>, puis « Copier l'URL du webhook ».
                  </li>
                  <li>
                    <strong>Identifiant de passerelle</strong> : nom technique du module de paiement dans WHMCS (<strong>System Settings › Payment Gateways</strong>), par exemple <code>stripe</code> ou{' '}
                    <code>paypalcheckout</code>. Il figure aussi dans le détail d'une notification de paiement.
                  </li>
                </ol>
              </>
            }
          />

          <MailAccountsSection />
        </div>
      </div>
    </Page>
  );
}

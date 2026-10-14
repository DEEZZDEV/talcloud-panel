import { Bell, Boxes, FileText, Gamepad2, LayoutDashboard, Mail, PiggyBank, Settings, ShieldCheck, ShoppingCart, TrendingUp, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Correspondance exacte de l'URL (sinon : préfixe). */
  end?: boolean;
  badge?: 'notifications' | 'mail';
  /** Mots-clés supplémentaires pour la recherche globale. */
  keywords?: string;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Général',
    items: [
      { to: '/', label: 'Accueil', icon: LayoutDashboard, end: true, keywords: 'résumé dashboard tableau de bord' },
      { to: '/notifications', label: 'Notifications', icon: Bell, badge: 'notifications', keywords: 'alertes commandes paiements' },
      { to: '/mail', label: 'Mails', icon: Mail, badge: 'mail', keywords: 'messagerie support boîte de réception email' },
    ],
  },
  {
    label: 'WHMCS',
    items: [
      { to: '/whmcs', label: "Vue d'ensemble", icon: TrendingUp, end: true, keywords: 'whmcs statistiques chiffre affaires bénéfice' },
      { to: '/whmcs/clients', label: 'Clients', icon: Users, keywords: 'whmcs comptes' },
      { to: '/whmcs/orders', label: 'Commandes', icon: ShoppingCart, keywords: 'whmcs achats' },
      { to: '/whmcs/invoices', label: 'Factures', icon: FileText, keywords: 'whmcs impayés paiements' },
      { to: '/whmcs/costs', label: 'Coûts', icon: PiggyBank, keywords: 'whmcs dépenses charges bénéfice' },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { to: '/servers', label: 'Serveurs de jeu', icon: Gamepad2, keywords: 'pterodactyl minecraft' },
      { to: '/proxmox', label: 'Proxmox', icon: Boxes, keywords: 'vm conteneurs nodes virtualisation lxc qemu' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/security', label: 'Sécurité', icon: ShieldCheck, keywords: 'sessions 2fa mot de passe journal appareils ip' },
      { to: '/settings', label: 'Réglages', icon: Settings, keywords: 'intégrations clés api discord push configuration' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

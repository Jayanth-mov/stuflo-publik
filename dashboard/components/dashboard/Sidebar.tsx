'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/components/SessionProvider';
import {
  BarChart2,
  Brain,
  CreditCard,
  ExternalLink,
  FileText,
  Link2,
  LogOut,
  Menu,
  MessageSquare,
  Settings,
  Shield,
  ShieldCheck,
  X,
} from 'lucide-react';
import { ThemeToggleMenuItem } from '@/components/dashboard/ThemeToggle';

const nav = [
  { href: '/dashboard/chat', label: 'Chat', icon: MessageSquare },
  { href: '/dashboard/connections', label: 'Connections', icon: Link2 },
  { href: '/dashboard/memory', label: 'Memory & Storage', icon: Brain },
  { href: '/dashboard/usage', label: 'Usage', icon: BarChart2 },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { data: session, signOut } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const userBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.body.classList.toggle('sf-nav-open', mobileOpen);
    return () => document.body.classList.remove('sf-nav-open');
  }, [mobileOpen]);

  useEffect(() => {
    if (!menuOpen && !mobileOpen) return;

    function onPointer(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setMobileOpen(false);
        if (menuOpen) userBtnRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, mobileOpen]);

  const user = session?.user;
  const email = user?.email || 'Signed in';
  const name = user?.name || user?.email?.split('@')[0] || 'Student';
  const initials = user?.name
    ? user.name.split(' ').map((part: string) => part[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.slice(0, 2).toUpperCase() || 'ST';

  function closeMenus() {
    setMenuOpen(false);
    setMobileOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className="sf-mobile-toggle"
        onClick={() => setMobileOpen((open) => !open)}
        aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={mobileOpen}
        aria-controls="dashboard-sidebar"
      >
        {mobileOpen ? <X size={21} strokeWidth={1.9} /> : <Menu size={22} strokeWidth={1.9} />}
      </button>

      <button
        type="button"
        className={`sf-mobile-backdrop${mobileOpen ? ' is-visible' : ''}`}
        aria-label="Close navigation"
        tabIndex={mobileOpen ? 0 : -1}
        onClick={() => setMobileOpen(false)}
      />

      <aside id="dashboard-sidebar" className={`sf-side${mobileOpen ? ' is-mobile-open' : ''}`}>
        <div className="sf-head">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="sf-logo" src="/stuflo-logo.svg" alt="StuFlo" />
        </div>

        <nav className="sf-nav">
          {[...nav, ...(user?.isAdmin ? [{ href: '/dashboard/admin', label: 'Operations', icon: ShieldCheck }] : [])].map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname?.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={'sf-item' + (active ? ' is-active' : '')}
                onClick={() => setMobileOpen(false)}
              >
                <span className="sf-item-ico">
                  <Icon size={21} strokeWidth={1.85} />
                </span>
                <span className="sf-item-label">{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sf-spacer" />
        <div className="sf-div" />

        <div className="sf-user-wrap" ref={wrapRef}>
          {menuOpen && (
            <div className="sf-menu">
              <div className="sf-menu-head">
                <p className="sf-menu-email">{email}</p>
              </div>

              <Link href="/dashboard/settings" className="sf-menu-item" onClick={closeMenus}>
                <Settings size={16} strokeWidth={1.85} />
                Settings
              </Link>
              <Link href="/dashboard/billing" className="sf-menu-item" onClick={closeMenus}>
                <CreditCard size={16} strokeWidth={1.85} />
                Billing
              </Link>

              <div className="sf-menu-sep" />

              <Link
                href="https://www.stuflo.com/tos"
                className="sf-menu-item"
                target="_blank"
                rel="noreferrer"
                onClick={closeMenus}
              >
                <FileText size={16} strokeWidth={1.85} />
                <span>Terms of Service</span>
                <ExternalLink size={14} strokeWidth={1.85} className="ml-auto" />
              </Link>
              <Link
                href="https://www.stuflo.com/privacy-policy"
                className="sf-menu-item"
                target="_blank"
                rel="noreferrer"
                onClick={closeMenus}
              >
                <Shield size={16} strokeWidth={1.85} />
                <span>Privacy Policy</span>
                <ExternalLink size={14} strokeWidth={1.85} className="ml-auto" />
              </Link>

              <div className="sf-menu-sep" />

              <ThemeToggleMenuItem />
              <button type="button" className="sf-menu-item" onClick={() => void signOut()}>
                <LogOut size={16} strokeWidth={1.85} />
                Log Out
              </button>
            </div>
          )}

          <div className="sf-user-row">
            <button
              ref={userBtnRef}
              className="sf-user"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="true"
              aria-expanded={menuOpen}
              title={name}
            >
              <span className="sf-avatar">{initials}</span>
              <span className="sf-user-meta">
                <span className="sf-user-name">{name}</span>
              </span>
            </button>

            <Link
              href="/dashboard/settings"
              className="sf-user-settings"
              title="Settings"
              aria-label="Settings"
              onClick={closeMenus}
            >
              <Settings size={17} strokeWidth={1.85} />
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}

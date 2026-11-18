'use client';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';

const pageTitles: Record<string, string> = {
  '/dashboard/chat': 'Chat with Stu',
  '/dashboard/connections': 'Connections',
  '/dashboard/usage': 'Usage',
  '/dashboard/billing': 'Billing',
  '/dashboard/settings': 'Settings',
};

function getTitle(pathname: string | null) {
  if (!pathname) return 'Dashboard';
  const match = Object.keys(pageTitles)
    .sort((a, b) => b.length - a.length)
    .find((path) => pathname === path || pathname.startsWith(path + '/'));
  return match ? pageTitles[match] : 'Dashboard';
}

export default function DashboardHeader() {
  const pathname = usePathname();
  const title = useMemo(() => getTitle(pathname), [pathname]);

  return (
    <header className="sf-page-header">
      <h1 className="sf-page-title">{title}</h1>
    </header>
  );
}

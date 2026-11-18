'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

export default function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const active = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finish = useRef(() => {});

  useEffect(() => {
    function complete() {
      if (!active.current) return;
      active.current = false;
      clearInterval(timer.current); clearTimeout(watchdog.current);
      setProgress(100);
      hide.current = setTimeout(() => setVisible(false), 180);
    }
    finish.current = complete;
    function start() {
      clearTimeout(hide.current); clearInterval(timer.current); clearTimeout(watchdog.current);
      active.current = true; setProgress(12); setVisible(true);
      timer.current = setInterval(() => setProgress((current) => current + (92 - current) * 0.12), 220);
      // A cancelled navigation must not leave a permanent bar.
      watchdog.current = setTimeout(complete, 30_000);
    }
    function click(event: MouseEvent) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
      const target = new URL(anchor.href, location.href);
      if (target.origin !== location.origin || !target.pathname.startsWith('/dashboard')) return;
      if (target.pathname === location.pathname && target.search === location.search) return;
      start();
    }
    document.addEventListener('click', click, true);
    window.addEventListener('popstate', start);
    window.addEventListener('pageshow', complete);
    return () => {
      document.removeEventListener('click', click, true);
      window.removeEventListener('popstate', start);
      window.removeEventListener('pageshow', complete);
      clearInterval(timer.current); clearTimeout(hide.current); clearTimeout(watchdog.current);
    };
  }, []);

  useEffect(() => { finish.current(); }, [pathname, search]);

  return <div className="sf-navigation-progress" data-visible={visible} aria-hidden="true">
    <div style={{ transform: `scaleX(${progress / 100})` }} />
  </div>;
}

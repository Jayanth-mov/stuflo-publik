import type { Metadata } from 'next';
import { Crimson_Pro, Inter } from 'next/font/google';
import SessionProvider from '@/components/SessionProvider';
import './design-tokens.css';
import './globals.css';
import './shell.css';

// Self-hosted fonts: Crimson Pro for headings/navigation, Inter for reading and UI.
const crimson = Crimson_Pro({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-crimson',
});

const inter = Inter({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'StuFlo Dashboard',
  description:
    'Connect Canvas, Google Calendar, and your favorite messaging app. Let Stu handle your academic workflow.',
};

// Apply the saved theme before first paint and retire temporary font preferences.
const themeScript = `(function(){try{localStorage.removeItem('stuflo-font-playground-v1');var t=localStorage.getItem('stuflo-theme');var d=document.documentElement;if(t==='dark'){d.setAttribute('data-theme','dark');}else{d.removeAttribute('data-theme');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${crimson.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}

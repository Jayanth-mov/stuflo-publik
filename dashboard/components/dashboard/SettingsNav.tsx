import Link from 'next/link';

type SettingsNavSection = 'general' | 'usage' | 'billing';

const items: Array<{ href: string; label: string; section: SettingsNavSection }> = [
  { href: '/dashboard/settings', label: 'General', section: 'general' },
  { href: '/dashboard/usage', label: 'Usage', section: 'usage' },
  { href: '/dashboard/billing', label: 'Billing', section: 'billing' },
];

export default function SettingsNav({ active }: { active: SettingsNavSection }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => {
        const isActive = item.section === active;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-base font-semibold transition-colors ${
              isActive
                ? 'bg-primary-500 text-white'
                : 'border border-line bg-surface text-fg2 hover:bg-surface-tint hover:text-fg1'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

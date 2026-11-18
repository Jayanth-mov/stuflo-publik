export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import BillingSection from '@/components/dashboard/BillingSection';
import SettingsNav from '@/components/dashboard/SettingsNav';

export default function BillingPage() {
  return (
    <div className="space-y-8">
      <SettingsNav active="billing" />
      <BillingSection />
    </div>
  );
}

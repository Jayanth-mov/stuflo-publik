import SignInForm from '@/components/SignInForm';

export default async function SignInPage({ searchParams }: {
  searchParams: Promise<{ interval?: string; google?: string; trial?: string }>;
}) {
  const params = await searchParams;
  return <SignInForm interval={params.interval || ''} google={params.google || ''} trial={params.trial === '1'} />;
}

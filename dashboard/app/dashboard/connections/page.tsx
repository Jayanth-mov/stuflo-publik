import ConnectionsClient from '@/components/dashboard/ConnectionsClient';

interface ConnectionsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ConnectionsPage({ searchParams }: ConnectionsPageProps) {
  const parameters = await searchParams;
  return (
    <ConnectionsClient
      initialCanvasStatus="not_connected"
      initialCanvasUrl={null}
      initialCanvasUpdatedAt={null}
      initialGoogleStatus="not_connected"
      initialGoogleResult={first(parameters.google) || null}
      initialGoogleReason={first(parameters.reason) || null}
    />
  );
}

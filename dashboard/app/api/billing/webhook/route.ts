export async function POST() {
  return Response.json({ error: 'webhook_moved' }, { status: 410 });
}

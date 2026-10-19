import { connection } from 'next/server';
import { App } from '@/client/App';

/** Rendered per request so Next can apply the CSP nonce from proxy.ts. */
export default async function Page() {
  await connection();
  return <App />;
}

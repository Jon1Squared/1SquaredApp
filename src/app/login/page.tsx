import { redirect } from 'next/navigation';
import { LoginScreen } from '@/components/LoginScreen';
import { getEntraEnvStatus, getEntraSession } from '@/server/entraAuth';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const entraSession = await getEntraSession();
  if (entraSession) {
    redirect('/');
  }
  return <LoginScreen entraEnvStatus={getEntraEnvStatus()} />;
}

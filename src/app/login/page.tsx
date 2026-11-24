import { redirect } from 'next/navigation';
import { LoginScreen } from '@/components/LoginScreen';
import { sanitizeReturnToPath } from '@/domain/authReturnTo';
import { getEntraEnvStatus, getEntraSession } from '@/server/entraAuth';

export const dynamic = 'force-dynamic';

export default async function LoginPage(props?: {
  searchParams?: Promise<{ returnTo?: string | string[] }>;
}) {
  const resolved = props?.searchParams ? await props.searchParams : {};
  const rawReturnTo = Array.isArray(resolved.returnTo)
    ? resolved.returnTo[0]
    : resolved.returnTo;
  const safeReturnTo = sanitizeReturnToPath(rawReturnTo);

  const entraSession = await getEntraSession();
  if (entraSession) {
    redirect(safeReturnTo);
  }
  return (
    <LoginScreen
      entraEnvStatus={getEntraEnvStatus()}
      initialReturnTo={safeReturnTo}
    />
  );
}

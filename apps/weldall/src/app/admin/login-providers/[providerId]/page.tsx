import { LoginProviderDetail } from "../login-provider-detail";

export default async function LoginProviderPage({
  params,
}: {
  params: Promise<{ providerId: string }>;
}) {
  const { providerId } = await params;
  return <LoginProviderDetail providerId={providerId} />;
}

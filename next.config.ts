import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  output: 'standalone',
  serverExternalPackages: [
    '@azure/identity',
    '@azure/keyvault-secrets',
    '@azure/monitor-opentelemetry',
    '@opentelemetry/api',
    'pg',
  ],
};

export default nextConfig;

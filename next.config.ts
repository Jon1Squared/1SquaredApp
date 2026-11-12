import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  output: 'standalone',
  serverExternalPackages: [
    '@azure/monitor-opentelemetry',
    '@opentelemetry/api',
  ],
};

export default nextConfig;

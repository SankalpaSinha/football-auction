import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@fa/shared'],
  reactStrictMode: true,
};

export default config;

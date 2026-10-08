import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@fa/shared'],
  reactStrictMode: true,
  // Let phones/laptops on the local network load dev assets (LAN play-testing).
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.*.*.*', '*.local'],
};

export default config;

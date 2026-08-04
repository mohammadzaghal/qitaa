/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ["@qitaa/domain"],
  experimental: { optimizePackageImports: ["maplibre-gl"], cpus: 1, workerThreads: false },
  eslint: { ignoreDuringBuilds: true },
};

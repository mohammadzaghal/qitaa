/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ["@qitaa/domain"],
  eslint: { ignoreDuringBuilds: true },
};

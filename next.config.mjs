/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },
  // Bundle the committed knowledge index + page renders with the API routes
  // so they're available on Vercel serverless.
  outputFileTracingIncludes: {
    "/api/chat": ["./knowledge/**/*"],
    "/api/page-image": ["./knowledge/**/*"],
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;

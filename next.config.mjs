/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "x-content-type-options", value: "nosniff" },
          { key: "x-frame-options", value: "SAMEORIGIN" },
          { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
          { key: "permissions-policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
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

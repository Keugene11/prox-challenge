/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },
  // The Claude Agent SDK ships a native CLI binary as platform-specific optional
  // packages; mark the SDK external so Next doesn't bundle it (which would
  // strip the optional sibling packages), and explicitly include the linux-x64
  // binary in the function's traced files. Also bundle the knowledge index.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  outputFileTracingIncludes: {
    "/api/chat": [
      "./knowledge/**/*",
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk*/**/*",
      "./node_modules/@anthropic-ai/claude-agent-sdk*/**/*",
    ],
    "/api/page-image": ["./knowledge/**/*"],
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;

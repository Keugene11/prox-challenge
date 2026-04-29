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
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@*/**/*",
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@*/**/*",
      "./node_modules/@anthropic-ai/claude-agent-sdk/**/*",
      "./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/**/*",
    ],
    "/api/page-image": ["./knowledge/**/*"],
  },
  outputFileTracingExcludes: {
    "/api/chat": [
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin*/**",
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-win32*/**",
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-arm64*/**",
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64-musl*/**",
      "./node_modules/@anthropic-ai/claude-agent-sdk-darwin*/**",
      "./node_modules/@anthropic-ai/claude-agent-sdk-win32*/**",
      "./node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64*/**",
      "./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl*/**",
    ],
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;

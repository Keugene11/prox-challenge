import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["DM Sans", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        ink: {
          DEFAULT: "#0A0A0A",
          soft: "#1A1A1A",
          muted: "#666",
          line: "#E5E5E5",
        },
        paper: {
          DEFAULT: "#FAFAFA",
          card: "#FFFFFF",
        },
      },
      boxShadow: {
        card: "0 1px 0 rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.04)",
        "card-lg": "0 1px 0 rgba(0,0,0,0.04), 0 6px 24px -8px rgba(0,0,0,0.08)",
      },
    },
  },
  plugins: [],
} satisfies Config;

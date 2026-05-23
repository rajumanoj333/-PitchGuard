import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0f1115",
        panel: "#181b22",
        line: "#262932",
        accent: "#22d3ee",
        warn: "#f59e0b",
        crit: "#ef4444",
        safe: "#22c55e",
      },
      fontFamily: {
        display: ["var(--font-outfit)", "system-ui", "-apple-system", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontVariantNumeric: {
        tabular: "tabular-nums",
      },
    },
  },
  plugins: [],
} satisfies Config;

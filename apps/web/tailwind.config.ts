import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        sand: { 50: "#faf8f5", 100: "#f2ede4", 300: "#d9cbb3", 700: "#6b5b45" },
        basalt: { 800: "#1c1f26", 900: "#12141a", 950: "#0a0c10" },
        petra: { 400: "#e0855f", 500: "#c96a44", 600: "#a95334" },
      },
      fontFamily: { sans: ["var(--font-ui)", "system-ui", "sans-serif"] },
    },
  },
} satisfies Config;

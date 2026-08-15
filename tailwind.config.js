/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        accent: {
          50: "#eef6ff",
          100: "#d9ecff",
          200: "#bcdfff",
          300: "#8ecbff",
          400: "#59acff",
          500: "#3389fb",
          600: "#1d68f0",
          700: "#1552dd",
          800: "#1843b3",
          900: "#1a3c8d",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,0.06), 0 4px 16px rgba(16,24,40,0.08)",
      },
    },
  },
  plugins: [],
};

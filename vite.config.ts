import { defineConfig } from "vite";

export default defineConfig({
  assetsInclude: ["**/*.glb", "**/*.gltf", "**/*.wasm"],

  server: {
    // Заголовки для SharedArrayBuffer (нужны для Web Workers)
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },

  build: {
    target: "es2022",
    // Разделяем бандл: three.js и ammo.js отдельно
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          ammo: ["ammo.js"],
        },
      },
    },
  },
});

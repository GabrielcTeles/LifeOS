import app from "./app.js";
import path from "path";
import { createServer as createViteServer } from "vite";

const PORT = Number(process.env.PORT || 3000);

async function start() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });

    app.use(vite.middlewares);
  } else {
    const express = await import("express");
    const distPath = path.join(process.cwd(), "dist");

    app.use(express.default.static(distPath));

    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor iniciado na porta ${PORT}`);
  });
}

start().catch((error) => {
  console.error("Erro ao iniciar servidor:", error);
  process.exit(1);
});

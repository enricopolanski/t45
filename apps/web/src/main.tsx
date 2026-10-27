import { RegistryContext } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

import { WebUpdateBanner } from "./components/WebUpdateBanner";
import { router } from "./router";
import { appAtomRegistry } from "./state/atomRegistry";

void router.load().then(() => {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
        <WebUpdateBanner />
      </RegistryContext.Provider>
    </StrictMode>,
  );
});

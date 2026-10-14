// Exercise the production app AND its real navigators. Only device services,
// database bridges and OS-supplied window metrics are browser fixtures.
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../App";

createRoot(document.getElementById("root")!).render(<App />);

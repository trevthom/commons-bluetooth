// The bundle entry. React comes from npm and is compiled into app.js, so the
// app has no CDN and no vendored framework — it starts with no network at all.
import * as React from "react";
import { createRoot } from "react-dom/client";
import "./app.src.jsx";

// public/lucide.js and the QR helper are classic scripts that expect a global
// React, the same way the original Commons build did.
window.React = React;

createRoot(document.getElementById("root")).render(React.createElement(window.CommunityChat));

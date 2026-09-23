import { render } from "preact";

import { App } from "./App.js";
import { AuthGate } from "./components/AuthGate.js";
import "./styles.css";

render(
  <AuthGate>{(logout) => <App onLogout={logout} />}</AuthGate>,
  document.getElementById("app")!,
);

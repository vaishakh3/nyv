import "@fontsource-variable/inter/wght.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import { render } from "preact";
import { App } from "./App.js";
import "./style.css";

render(<App />, document.getElementById("app") as HTMLElement);

import { render } from "preact";
import { App } from "./App.js";
import "./style.css";

render(<App />, document.getElementById("app") as HTMLElement);
